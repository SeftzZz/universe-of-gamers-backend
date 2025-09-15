import { Router, Request, Response } from "express";
import jwt from 'jsonwebtoken';
import Auth from '../models/Auth';
import { ICustodialWallet } from '../models/Auth';
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import { encrypt, decrypt } from '../utils/cryptoHelper';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import bcrypt from 'bcrypt';
import * as crypto from "crypto";
import multer from 'multer';
import path from 'path';

import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import nacl from 'tweetnacl';
import * as ed25519 from 'ed25519-hd-key';

import speakeasy from "speakeasy";
import QRCode from "qrcode";

import rateLimit from "express-rate-limit";

import AuditLog from '../models/AuditLog';

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.resolve(process.cwd(), 'uploads/avatars'));
  },
  filename: (req, file, cb) => {
    const unique = `${req.params.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}.jpg`;
    cb(null, unique);
  }
});
const upload = multer({ storage });

// simpan di luar router
const walletChallenges: Map<string, string> = new Map();

const router = Router();

const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 60 menit
  max: 3,
  message: { error: "Too many attempts, try again later" }
});

const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 menit
  max: 3,
  message: { error: "Too many OTP attempts, try again later" }
});

// Fungsi buat generate JWT
const generateToken = (user: any): string => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET not set in environment variables");
  }

  return jwt.sign(
    { id: user._id, email: user.email, provider: user.authProvider },
    process.env.JWT_SECRET as string, // pastikan string
    { expiresIn: "1d" }
  );
};

