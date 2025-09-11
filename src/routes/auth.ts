import express from 'express';
import jwt from 'jsonwebtoken';
import Auth from '../models/Auth';
import { ICustodialWallet } from '../models/Auth';
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import { encrypt, decrypt } from '../utils/cryptoHelper';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';

import { mnemonicToSeedSync } from 'bip39';
import nacl from 'tweetnacl';
import * as ed25519 from 'ed25519-hd-key';

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.resolve(process.cwd(), 'uploads/avatars'));
  },
  filename: (req, file, cb) => {
    const unique = `${req.params.id}-${Date.now()}-${Math.round(Math.random() * 1e9)}.png`;
    cb(null, unique);
  }
});
const upload = multer({ storage });

const router = express.Router();

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
    const kp = Keypair.generate();
    const privateKeyBase58 = bs58.encode(kp.secretKey);
    const address = kp.publicKey.toBase58();

    const custodialWallet: ICustodialWallet = {
      provider: 'solana', // ⬅️ type-safe
      address,
      privateKey: encrypt(privateKeyBase58),
    };

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
      avatar: '',
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
      })), // ❌ privateKey tetap hidden
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

router.get('/decrypt', async (req, res) => {
  const encryptedFromDB =
    "VGeGRFaaNrSGcNnyi3UvfHn37uQLtNvi/IPgeEWl8ZpinYbkccMFTUv+ygf16DPJDGNMoOOS3NQN7aZFLbBN1w0/7Wdej2BFY+jgXBUEdBfa+zGXc7FAogr6L83WSighUYKaRFqbnKTZOv//lYh3ezMz2cJ5YuM="; // ganti dengan string terenkripsi kamu

  try {
    const privateKey = decrypt(encryptedFromDB);
    console.log("🔑 Private Key asli:", privateKey);
  } catch (err) {
    console.error("❌ Gagal decrypt:", err);
  }
});

// === Login with Google ===
router.post('/google', async (req, res) => {
  try {
    const { googleId, email, name } = req.body;
    let auth = await Auth.findOne({ googleId });

    if (!auth) {
      auth = new Auth({ googleId, email, name, authProvider: 'google', avatar: '', });
      await auth.save();
    }

    const token = generateToken(auth);
    res.json({ message: 'Login successful', authId: auth._id, token });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// === Login / Import External Wallet ===
router.post('/wallet', async (req, res) => {
  try {
    const { provider, address, name } = req.body;

    let auth = await Auth.findOne({ 'wallets.address': address });

    if (!auth) {
      auth = new Auth({
        name,
        wallets: [{ provider, address }],
        authProvider: 'wallet',
        avatar: '',
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

    // ✅ hide privateKey
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
      const kp = Keypair.generate();
      const privateKeyBase58 = bs58.encode(kp.secretKey);

      const wallet: ICustodialWallet = {
        provider: selectedProvider,
        address: kp.publicKey.toBase58(),
        privateKey: encrypt(privateKeyBase58),
      };

      auth.custodialWallets.push(wallet);
      auth.authProvider = 'custodial';
      await auth.save();

      const token = generateToken(auth);

      return res.status(201).json({
        success: true,
        message: 'Custodial wallet created',
        authId: auth._id,
        token,
        wallet: { provider: wallet.provider, address: wallet.address },
      });
    }

    return res.status(400).json({ error: 'Unsupported provider' });
  } catch (err: any) {
    console.error("❌ Error create custodial wallet:", err.message);
    res.status(500).json({ error: err.message });
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

// === Export Custodial Private Key (Protected) ===
router.get("/user/:id/export/private", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { address } = req.query;
    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "Missing or invalid wallet address" });
    }

    // ⚠️ Pastikan user hanya bisa akses dirinya sendiri (kecuali admin)
    if (req.user.id !== req.params.id && req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: not your account" });
    }

    // 🔍 Cari user + ambil field privateKey
    const user = await Auth.findById(req.params.id).select(
      "+custodialWallets.privateKey +custodialWallets.address +custodialWallets.provider"
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // 🔍 Cari wallet sesuai address
    const wallet = user.custodialWallets.find(
      (w: any) => w.address === address
    );
    if (!wallet) {
      return res.status(404).json({ error: "Wallet not found" });
    }

    // 🔓 Decrypt private key
    let privateKey: string;
    try {
      privateKey = decrypt(wallet.privateKey);
    } catch (err: any) {
      console.error("❌ Failed to decrypt private key:", err);
      return res.status(500).json({ error: "Failed to decrypt private key" });
    }

    return res.json({
      success: true,
      userId: user._id,
      wallet: {
        provider: wallet.provider,
        address: wallet.address,
      },
      privateKey, // ⚠️ hanya keluar kalau JWT valid
    });
  } catch (err: any) {
    console.error("❌ Error export private key:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
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
          avatar: '',
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

export default router;
