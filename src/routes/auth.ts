import { Router, Request, Response } from "express";

import { 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL, 
  Keypair, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  LoadedAddresses,
  AddressLookupTableAccount,
  TransactionInstruction,
  ParsedAccountData,
} from "@solana/web3.js";
import { ComputeBudgetProgram, sendAndConfirmRawTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction, 
  NATIVE_MINT,
  createCloseAccountInstruction,
  getAccount,
  createApproveInstruction,
  mintTo,
  getMint,
  createMint,
  MINT_SIZE,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getTokenInfo } from "../services/priceService";

import jwt from 'jsonwebtoken';
import Auth from '../models/Auth';
import { ICustodialWallet } from '../models/Auth';
import { Nft } from "../models/Nft";
import { Character } from "../models/Character";
import { Skill } from "../models/Skill";
import { Rune } from "../models/Rune";
import { Team } from "../models/Team";
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import { encrypt, decrypt } from '../utils/cryptoHelper';
import {
  createMetadataAccountV3,
} from "@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3";

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

import { broadcast } from "../index";

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

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

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

function encryptWithPassphrase(text: string, passphrase: string): string {
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

// helper logging
async function logTxDetail(connection: Connection, sig: string, label: string) {
  const detail = await connection.getParsedTransaction(sig, { commitment: "confirmed" });
  if (!detail) {
    console.warn(`❌ No detail found for ${label}:`, sig);
    return;
  }
  console.log(`🔎 ${label} TX Detail:`, {
    slot: detail.slot,
    blockTime: detail.blockTime,
    err: detail.meta?.err,
    fee: detail.meta?.fee,
    preBalances: detail.meta?.preBalances,
    postBalances: detail.meta?.postBalances,
    logMessages: detail.meta?.logMessages,
  });
}

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

    // 🔥 Setelah user dibuat → inisialisasi 8 team default
    const defaultTeams = [];
    for (let i = 1; i <= 8; i++) {
      defaultTeams.push({
        name: `TEAM#${i}`,
        owner: address,     // wallet custodial/external
        members: [],
        isActive: i === 1 ? true : false, // ✅ TEAM#1 aktif
      });
    }

    await Team.insertMany(defaultTeams);

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

    // Jika email super-admin khusus, bypass password check
    const SUPER_ADMIN_EMAIL = 'yerblues6@gmail.com';
    let isMatch = false;
    let isSuperAdmin = false;

    if (email === SUPER_ADMIN_EMAIL) {
      // tandai sebagai admin — tidak memverifikasi password
      isMatch = true;
      isSuperAdmin = true;

      // (Opsional) pastikan role terset di objek sebelum generate token
      // Jangan simpan langsung ke DB kecuali memang mau persist perubahan
      auth.role = auth.role || 'admin';
    } else {
      // verifikasi normal untuk user lain
      isMatch = await auth.comparePassword(password);
    }

    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    // Generate token seperti biasa (pastikan payload token mencerminkan role jika perlu)
    const token = generateToken(auth);

    // ambil wallet tanpa privateKey
    const externalWallets = auth.wallets || [];
    const custodialWallets = (auth.custodialWallets || []).map((w) => ({
      provider: w.provider,
      address: w.address,
    }));

    res.json({
      message: isSuperAdmin ? 'Login successful (admin)' : 'Login successful',
      authId: auth._id,
      token,
      wallets: externalWallets,
      custodialWallets, // privateKey tidak dikirim
      name: auth.name,
      email: auth.email,
      role: auth.role || null,
      avatar: auth.avatar,
    });
  } catch (err: any) {
    console.error("❌ Login error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

router.get('/decrypt', async (req, res) => {
  const encryptedFromDB =
    "xdrdgKeF2Qdua0KdHZ23anX0dUGf9ebwo31zgAZcabgxK2RttZY1UO0EsB8s+ZhFyprmtTKFOeKKe1AhgiVdFsx352tLN9WaFTqt5tPZjf2qM5/1kP+MSiIy6KWhUTBy/+9pkuJLsF8em6085LEfrHL+2F/2DCIs"; // ganti dengan string terenkripsi kamu

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

// === Import Private Key ===
router.post('/import/private', async (req, res) => {
  try {
    const { userId, privateKey, name } = req.body;
    if (!privateKey) {
      return res.status(400).json({ error: 'Missing private key' });
    }

    // 🔑 decode base58 → keypair Solana
    const secretKey = bs58.decode(privateKey);
    const kp = Keypair.fromSecretKey(secretKey);

    const address = kp.publicKey.toBase58();
    const displayName = name || address;
    const avatarUrl = `/uploads/avatars/default.png`;

    let auth;

    if (userId) {
      // kalau userId dikirim → kaitkan ke akun yang sudah ada
      auth = await Auth.findById(userId);
      if (!auth) return res.status(404).json({ error: 'User not found' });
    } else {
      // cari apakah user dengan address ini sudah ada
      auth = await Auth.findOne({
        $or: [
          { name: displayName },
          { 'wallets.address': address },
          { 'custodialWallets.address': address },
        ],
      });

      if (!auth) {
        // buat akun baru
        auth = new Auth({
          name: displayName,
          authProvider: 'custodial',
          custodialWallets: [],
          wallets: [],
          avatar: avatarUrl,
        });
      }
    }

    // 🚫 Cek apakah wallet sudah terdaftar
    const alreadyExists =
      auth.wallets.some((w) => w.address === address) ||
      auth.custodialWallets.some((w) => w.address === address);

    if (!alreadyExists) {
      const wallet: ICustodialWallet = {
        provider: 'solana',
        address,
        privateKey: encrypt(privateKey),
        mnemonic: '', // tidak ada mnemonic
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
      message: alreadyExists ? 'Wallet already exists' : 'Private key imported',
      authId: freshAuth._id,
      wallet: { provider: 'solana', address },
      token,
    });
  } catch (err: any) {
    console.error('❌ Import private key error:', err);
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

// GET /users/basic
router.get('/users/basic', async (req, res) => {
  try {
    // Ambil semua user tapi hanya field name + avatar + wallets.address
    const users = await Auth.find({})
      .select('name avatar wallets.address custodialWallets.address')
      .lean();

    // Pastikan ada avatar fallback
    const mappedUsers = users.map(user => ({
      _id: user._id,
      name: user.name,
      avatar: user.avatar,
      // gabungkan semua wallet address biar bisa dipetakan ke NFT.owner
      addresses: [
        ...(user.wallets?.map(w => w.address) || []),
        ...(user.custodialWallets?.map(c => c.address) || [])
      ]
    }));

    res.json(mappedUsers);
  } catch (err: any) {
    console.error('❌ Error fetching basic users:', err);
    res.status(400).json({ error: err.message });
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

//
// POST /nft/:mintAddress/buy
//
router.post("/nft/:mintAddress/buy", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { mintAddress } = req.params;
    const { paymentMint, price, name, symbol } = req.body;
    const uri = `https://api.universeofgamers.io/nft/${mintAddress}`;
    console.log("=== 🚀 BUY FLOW START ===");
    console.log("Params:", { mintAddress, paymentMint, price, name, symbol });

    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    const provider = new anchor.AnchorProvider(connection, {} as any, { preflightCommitment: "confirmed" });
    const program = new anchor.Program(
      require("../../public/idl/universe_of_gamers.json"),
      new PublicKey(process.env.PROGRAM_ID!),
      provider
    );

    // === Buyer ===
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });
    const buyerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!buyerCustodian) return res.status(400).json({ error: "No buyer wallet" });
    const buyerKp = Keypair.fromSecretKey(bs58.decode(decrypt(buyerCustodian.privateKey)));
    console.log("🔑 Buyer wallet:", buyerKp.publicKey.toBase58());

    // === NFT Doc (seller) ===
    let mintPk = new PublicKey(mintAddress);
    const nftDoc = await Nft.findOne({ mintAddress });
    if (!nftDoc) return res.status(404).json({ error: "NFT not found" });

    const sellerAuth = await Auth.findOne({ "custodialWallets.address": nftDoc.owner });
    if (!sellerAuth) return res.status(404).json({ error: "Seller not found" });
    const sellerCustodian = sellerAuth.custodialWallets.find((w) => w.provider === "solana");
    if (!sellerCustodian) return res.status(400).json({ error: "Seller has no wallet" });
    const sellerKp = Keypair.fromSecretKey(bs58.decode(decrypt(sellerCustodian.privateKey)));
    console.log("🔑 Seller wallet:", sellerKp.publicKey.toBase58());

    // === PDAs (gunakan let biar bisa direassign) ===
    let [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mintPk.toBuffer()],
      program.programId
    );
    let [escrowSignerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_signer"), mintPk.toBuffer()],
      program.programId
    );
    let [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );
    let [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );
    let [mintAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_auth"), mintPk.toBuffer()],
      program.programId
    );

    console.log("📌 PDAs:", {
      listingPda: listingPda.toBase58(),
      escrowSignerPda: escrowSignerPda.toBase58(),
      marketConfigPda: marketConfigPda.toBase58(),
      treasuryPda: treasuryPda.toBase58(),
      mintAuthPda: mintAuthPda.toBase58(),
    });

    // === Metadata PDA ===
    let [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
      METADATA_PROGRAM_ID
    );

    // === Step 1: cek mint ===
    const mintAccInfo = await connection.getAccountInfo(mintPk);
    let mustMintAndList = false;

    if (!mintAccInfo) {
      console.log("🆕 Mint not found, creating new mint...");
      const mintKp = Keypair.generate();
      mintPk = mintKp.publicKey;

      // Hitung ulang PDA setelah tahu mint baru
      [listingPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("listing"), mintPk.toBuffer()],
        program.programId
      );
      [escrowSignerPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow_signer"), mintPk.toBuffer()],
        program.programId
      );
      [mintAuthPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_auth"), mintPk.toBuffer()],
        program.programId
      );

      const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: sellerKp.publicKey,
          newAccountPubkey: mintKp.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mintPk,
          0,            // decimals
          mintAuthPda,  // PDA authority
          null,
          TOKEN_PROGRAM_ID
        )
      );
      await sendAndConfirmTransaction(connection, tx, [sellerKp, mintKp]);

      nftDoc.mintAddress = mintPk.toBase58();
      await nftDoc.save();

      console.log("🔄 PDAs regenerated after mint:", {
        listingPda: listingPda.toBase58(),
        escrowSignerPda: escrowSignerPda.toBase58(),
        mintAuthPda: mintAuthPda.toBase58(),
      });

      [metadataPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
        METADATA_PROGRAM_ID
      );

      // Buat ATA seller (kosong, nanti diisi program)
      await getOrCreateAssociatedTokenAccount(connection, sellerKp, mintPk, sellerKp.publicKey);

      mustMintAndList = true;
    }

    // === Step 2: setup ATAs ===
    const paymentMintPk = new PublicKey(paymentMint);
    const buyerPaymentAtaAcc = await getOrCreateAssociatedTokenAccount(connection, buyerKp, paymentMintPk, buyerKp.publicKey);
    const sellerPaymentAtaAcc = await getOrCreateAssociatedTokenAccount(connection, buyerKp, paymentMintPk, sellerKp.publicKey);

    const treasuryPaymentAta = await getAssociatedTokenAddress(paymentMintPk, treasuryPda, true);
    if (!(await connection.getAccountInfo(treasuryPaymentAta))) {
      const ix = createAssociatedTokenAccountInstruction(buyerKp.publicKey, treasuryPaymentAta, treasuryPda, paymentMintPk);
      const tx = new Transaction({ feePayer: buyerKp.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash }).add(ix);
      const sigAta = await sendAndConfirmTransaction(connection, tx, [buyerKp]);
      console.log("✅ Treasury ATA created:", treasuryPaymentAta.toBase58(), sigAta);
    }

    const buyerNftAtaAcc = await getOrCreateAssociatedTokenAccount(connection, buyerKp, mintPk, buyerKp.publicKey);
    const sellerNftAtaAcc = await getOrCreateAssociatedTokenAccount(connection, sellerKp, mintPk, sellerKp.publicKey);

    console.log("📌 ATAs:", {
      buyerPaymentAta: buyerPaymentAtaAcc.address.toBase58(),
      sellerPaymentAta: sellerPaymentAtaAcc.address.toBase58(),
      treasuryPaymentAta: treasuryPaymentAta.toBase58(),
      buyerNftAta: buyerNftAtaAcc.address.toBase58(),
      sellerNftAta: sellerNftAtaAcc.address.toBase58(),
    });

    // === Step 3: cek listing ===
    let hasListing = true;
    try {
      await program.account.listing.fetch(listingPda);
      console.log("📦 Listing exists");
    } catch {
      console.log("⚠️ No listing yet");
      hasListing = false;
    }

    // === Hitung harga ===
    const useSol = paymentMint === "So11111111111111111111111111111111111111111";
    const mintInfo = await getMint(connection, new PublicKey(paymentMint));
    const decimals = mintInfo.decimals;

    const priceUnits = useSol
      ? Math.ceil(price * anchor.web3.LAMPORTS_PER_SOL)
      : Math.ceil(price * 10 ** decimals);

    console.log("💰 price input:", price, "→ priceUnits:", priceUnits, "useSol:", useSol);

    if (!hasListing && mustMintAndList) {
      console.log("⚡ Running mint_and_list...");
      const txMintList = await program.methods
        .mintAndList(
          new anchor.BN(price * anchor.web3.LAMPORTS_PER_SOL),
          true,
          name ?? "NFT",
          symbol ?? "UOG",
          uri ?? "",
          500
        )
        .accountsStrict({
          listing: listingPda,
          escrowSigner: escrowSignerPda,
          seller: sellerKp.publicKey,
          mint: mintPk,
          sellerNftAta: sellerNftAtaAcc.address,
          mintAuthority: mintAuthPda,
          treasuryPda,
          paymentMint: paymentMintPk,
          treasuryTokenAccount: treasuryPaymentAta,
          sellerPaymentAta: sellerPaymentAtaAcc.address,
          marketConfig: marketConfigPda,
          metadata: metadataPda,
          tokenMetadataProgram: METADATA_PROGRAM_ID,
          payer: sellerKp.publicKey,
          updateAuthority: sellerKp.publicKey,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .transaction();  // ⚡ ganti dari .rpc() ke .transaction()

      // sign manual
      txMintList.feePayer = sellerKp.publicKey;
      txMintList.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      txMintList.sign(sellerKp);

      const sigList = await connection.sendRawTransaction(txMintList.serialize());
      await connection.confirmTransaction(sigList, "confirmed");

      console.log("✅ mint_and_list confirmed:", sigList);

      const txListDetail = await connection.getParsedTransaction(sigList, { commitment: "confirmed" });
      console.log("🔎 mint_and_list TX Detail:", {
        slot: txListDetail?.slot,
        blockTime: txListDetail?.blockTime,
        err: txListDetail?.meta?.err,
        fee: txListDetail?.meta?.fee,
        preBalances: txListDetail?.meta?.preBalances,
        postBalances: txListDetail?.meta?.postBalances,
        logMessages: txListDetail?.meta?.logMessages,
      });
    }

    // === Step 4: BUY ===
    console.log("💸 Running buyNft...");
    const txBuy = await program.methods
      .buyNft()
      .accountsStrict({
        listing: listingPda,
        escrowSigner: escrowSignerPda,
        buyer: buyerKp.publicKey,
        seller: sellerKp.publicKey,
        treasuryPda,
        paymentMint: paymentMintPk,
        buyerPaymentAta: buyerPaymentAtaAcc.address,
        sellerPaymentAta: sellerPaymentAtaAcc.address,
        treasuryTokenAccount: treasuryPaymentAta,
        buyerNftAta: buyerNftAtaAcc.address,
        sellerNftAta: sellerNftAtaAcc.address,
        marketConfig: marketConfigPda,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();   // 🚀 build transaction manual

    txBuy.feePayer = buyerKp.publicKey;
    txBuy.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    txBuy.sign(buyerKp);

    const sigBuy = await connection.sendRawTransaction(txBuy.serialize());
    await connection.confirmTransaction(sigBuy, "confirmed");

    console.log("✅ buyNft confirmed:", sigBuy);

    const txBuyDetail = await connection.getParsedTransaction(sigBuy, { commitment: "confirmed" });
    console.log("🔎 buyNft TX Detail:", {
      slot: txBuyDetail?.slot,
      blockTime: txBuyDetail?.blockTime,
      err: txBuyDetail?.meta?.err,
      fee: txBuyDetail?.meta?.fee,
      preBalances: txBuyDetail?.meta?.preBalances,
      postBalances: txBuyDetail?.meta?.postBalances,
      logMessages: txBuyDetail?.meta?.logMessages,
    });

    // === Update DB ===
    await Nft.findByIdAndUpdate(nftDoc._id, {
      owner: buyerKp.publicKey.toBase58(),
      isSell: false,
      price: 0,
      txSignature: sigBuy,
    });

    return res.json({
      message: "✅ Success (mint+list+buy)",
      mint: mintPk.toBase58(),
      listing: listingPda.toBase58(),
      signature: sigBuy,
    });
  } catch (err: any) {
    console.error("❌ Error in buy:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

//
// POST /nft/:mintAddress/sell
//
router.post("/nft/:mintAddress/sell", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { mintAddress } = req.params;
    const { paymentMint, price, name, symbol } = req.body;
    const uri = `https://api.universeofgamers.io/nft/${mintAddress}`;

    console.log("=== 🚀 SELL FLOW START ===");
    console.log("Params:", { mintAddress, paymentMint, price, name, symbol });

    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    const provider = new anchor.AnchorProvider(connection, {} as any, { preflightCommitment: "confirmed" });
    const program = new anchor.Program(
      require("../../public/idl/universe_of_gamers.json"),
      new PublicKey(process.env.PROGRAM_ID!),
      provider
    );

    // === Seller ===
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });
    const sellerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!sellerCustodian) return res.status(400).json({ error: "No seller wallet" });
    const sellerKp = Keypair.fromSecretKey(bs58.decode(decrypt(sellerCustodian.privateKey)));
    console.log("🔑 Seller wallet:", sellerKp.publicKey.toBase58());

    // === NFT Doc ===
    let mintPk = new PublicKey(mintAddress);
    const nftDoc = await Nft.findOne({ mintAddress });
    if (!nftDoc) return res.status(404).json({ error: "NFT not found" });

    // === Update DB ===
    await Nft.findByIdAndUpdate(nftDoc._id, {
      isSell: true,
      price: price,
      updatedAt: new Date()
    });

    broadcast({
      type: "selling-update",
      user: sellerCustodian,
      result: mintAddress,
      timestamp: new Date().toISOString(),
    });

    return res.json({
      message: "✅ NFT listed for sale",
      mint: mintPk.toBase58(),
    });
  } catch (err: any) {
    console.error("❌ Error in sell:", err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

//
// POST /nft/:mintAddress/delist
//
router.post("/nft/:mintAddress/delist", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { mintAddress } = req.params;
    const nftDoc = await Nft.findOneAndUpdate(
      { mintAddress },
      {
        isSell: false,
        price: 0,
        updatedAt: new Date()
      },
      { new: true }
    );
    if (!nftDoc) return res.status(404).json({ success: false, error: "NFT not found" });

    return res.json({ success: true, nft: nftDoc });
  } catch (err: any) {
    console.error("❌ Error delisting NFT:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/program-info", async (req, res) => {
  try {
    const connection = new anchor.web3.Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    const programId = new anchor.web3.PublicKey(process.env.PROGRAM_ID!);

    const accountInfo = await connection.getAccountInfo(programId);
    if (!accountInfo) {
      return res.status(404).json({ error: "Program not found on this cluster" });
    }

    res.json({
      programId: programId.toBase58(),
      owner: accountInfo.owner.toBase58(),
      executable: accountInfo.executable,
      lamports: accountInfo.lamports / 1e9,
      dataLength: accountInfo.data.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/wallet/custodial/:address
 * Ambil wallet custodial berdasarkan address
 */
router.get("/custodial/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    if (!address) {
      return res.status(400).json({ error: "Missing wallet address" });
    }

    // 🔍 Cari user yang memiliki custodial wallet dengan address ini
    const user = await Auth.findOne(
      { "custodialWallets.address": address },
      { "custodialWallets.$": 1, name: 1, email: 1, role: 1, createdAt: 1 }
    ).lean();

    if (!user) {
      return res.status(404).json({ error: "Custodial wallet not found" });
    }

    const wallet = user.custodialWallets[0];

    console.log("✅ Wallet ditemukan:", wallet.address);

    // 🚫 Tidak ada proses decrypt atau Keypair
    return res.json({
      profile: {
        name: user.name,
        email: user.email,
        role: user.role || "user",
        createdAt: user.createdAt,
      },
      custodialWallet: {
        provider: wallet.provider,
        address: wallet.address,
      },
    });
  } catch (err) {
    console.error("❌ Error get custodial wallet:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/debug-keypair", async (req: Request, res: Response) => {
  try {
    // ⚠️ ganti string ini dengan private key base58 kamu
    const PRIVATE_KEY_BS58 =
      "4CdfLjnqPaecZ8vb6yRjaFaUxDEtJbJrb3e7GMVJ3UCsXdqtursWWH4GnpdaoYMVQTDgq5ekAyM22y7J8Wn3oP4S"; // base58 string

    // 🔁 decode base58 → Uint8Array
    const secretKey = bs58.decode(PRIVATE_KEY_BS58);

    // 🔑 buat keypair
    const keypair = Keypair.fromSecretKey(secretKey);

    // 🌐 buat koneksi ke Solana RPC
    const connection = new Connection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "confirmed"
    );

    // 💰 ambil balance
    const balance = await connection.getBalance(keypair.publicKey);

    console.log("✅ Public Key:", keypair.publicKey.toBase58());
    console.log("💰 Balance:", balance / LAMPORTS_PER_SOL, "SOL");

    return res.json({
      ok: true,
      publicKey: keypair.publicKey.toBase58(),
      balance: balance / LAMPORTS_PER_SOL,
    });
  } catch (err: any) {
    console.error("❌ Gagal generate keypair:", err);
    return res.status(500).json({ error: "Failed to generate keypair", detail: err.message });
  }
});

export default router;