// === Register Local + Custodial Wallet ===
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, acceptedTerms } = req.body;

    // ✅ Generate custodial wallet (Solana)
    const mnemonic = generateMnemonic(128); // 12 kata
    const seed = mnemonicToSeedSync(mnemonic);
    const derived = ed25519.derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    const naclKP = nacl.sign.keyPair.fromSeed(derived);
    const kp = Keypair.fromSecretKey(naclKP.secretKey);

    const address = kp.publicKey.toBase58();
    const privateKeyBase58 = bs58.encode(kp.secretKey);

    const custodialWallet: ICustodialWallet = {
      provider: 'solana',
      address,
      privateKey: encrypt(privateKeyBase58),
      mnemonic: encrypt(mnemonic),
    };

    const avatarUrl = `/uploads/avatars/default.png`;

    const auth = new Auth({
      name,
      email,
      password,
      acceptedTerms,
      authProvider: 'custodial',
      wallets: [
        {
          provider: 'other',
          address, // sama dengan custodial
        },
      ],
      custodialWallets: [custodialWallet],
      avatar: avatarUrl,
    });

    await auth.save();
    const token = generateToken(auth);

    res.status(201).json({
      message: 'User registered with custodial + external wallet',
      authId: auth._id,
      token,
      wallets: auth.wallets,
      custodialWallets: auth.custodialWallets.map(w => ({
        provider: w.provider,
        address: w.address,
      })), // ❌ privateKey & mnemonic tetap hidden
    });
  } catch (err: any) {
    console.error("❌ Register error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// === Login Local ===
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const auth = await Auth.findOne({ email });
    if (!auth) return res.status(404).json({ error: 'User not found' });

    const isMatch = await auth.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = generateToken(auth);

    // ✅ ambil wallet tanpa privateKey
    const externalWallets = auth.wallets || [];
    const custodialWallets = (auth.custodialWallets || []).map((w) => ({
      provider: w.provider,
      address: w.address,
    }));

    res.json({
      message: 'Login successful',
      authId: auth._id,
      token,
      wallets: externalWallets,
      custodialWallets, // privateKey tidak dikirim
    });
  } catch (err: any) {
    console.error("❌ Login error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// === Login with Google ===
router.post('/google', async (req, res) => {
  try {
    const { googleId, email, name } = req.body;
    let auth = await Auth.findOne({ googleId });

    const avatarUrl = `/uploads/avatars/default.png`;

    if (!auth) {
      auth = new Auth({ googleId, email, name, authProvider: 'google', avatar: avatarUrl, });
      await auth.save();
    }

    const token = generateToken(auth);
    res.json({ message: 'Login successful', authId: auth._id, token });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// === Challenge endpoint ===
router.get('/wallet/challenge', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Missing address' });

  const nonce = Math.floor(Math.random() * 1e9).toString();
  walletChallenges.set(address as string, nonce);

  res.json({
    message: `Login to UniverseOfGamers with wallet ${address}, nonce=${nonce}`,
    nonce,
  });
});

// === Login / Import External Wallet ===
router.post('/wallet', async (req, res) => {
  try {
    const { provider, address, name, signature, nonce } = req.body;
    if (!address || !signature || !nonce) {
      return res.status(400).json({ error: 'Missing address, signature or nonce' });
    }

    // ✅ Ambil nonce yg tersimpan
    const expectedNonce = walletChallenges.get(address);
    if (!expectedNonce || expectedNonce !== nonce) {
      return res.status(400).json({ error: 'Invalid or expired nonce' });
    }
    walletChallenges.delete(address); // sekali pakai

    // ✅ Verifikasi signature
    const message = `Login to UniverseOfGamers with wallet ${address}, nonce=${nonce}`;
    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      new PublicKey(address).toBytes()
    );
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // === Lanjut login ===
    let auth = await Auth.findOne({ 'wallets.address': address });

    const avatarUrl = `/uploads/avatars/default.png`;

    if (!auth) {
      auth = new Auth({
        name,
        wallets: [{ provider, address }],
        authProvider: 'wallet',
        avatar: avatarUrl,
      });
      await auth.save();
    } else {
      const exists = auth.wallets.find((w) => w.address === address);
      if (!exists) {
        auth.wallets.push({ provider, address });
        await auth.save();
      }
    }

    const token = generateToken(auth);

    const custodialWallets = (auth.custodialWallets || []).map((w) => ({
      provider: w.provider,
      address: w.address,
    }));

    res.json({
      message: 'Login successful',
      authId: auth._id,
      wallets: auth.wallets,
      custodialWallets,
      token,
    });
  } catch (err: any) {
    console.error("❌ Wallet login error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// === Generate Custodial Wallet === 
router.post('/create/custodial', async (req, res) => {
  try {
    const { userId, provider } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const auth = await Auth.findById(userId);
    if (!auth) return res.status(404).json({ error: 'User not found' });

    const selectedProvider = (provider || 'solana') as 'solana' | 'ethereum';

    if (selectedProvider === 'solana') {
      // ✅ Generate custodial wallet (Solana)
      const mnemonic = generateMnemonic(128); // 12 kata
      const seed = mnemonicToSeedSync(mnemonic);
      const derived = ed25519.derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
      const naclKP = nacl.sign.keyPair.fromSeed(derived);
      const kp = Keypair.fromSecretKey(naclKP.secretKey);

      const address = kp.publicKey.toBase58();
      const privateKeyBase58 = bs58.encode(kp.secretKey);

      const custodialWallet: ICustodialWallet = {
        provider: selectedProvider,
        address,
        privateKey: encrypt(privateKeyBase58),
        mnemonic: encrypt(mnemonic),
      };

      auth.custodialWallets.push(custodialWallet);
      auth.authProvider = 'custodial';
      await auth.save();

      const token = generateToken(auth);

      return res.status(201).json({
        success: true,
        message: 'Custodial wallet created',
        authId: auth._id,
        token,
        wallet: { provider: custodialWallet.provider, address: custodialWallet.address },
      });
    }

    return res.status(400).json({ error: 'Unsupported provider' });
  } catch (err: any) {
    console.error("❌ Error create custodial wallet:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Import Recovery Phrase ===
router.post('/import/phrase', async (req, res) => {
  try {
    const { userId, phrase, name } = req.body;
    if (!phrase) {
      return res.status(400).json({ error: 'Missing recovery phrase' });
    }

    // 🔑 generate keypair dari seed phrase
    const seed = mnemonicToSeedSync(phrase);
    const derived = ed25519.derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    const kp = nacl.sign.keyPair.fromSeed(derived);

    const privateKeyBase58 = bs58.encode(Buffer.from(kp.secretKey));
    const address = bs58.encode(Buffer.from(kp.publicKey));
    const displayName = name || address;
    const avatarUrl = `/uploads/avatars/default.png`;

    let auth;

    if (userId) {
      auth = await Auth.findById(userId);
      if (!auth) return res.status(404).json({ error: 'User not found' });
    } else {
      // cek apakah user dengan address ini sudah ada
      auth = await Auth.findOne({
        $or: [
          { name: displayName },
          { 'wallets.address': address },
          { 'custodialWallets.address': address },
        ],
      });

      if (!auth) {
        auth = new Auth({
          name: displayName,
          authProvider: 'custodial',
          custodialWallets: [],
          wallets: [],
          avatar: avatarUrl,
        });
      }
    }

    // cek apakah wallet sudah ada
    const alreadyExists =
      auth.wallets.some((w) => w.address === address) ||
      auth.custodialWallets.some((w) => w.address === address);

    if (!alreadyExists) {
      const wallet: ICustodialWallet = {
        provider: 'solana',
        address,
        privateKey: encrypt(privateKeyBase58),
        mnemonic: encrypt(phrase)
      };
      auth.custodialWallets.push(wallet);
      await auth.save();
    }

    // refresh dari DB
    const freshAuth = await Auth.findById(auth._id);
    if (!freshAuth) return res.status(404).json({ error: 'User not found after save' });

    const token = generateToken(freshAuth);

    res.json({
      success: true,
      message: alreadyExists ? 'Wallet already exists' : 'Recovery phrase imported',
      authId: freshAuth._id,
      wallet: { provider: 'solana', address },
      token,
    });
  } catch (err: any) {
    console.error('❌ Import phrase error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === Forget Password ===
router.post('/forget-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    console.log("📩 [FORGET PASSWORD] Request received");
    console.log("   📧 Email:", email);

    // 🔎 Debug: tampilkan semua email user
    const allUsers = await Auth.find({}, 'email').lean();
    console.log("📜 All registered emails:", allUsers.map(u => u.email));

    if (!email || !newPassword) {
      console.warn("⚠️ Missing email or newPassword in request body");
      return res.status(400).json({ error: 'Missing email or newPassword' });
    }

    const user = await Auth.findOne({ email });
    if (!user) {
      console.warn("❌ User not found for email:", email);
      return res.status(404).json({ error: 'User not found' });
    }

    if (newPassword.length < 8) {
      console.warn("⚠️ Password too short for email:", email);
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // ganti password → auto hash di pre('save')
    user.password = newPassword;
    await user.save();

    console.log("✅ Password reset successfully for email:", email);

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (err: unknown) {
    console.error('❌ Forget password error:', (err as Error).message);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// 🔹 Get user by ID
router.get('/user/:id', async (req, res) => {
  try {
    const user = await Auth.findById(req.params.id).select('-password -custodialWallets.privateKey');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.avatar) {
      user.avatar = '';
    }
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 🔹 Update avatar
router.post('/user/:id/avatar', upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    const user = await Auth.findByIdAndUpdate(
      req.params.id,
      { avatar: avatarUrl },
      { new: true }
    ).select('-password -custodialWallets.privateKey');

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      success: true,
      message: 'Avatar updated',
      avatar: avatarUrl,
      user,
    });
  } catch (err: any) {
    console.error('❌ Avatar update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 🔹 Update profile
router.put('/user/:id/profile', async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await Auth.findByIdAndUpdate(req.params.id, { name, email }, { new: true });
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 🔹 Change password
router.put('/user/:id/password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await Auth.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    if (user.password) {
      // ✅ user sudah punya password → wajib verifikasi
      const isMatch = await user.comparePassword(oldPassword || "");
      if (!isMatch) {
        return res.status(401).json({ error: 'Invalid old password' });
      }
    }

    // ✅ set atau update password
    user.password = newPassword; // pre('save') akan auto-hash
    await user.save();

    res.json({ success: true, message: user.password ? 'Password updated' : 'Password set for the first time' });
  } catch (err: any) {
    console.error('❌ Error update password:', err);
    res.status(400).json({ error: err.message });
  }
});

// 🔹 Update notification settings
router.put('/user/:id/notifications', async (req, res) => {
  try {
    const { notifyNewItems, notifyEmail } = req.body;
    const user = await Auth.findByIdAndUpdate(
      req.params.id,
      { notifyNewItems, notifyEmail },
      { new: true }
    );
    res.json({ success: true, user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

function encryptWithPassphrase(text: string, passphrase: string): string {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

// === Export Custodial Private Key (Protected) ===
router.post("/user/:id/export/private", authenticateJWT, exportLimiter, async (req: AuthRequest, res) => {
  try {
    const { address, password, otpCode, passphrase } = req.body;
    if (!passphrase) return res.status(400).json({ error: "Missing passphrase" });

    if (!otpCode) {
      return res.status(400).json({ error: "Missing OTP code" });
    }

    if (!address || typeof address !== "string" || !password) {
      return res.status(400).json({ error: "Missing wallet address or password" });
    }

    // hanya owner atau admin
    if (req.user.id !== req.params.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: not your account" });
    }

    // cari user dengan field password + custodial wallets
    const user = await Auth.findById(req.params.id).select(
      "+password +otpSecret +custodialWallets.privateKey +custodialWallets.address +custodialWallets.provider"
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.twoFactorEnabled) { 
      return res.status(403).json({ error: "2FA not enabled" });
    }

    // ✅ validasi password pakai method dari model
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PRIVATE_KEY_FAILED",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(401).json({ error: "Invalid password" });
    }

    if (!user.otpSecret) {
      return res.status(400).json({ error: "No OTP secret found, please setup 2FA first" });
    }

    const decryptedSecret = decrypt(user.otpSecret);
    const isValidOTP = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: "base32",
      token: otpCode,
      window: 1
    });

    if (!isValidOTP) {
      console.warn(`❌ Invalid OTP for user=${user._id}, ip=${req.ip}`);
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PRIVATE_KEY_OTP_FAILED",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(401).json({ error: "Invalid OTP" });
    }

    // cari wallet
    const wallet = user.custodialWallets.find((w: any) => w.address === address);
    if (!wallet) {
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PRIVATE_KEY_WALLET_NOT_FOUND",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(404).json({ error: "Wallet not found" });
    }

    // decrypt private key dulu
    let privateKeyPlain: string;
    try {
      privateKeyPlain = decrypt(wallet.privateKey);
    } catch (err: any) {
      console.error("❌ Failed to decrypt private key:", err);
      return res.status(500).json({ error: "Failed to decrypt private key" });
    }

    // 🔑 Baru encrypt pakai passphrase user
    const encryptedForUser = encryptWithPassphrase(privateKeyPlain, passphrase);

    await AuditLog.create({
      userId: user._id,
      walletAddress: wallet.address,
      action: "EXPORT_PRIVATE_KEY",
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });

    return res.json({
      success: true,
      userId: user._id,
      wallet: { provider: wallet.provider, address: wallet.address },
      encryptedKey: encryptedForUser,
    });
  } catch (err: any) {
    console.error(`❌ Failed to decrypt private key`, err);
    return res.status(500).json({ error: "Failed to decrypt private key" });
  }
});

// === Export Custodial Recovery Phrase (Protected) ===
router.post("/user/:id/export/phrase", authenticateJWT, exportLimiter, async (req: AuthRequest, res) => {
  try {
    const { address, password, otpCode, passphrase } = req.body;
    if (!passphrase) return res.status(400).json({ error: "Missing passphrase" });

    if (!otpCode) {
      return res.status(400).json({ error: "Missing OTP code" });
    }

    if (!address || typeof address !== "string" || !password) {
      return res.status(400).json({ error: "Missing wallet address or password" });
    }

    // hanya owner atau admin
    if (req.user.id !== req.params.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: not your account" });
    }

    // cari user dengan password + custodial wallets
    const user = await Auth.findById(req.params.id).select(
      "+password +otpSecret +custodialWallets.mnemonic +custodialWallets.address +custodialWallets.provider"
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!user.twoFactorEnabled) { 
      return res.status(403).json({ error: "2FA not enabled" });
    }

    // ✅ validasi password
    const isValidPassword = await user.comparePassword(password);
    if (!isValidPassword) {
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PHRASE_FAILED",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(401).json({ error: "Invalid password" });
    }

    if (!user.otpSecret) {
      return res.status(400).json({ error: "No OTP secret found, please setup 2FA first" });
    }

    const decryptedSecret = decrypt(user.otpSecret);
    const isValidOTP = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: "base32",
      token: otpCode,
      window: 1
    });

    if (!isValidOTP) {
      console.warn(`❌ Invalid OTP for user=${user._id}, ip=${req.ip}`);
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PHRASE_OTP_FAILED",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(401).json({ error: "Invalid OTP" });
    }

    // cari wallet
    const wallet = user.custodialWallets.find((w: any) => w.address === address);
    if (!wallet) {
      await AuditLog.create({
        userId: user._id,
        walletAddress: address,
        action: "EXPORT_PHRASE_WALLET_NOT_FOUND",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(404).json({ error: "Wallet not found" });
    }

    if (!wallet.mnemonic) {
      await AuditLog.create({
        userId: user._id,
        walletAddress: wallet.address,
        action: "EXPORT_PHRASE_MNEMONIC_NOT_FOUND",
        ip: req.ip,
        userAgent: req.headers["user-agent"]
      });
      return res.status(404).json({ error: "Recovery phrase not available" });
    }

    let phrasePlain: string;
    try {
      phrasePlain = decrypt(wallet.mnemonic);
    } catch (err: any) {
      console.error("❌ Failed to decrypt phrase:", err);
      return res.status(500).json({ error: "Failed to decrypt recovery phrase" });
    }

    // 🔑 Baru encrypt pakai passphrase user
    const encryptedForUser = encryptWithPassphrase(phrasePlain, passphrase);

    await AuditLog.create({
      userId: user._id,
      walletAddress: wallet.address,
      action: "EXPORT_PHRASE",
      ip: req.ip,
      userAgent: req.headers["user-agent"]
    });

    return res.json({
      success: true,
      userId: user._id,
      wallet: {
        provider: wallet.provider,
        address: wallet.address,
      },
      recoveryPhrase: encryptedForUser,
    });
  } catch (err: any) {
    console.error(`❌ Failed to decrypt phrase:`, err);
    return res.status(500).json({ error: "Failed to decrypt phrase" });
  }
});

// === 2FA Setup ===
router.post("/user/:id/2fa/setup", authenticateJWT, async (req: AuthRequest, res) => {
  if (!req.user || (req.user.id !== req.params.id && req.user.role !== "admin")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const secret = speakeasy.generateSecret({ length: 20, name: "UniverseOfGamers" });

  const encrypted = encrypt(secret.base32);

  const user = await Auth.findByIdAndUpdate(
    req.params.id,
    { otpSecret: encrypted, twoFactorEnabled: false },
    { new: true }
  );

  // pastikan secret.otpauth_url ada
  if (!secret.otpauth_url) {
    return res.status(500).json({ error: "Failed to generate OTP URL" });
  }
  const qr = await QRCode.toDataURL(secret.otpauth_url);

  if (user) {
    await AuditLog.create({
      userId: user._id,
      walletAddress: null,
      action: "2FA_SETUP",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
  }

  // res.json({ qr, secret: secret.base32 }); // secret bisa disembunyikan di prod, QR cukup

  res.json({ 
    qr,
    secret: secret.base32
  });
});

// === 2FA Verify ===
router.post("/user/:id/2fa/verify", authenticateJWT, otpLimiter, async (req: AuthRequest, res) => {
  const { otpCode } = req.body;
  if (!otpCode) return res.status(400).json({ error: "Missing OTP code" });

  if (!req.user || (req.user.id !== req.params.id && req.user.role !== "admin")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const user = await Auth.findById(req.params.id).select("+otpSecret");
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.otpSecret) return res.status(400).json({ error: "No OTP secret found, please setup 2FA first" });

  const decryptedSecret = decrypt(user.otpSecret);
  const isValidOTP = speakeasy.totp.verify({
    secret: decryptedSecret,
    encoding: "base32",
    token: otpCode,
    window: 1,
  });

  if (!isValidOTP) {
    await AuditLog.create({
      userId: user._id,
      walletAddress: null,
      action: "2FA_VERIFY_FAILED",
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    return res.status(401).json({ error: "Invalid OTP" });
  }

  await AuditLog.create({
    userId: user._id,
    walletAddress: null,
    action: "2FA_VERIFY",
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  user.twoFactorEnabled = true;
  await user.save();

  res.json({ success: true, message: "2FA enabled successfully" });
});

export default router;
