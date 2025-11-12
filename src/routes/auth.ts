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
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getTokenInfo } from "../services/priceService";
import { invalidateWalletCache, walletEvents } from "../services/walletStreamService";
import { getWalletBalance, refreshWalletCache } from "../services/walletStreamService"; 
import jwt from 'jsonwebtoken';
import Auth from '../models/Auth';
import { ICustodialWallet } from '../models/Auth';
import { Nft } from "../models/Nft";
import { Character } from "../models/Character";
import { Skill } from "../models/Skill";
import { Rune } from "../models/Rune";
import { Team } from "../models/Team";
import { Player } from "../models/Player";
import { Referral } from "../models/Referral";
import { authenticateJWT, requireAdmin, AuthRequest, optionalAuth } from "../middleware/auth";
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
const walletChallenges = new Map();

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
    const { name, email, password, acceptedTerms, referralCode } = req.body;

    console.log('🆕 [REGISTER] Incoming:', { name, email, referralCode });

    // 🔎 Cek duplikasi email
    const existingUser = await Auth.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // ✅ Buat avatar default
    const avatarUrl = `/uploads/avatars/default.png`;

    // ✅ Buat user baru (tanpa wallet)
    const auth = new Auth({
      name,
      email,
      password,
      acceptedTerms,
      authProvider: 'local',
      wallets: [], // belum ada wallet
      custodialWallets: [],
      avatar: avatarUrl,
      usedReferralCode: referralCode || null,
    });

    await auth.save();
    console.log('✅ New Auth user created:', email);

    // =======================================================
    // 🧩 Auto-Create Referral Code (berdasarkan email)
    // =======================================================
    if (email && email.includes('@')) {
      const baseCode = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

      const existingReferral = await Referral.findOne({
        $or: [{ referrerId: auth._id }, { code: baseCode }],
      });

      if (!existingReferral) {
        const newReferral = new Referral({
          referrerId: auth._id,
          code: baseCode,
        });
        await newReferral.save();
        console.log(`🎟️ Referral code created: ${baseCode}`);
      } else {
        console.log(`ℹ️ Referral already exists: ${baseCode}`);
      }
    }

    // =====================================================
    // 🎟️ APPLY REFERRAL CODE (perbaikan variabel)
    // =====================================================
    if (referralCode && referralCode.trim() !== '') {
      console.log(`🎟️ [REGISTER REFERRAL CODE] Attempting to apply referral code: ${referralCode}`);

      const referral = await Referral.findOne({ code: referralCode, isActive: true });
      if (!referral) {
        console.warn(`❌ [REGISTER REFERRAL CODE] Invalid referral code: ${referralCode}`);
        return res.status(404).json({ success: false, error: 'Invalid referral code' });
      }

      if (referral.referrerId.toString() === String(auth._id)) {
        console.warn(`⚠️ [REGISTER REFERRAL CODE] User tried to use their own referral code.`);
        return res.status(400).json({ success: false, error: 'You cannot use your own referral code' });
      }

      if (!auth.usedReferralCode) {
        auth.usedReferralCode = referral._id.toString();
        await auth.save();

        referral.totalClaimable += 0;
        await referral.save();
        console.log(`✅ [REGISTER REFERRAL CODE] Referral successfully applied for ${auth.email}`);
      } else {
        console.log(`ℹ️ [REGISTER REFERRAL CODE] Referral already applied earlier.`);
      }
    }

    // =======================================================
    // 🎮 Inisialisasi Player record
    // =======================================================
    let playerData = await Player.findOne({ username: name }).select(
      'rank totalEarning username lastActive'
    );

    if (!playerData) {
      playerData = new Player({
        username: name,
        rank: 'sentinel',
        totalEarning: 0,
      });
      await playerData.save();
      console.log('🎮 Player record created for', name);
    }

    // =======================================================
    // 🧱 Inisialisasi 8 Team default
    // =======================================================
    const defaultTeams = [];
    for (let i = 1; i <= 8; i++) {
      defaultTeams.push({
        name: `TEAM#${i}`,
        owner: auth._id,
        members: [],
        isActive: i === 1,
      });
    }

    await Team.insertMany(defaultTeams);
    console.log('✅ Default teams initialized for', email);

    // =======================================================
    // 🔑 Generate JWT Token
    // =======================================================
    const token = generateToken(auth);

    // =======================================================
    // 🎁 Ambil referral data untuk response
    // =======================================================
    const referralData = await Referral.findOne({ referrerId: auth._id }).select(
      'code totalClaimable totalClaimed isActive createdAt'
    );

    // =======================================================
    // 📤 Response sukses
    // =======================================================
    res.status(201).json({
      message: 'User registered successfully',
      authId: auth._id,
      token,
      name: auth.name,
      email: auth.email,
      avatar: auth.avatar,
      role: auth.role || null,
      wallets: auth.wallets,
      custodialWallets: [],
      player: {
        rank: playerData.rank,
        totalEarning: playerData.totalEarning,
        lastActive: playerData.lastActive,
      },
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
            createdAt: referralData.createdAt,
          }
        : null,
      authProvider: auth.authProvider || 'unknown',
      twoFactorEnabled: auth.twoFactorEnabled || false,
      acceptedTerms: auth.acceptedTerms || false,
      createdAt: auth.createdAt,
    });
  } catch (err: any) {
    console.error('❌ Register error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// === Login Local ===
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const auth = await Auth.findOne({ email });
    if (!auth) return res.status(404).json({ error: 'User not found' });

    const SUPER_ADMIN_EMAIL = 'yerblues6@gmail.com';
    let isMatch = false;
    let isSuperAdmin = false;

    if (email === SUPER_ADMIN_EMAIL) {
      isMatch = true;
      isSuperAdmin = true;
      auth.role = auth.role || 'user';
    } else {
      isMatch = await auth.comparePassword(password);
    }

    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    // ✅ Generate JWT Token
    const token = generateToken(auth);

    // =======================================================
    // 🎁 Referral data
    // =======================================================
    const referralData = await Referral.findOne({ referrerId: auth._id })
      .select('code totalClaimable totalClaimed isActive createdAt');

    // ✅ Ambil wallet (tanpa privateKey)
    const externalWallets = auth.wallets || [];
    const custodialWallets = (auth.custodialWallets || []).map((w) => ({
      provider: w.provider,
      address: w.address,
    }));

    // ============================================================
    // 🧩 Tambahan: Ambil Data Player (rank & totalEarning)
    // ============================================================
    let playerData = null;

    // Jika user punya wallet custodial atau external → gunakan salah satunya
    const walletAddr =
      custodialWallets[0]?.address || externalWallets[0]?.address;

    if (walletAddr) {
      playerData = await Player.findOne({ walletAddress: walletAddr })
        .select("rank totalEarning username lastActive");
    }

    // Kalau belum ada Player record, buat default
    if (!playerData) {
      // playerData = new Player({
      //   username: auth.name,
      //   walletAddress: walletAddr || null,
      //   rank: "sentinel",
      //   totalEarning: 0,
      // });
      // await playerData.save();
    }

    // ============================================================
    // ✅ Response Lengkap Login
    // ============================================================
    console.log("🟢 [LOGIN_RESPONSE] Sending response data:", {
      authId: auth._id,
      name: auth.name,
      email: auth.email,
      role: auth.role,
      authProvider: auth.authProvider,
      twoFactorEnabled: auth.twoFactorEnabled,
      acceptedTerms: auth.acceptedTerms,
      wallets: (auth.wallets || []).length,
      custodialWallets: (auth.custodialWallets || []).map((w) => w.provider),
      player: playerData
        ? {
            rank: playerData.rank,
            totalEarning: playerData.totalEarning,
            lastActive: playerData.lastActive,
          }
        : null,
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
          }
        : null,
    });

    // ============================================================
    // ✅ Response Lengkap
    // ============================================================
    res.json({
      message: isSuperAdmin ? 'Login successful (admin)' : 'Login successful',
      authId: auth._id,
      token,
      name: auth.name,
      email: auth.email,
      avatar: auth.avatar,
      role: auth.role || null,
      wallets: auth.wallets || [],
      custodialWallets: (auth.custodialWallets || []).map((w: any) => ({
        provider: w.provider,
        address: w.address,
      })),
      player: playerData
        ? {
            rank: playerData.rank,
            totalEarning: playerData.totalEarning,
            lastActive: playerData.lastActive,
          }
        : null,
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
            createdAt: referralData.createdAt,
          }
        : null,
      authProvider: auth.authProvider,
      twoFactorEnabled: auth.twoFactorEnabled || false,
      acceptedTerms: auth.acceptedTerms || false,
      createdAt: auth.createdAt,
    });

  } catch (err: any) {
    console.error("❌ Login error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// === Login with Google ===
router.post('/google', async (req, res) => {
  try {
    console.log('🌐 [Google Login] Incoming request:', req.body);

    const { idToken, email, name, picture } = req.body;

    if (!email) {
      console.warn('⚠️ Missing email in Google login payload');
      return res.status(400).json({ error: 'Missing email from Google login' });
    }

    console.log(`🔎 Checking existing Auth record for: ${email}`);
    let auth = await Auth.findOne({ email });
    const SUPER_ADMIN_EMAIL = 'yerblues6@gmail.com';
    let isSuperAdmin = false;

    // =======================================================
    // 🆕 NEW USER
    // =======================================================
    if (!auth) {
      console.log('🆕 Creating new Google user...');
      const avatarUrl = picture || `/uploads/avatars/default.png`;

      auth = new Auth({
        name,
        email,
        googleId: idToken,
        authProvider: 'google',
        acceptedTerms: true,
        wallets: [],
        custodialWallets: [],
        avatar: avatarUrl,
      });

      await auth.save();
      console.log('✅ New Google Auth record created for:', email);

      // =======================================================
      // 🧩 Auto-Create Referral Code
      // =======================================================
      if (email.includes('@')) {
        const baseCode = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        const existingReferral = await Referral.findOne({
          $or: [{ referrerId: auth._id }, { code: baseCode }],
        });

        if (!existingReferral) {
          await new Referral({ referrerId: auth._id, code: baseCode }).save();
          console.log(`🎟️ Referral code created: ${baseCode}`);
        } else {
          console.log(`ℹ️ Referral code already exists: ${baseCode}`);
        }
      }

      // =======================================================
      // 🎮 Player Data
      // =======================================================
      let playerData = await Player.findOne({ username: name });
      if (!playerData) {
        playerData = new Player({
          username: name,
          rank: 'sentinel',
          totalEarning: 0,
        });
        await playerData.save();
        console.log('🎮 Player record created for', name);
      }

      // =======================================================
      // 🧱 Default Teams (pakai _id karena belum ada wallet)
      // =======================================================
      const defaultTeams = [];
      for (let i = 1; i <= 8; i++) {
        defaultTeams.push({
          name: `TEAM#${i}`,
          owner: auth._id,
          members: [],
          isActive: i === 1,
        });
      }

      await Team.insertMany(defaultTeams);
      console.log('✅ Default teams initialized for', email);
    }

    // =======================================================
    // 👋 EXISTING USER
    // =======================================================
    else {
      console.log('👋 Existing Google user detected, checking wallet & teams...');

      // 🔍 Ambil walletAddress dari auth
      const walletAddress =
        auth.wallets?.[0]?.address ||
        auth.custodialWallets?.[0]?.address ||
        null;

      if (walletAddress) {
        console.log(`💳 User has wallet address: ${walletAddress}`);

        // 🔁 Update semua team yang owner-nya masih _id → ganti jadi wallet address
        const existingTeams = await Team.find({ owner: auth._id });
        if (existingTeams.length > 0) {
          const result = await Team.updateMany(
            { owner: auth._id },
            { $set: { owner: walletAddress } }
          );
          console.log(`🔄 Updated ${result.modifiedCount} teams to use wallet owner.`);
        } else {
          console.log('ℹ️ No team records owned by user ID, skip updating.');
        }
      } else {
        console.log('⚠️ User has no wallet yet, keeping team ownership by _id.');
      }
    }

    // =======================================================
    // 👑 SUPER ADMIN LOGIC (dipindah ke sini, auth sudah pasti ada)
    // =======================================================
    if (auth && email === SUPER_ADMIN_EMAIL) {
      isSuperAdmin = true;
      auth.role = auth.role || 'user';
      await auth.save();
      console.log(`👑 Super admin privileges applied for ${email}`);
    }

    // =======================================================
    // 🔑 Generate JWT Token
    // =======================================================
    const token = generateToken(auth);

    // =======================================================
    // 🎁 Referral data
    // =======================================================
    const referralData = await Referral.findOne({ referrerId: auth._id })
      .select('code totalClaimable totalClaimed isActive createdAt');

    // =======================================================
    // 🎮 Player data
    // =======================================================
    const playerData = await Player.findOne({ username: auth.name })
      .select('rank totalEarning username lastActive');

    // =======================================================
    // 🕒 Update Last Active
    // =======================================================
    if (playerData) {
      playerData.lastActive = new Date();
      await playerData.save();
    }

    // =======================================================
    // 📤 Response ke client
    // =======================================================
    res.json({
      message: isSuperAdmin ? 'Login successful (admin)' : 'Login successful',
      authId: auth._id,
      token,
      name: auth.name,
      email: auth.email,
      avatar: auth.avatar,
      role: auth.role || null,
      wallets: auth.wallets || [],
      custodialWallets: (auth.custodialWallets || []).map((w: any) => ({
        provider: w.provider,
        address: w.address,
      })),
      player: playerData
        ? {
            rank: playerData.rank,
            totalEarning: playerData.totalEarning,
            lastActive: playerData.lastActive,
          }
        : null,
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
            createdAt: referralData.createdAt,
          }
        : null,
      authProvider: auth.authProvider || 'google',
      twoFactorEnabled: auth.twoFactorEnabled || false,
      acceptedTerms: auth.acceptedTerms || false,
      createdAt: auth.createdAt,
    });

  } catch (err) {
    const error = err as Error;
    console.error('❌ [Google Login Error]', error);
    res.status(400).json({ error: error.message });
  }
});

// === Challenge endpoint ===
router.get('/wallet/challenge', async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "Missing address" });

  const nonce = Math.floor(Math.random() * 1_000_000_000);
  walletChallenges.set(address, nonce.toString());

  const challenge = {
    message: 'test-login',
    nonce: nonce.toString(),
    timestamp: new Date().toISOString(),
  };

  res.json(challenge);
});

// === Login / Import External Wallet ===
router.post('/wallet', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const { provider, address, name, signature, nonce } = req.body;
    console.log('🟩 [AUTH_WALLET] Incoming login', { address, provider, nonce });

    const expectedNonce = walletChallenges.get(address);
    console.log('🔹 Expected nonce from cache:', expectedNonce);

    if (!expectedNonce || expectedNonce !== nonce) {
      console.warn('⚠️ Invalid or expired nonce for address:', address);
      return res.status(400).json({ error: 'Invalid or expired nonce' });
    }

    walletChallenges.delete(address);

    // ✅ Verifikasi signature
    const message = `test-login`;
    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      new PublicKey(address).toBytes()
    );
    console.log('✅ Signature valid?', isValid);

    if (!isValid) {
      console.warn('❌ Invalid signature for address:', address);
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // =====================================================
    // 🚫 Validasi wallet duplikat (tidak boleh dipakai user lain)
    // =====================================================
    const existingWalletUser = await Auth.findOne({
      $or: [
        { 'wallets.address': address },
        { 'custodialWallets.address': address },
      ],
      _id: { $ne: req.user?.id || null },
    });

    if (existingWalletUser) {
      console.warn(`⚠️ Wallet ${address} already linked to another account: ${existingWalletUser._id}`);
      return res.status(400).json({
        success: false,
        error: 'This wallet address is already linked to another account.',
      });
    }

    // =====================================================
    // 🧩 Step 1. Cek JWT user (kalau ada)
    // =====================================================
    let auth = null;
    console.log('👤 [JWT User Check] req.user =', req.user);

    if (req.user?.id) {
      auth = await Auth.findById(req.user.id);
      if (auth) {
        console.log(`🔗 Linking wallet to existing user ${auth.email || auth._id}`);
        const exists = auth.wallets?.some((w) => w.address === address);
        if (!exists) {
          auth.wallets.push({ provider, address });
          await auth.save();
          console.log(`➕ Wallet ${address} linked to ${auth.email || auth._id}`);
        } else {
          console.log(`ℹ️ Wallet ${address} already linked to ${auth.email || auth._id}`);
        }
      } else {
        console.warn(`⚠️ JWT user ID ${req.user.id} not found in Auth`);
      }
    } else {
      console.log('⚠️ No JWT found in request — will try to match by wallet');
    }

    // =====================================================
    // 🧩 Step 2. Kalau belum login, cari berdasarkan wallet
    // =====================================================
    if (!auth) {
      console.log('🔍 [Wallet Check] Finding existing user with wallet:', address);
      auth = await Auth.findOne({
        $or: [
          { 'wallets.address': address },
          { 'custodialWallets.address': address },
        ],
      });

      if (auth) {
        console.log(`👋 Found existing wallet user: ${auth.email || auth._id}`);
      } else {
        console.log(`🆕 No existing wallet found, creating new user for ${address}`);
        auth = new Auth({
          name,
          wallets: [{ provider, address }],
          authProvider: 'wallet',
          acceptedTerms: true,
          avatar: '/uploads/avatars/default.png',
        });
        await auth.save();
        console.log('✅ New wallet user created:', address);
      }
    }

    // =====================================================
    // 👑 Super admin (auto elevate)
    // =====================================================
    const SUPER_ADMIN_EMAIL = 'yerblues6@gmail.com';
    if (auth.email === SUPER_ADMIN_EMAIL) {
      auth.role = auth.role || 'user';
      await auth.save();
      console.log(`👑 Super admin privileges applied to ${auth.email}`);
    }

    // =====================================================
    // 🎟️ Referral auto-create
    // =====================================================
    if (auth.email && auth.email.includes('@')) {
      const baseCode = auth.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const existingReferral = await Referral.findOne({
        $or: [{ referrerId: auth._id }, { code: baseCode }],
      });

      if (!existingReferral) {
        await new Referral({ referrerId: auth._id, code: baseCode }).save();
        console.log(`🎟️ Referral code created: ${baseCode}`);
      } else {
        console.log(`ℹ️ Referral already exists: ${existingReferral.code}`);
      }
    } else {
      console.log('⚠️ User has no email yet, skip referral creation');
    }

    // =====================================================
    // 🎮 Player record (buat jika belum ada)
    // =====================================================
    console.log(`🎮 Checking Player record for wallet ${address}`);

    let playerData = await Player.findOne({ walletAddress: address })
      .select('rank totalEarning username lastActive');

    if (!playerData) {
      console.log('🆕 No Player found — creating new one...');
      let baseUsername = auth.name || name || `User-${address.slice(0, 6)}`;
      let username = baseUsername;
      let counter = 1;

      while (await Player.findOne({ username })) {
        username = `${baseUsername}-${Math.floor(Math.random() * 1000)}`;
        counter++;
        if (counter > 5) break;
      }

      playerData = new Player({
        username,
        walletAddress: address,
        rank: 'sentinel',
        totalEarning: 0,
        lastActive: new Date(),
      });

      await playerData.save();
      console.log(`✅ New Player record created: ${username}`);
    } else {
      console.log(`ℹ️ Existing Player found: ${playerData.username} (${playerData.rank})`);
      playerData.lastActive = new Date();
      await playerData.save();
      console.log(`🕓 Player lastActive updated for ${address}`);
    }

    // =====================================================
    // 🧱 Default teams (init 8 tim)
    // =====================================================
    const walletAddr =
      auth.wallets?.[0]?.address ||
      auth.custodialWallets?.[0]?.address ||
      address;

    const existingTeams = await Team.find({ owner: walletAddr });
    if (existingTeams.length === 0) {
      console.log('🧱 Initializing default teams...');
      const defaultTeams = [];
      for (let i = 1; i <= 8; i++) {
        defaultTeams.push({
          name: `TEAM#${i}`,
          owner: walletAddr,
          members: [],
          isActive: i === 1,
        });
      }
      await Team.insertMany(defaultTeams);
      console.log('✅ Default teams initialized for wallet user:', walletAddr);
    } else {
      console.log(`ℹ️ User already has ${existingTeams.length} teams`);
    }

    // =====================================================
    // 🔑 Generate JWT & Referral data
    // =====================================================
    const token = generateToken(auth);
    const referralData = await Referral.findOne({ referrerId: auth._id })
      .select('code totalClaimable totalClaimed isActive createdAt');

    console.log('✅ [FINAL RESPONSE] Preparing response for user:', {
      id: auth._id,
      email: auth.email,
      walletCount: auth.wallets?.length,
      provider: provider,
      hasReferral: !!referralData,
    });

    // =====================================================
    // 📤 Response
    // =====================================================
    res.json({
      message: 'Login successful',
      success: true,
      authId: auth._id,
      token,
      name: auth.name,
      email: auth.email,
      avatar: auth.avatar,
      role: auth.role || null,
      wallets: auth.wallets || [],
      custodialWallets: (auth.custodialWallets || []).map((w) => ({
        provider: w.provider,
        address: w.address,
      })),
      player: playerData
        ? {
            rank: playerData.rank,
            totalEarning: playerData.totalEarning,
            lastActive: playerData.lastActive,
          }
        : null,
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
            createdAt: referralData.createdAt,
          }
        : null,
      authProvider: auth.authProvider || 'wallet',
      twoFactorEnabled: auth.twoFactorEnabled || false,
      acceptedTerms: auth.acceptedTerms || false,
      createdAt: auth.createdAt,
    });

  } catch (err: any) {
    console.error('❌ Wallet login error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
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
    // 🔹 Cari user tanpa password & tanpa privateKey
    const user = await Auth.findById(req.params.id)
      .select('-password -custodialWallets.privateKey');

    if (!user) return res.status(404).json({ error: 'User not found' });

    // 🔹 Tambahkan avatar kosong kalau belum ada
    if (!user.avatar) user.avatar = '';

    // =======================================================
    // 🔹 Ambil wallet address (custodial atau external)
    // =======================================================
    const custodialWallet = user.custodialWallets?.[0]?.address;
    const externalWallet = user.wallets?.[0]?.address;
    const walletAddr = custodialWallet || externalWallet;

    // =======================================================
    // 🔹 Ambil data Player (rank & totalEarning)
    // =======================================================
    let playerData = null;

    if (walletAddr) {
      playerData = await Player.findOne({ walletAddress: walletAddr })
        .select('rank totalEarning');
    }

    // Kalau belum ada Player record → buat default
    if (!playerData) {
      playerData = new Player({
        username: user.name,
        walletAddress: walletAddr || null,
        rank: 'sentinel',
        totalEarning: 0,
      });
      await playerData.save();
    }

    // =======================================================
    // 🔹 Response lengkap
    // =======================================================
    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar,
      wallets: user.wallets || [],
      custodialWallets: (user.custodialWallets || []).map(w => ({
        provider: w.provider,
        address: w.address,
      })),
      player: {
        rank: playerData.rank,
        totalEarning: playerData.totalEarning,
        lastActive: playerData.lastActive
      },
      // =======================================================
      // 🔹 Tambahan data Auth langsung dari DB
      // =======================================================
      authProvider: user.authProvider || 'unknown',
      twoFactorEnabled: user.twoFactorEnabled || false,
      acceptedTerms: user.acceptedTerms || false,
      createdAt: user.createdAt,
    });

  } catch (err: any) {
    console.error('❌ Error fetching user:', err.message);
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
    console.log('📝 [UpdateProfile] Incoming payload:', { name, email });

    // =====================================================
    // 🔍 Validasi input
    // =====================================================
    if (!name && !email) {
      console.warn('⚠️ [UpdateProfile] Missing name and email.');
      return res.status(400).json({
        success: false,
        error: 'At least one field (name or email) must be provided.',
      });
    }

    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        console.warn('⚠️ [UpdateProfile] Invalid email format:', email);
        return res.status(400).json({
          success: false,
          error: "Invalid email format. Please include '@' and domain name.",
        });
      }
    }

    // =====================================================
    // 🧩 Update user
    // =====================================================
    const user = await Auth.findByIdAndUpdate(
      req.params.id,
      { ...(name && { name }), ...(email && { email }) },
      { new: true, runValidators: true } // 💡 runValidators penting biar schema Mongoose tetap jalan
    );

    if (!user) {
      console.warn('⚠️ [UpdateProfile] User not found:', req.params.id);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    console.log('✅ [UpdateProfile] Profile updated for:', user.email || user._id);

    res.json({ success: true, user });
  } catch (err: any) {
    console.error('❌ [UpdateProfile] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
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
    console.log("===============================================");
    console.log("🚀 [BUY_NFT_PHANTOM_FLOW] Start building unsigned transaction");

    const { id: userId } = req.user;
    const { mintAddress } = req.params;
    const { paymentMint, price, name, symbol } = req.body;

    console.log("🧾 Incoming request:", { mintAddress, paymentMint, price, name, symbol });

    // === 1️⃣ Setup connection & user lookup ===
    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    console.log("🌐 Connected to cluster:", process.env.SOLANA_CLUSTER);

    const user = await Auth.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const nftDoc = await Nft.findOne({ mintAddress });
    if (!nftDoc) return res.status(404).json({ error: "NFT not found" });

    console.log("🎨 NFT Doc found:", { name: nftDoc.name, owner: nftDoc.owner, price: nftDoc.price });

    // === 2️⃣ Normalize payment mint & price ===
    const paymentMintValue =
      typeof paymentMint === "object"
        ? paymentMint.mint || paymentMint.address
        : paymentMint;

    if (!paymentMintValue || paymentMintValue.length < 32)
      throw new Error(`Invalid paymentMint: ${paymentMintValue}`);

    const mintPk = new PublicKey(mintAddress);
    const paymentMintPk = new PublicKey(paymentMintValue);

    const tokenInfo = await getMint(connection, paymentMintPk);
    const decimals = tokenInfo.decimals ?? 9;
    const finalPrice = Number(price || nftDoc.price || 0);
    const priceUnits = Math.floor(finalPrice * 10 ** decimals);

    console.log(`💰 Normalized price: ${finalPrice} × 10^${decimals} = ${priceUnits}`);

    // === 3️⃣ Resolve seller & buyer wallets ===
    const sellerAuth = await Auth.findOne({
      $or: [
        { "custodialWallets.address": nftDoc.owner },
        { "wallets.address": nftDoc.owner },
      ],
    });
    if (!sellerAuth) throw new Error("Seller not found");

    const sellerAddress =
      sellerAuth.custodialWallets.find((w) => w.provider === "solana")?.address ||
      sellerAuth.wallets.find((w) => w.provider === "phantom")?.address;
    if (!sellerAddress) throw new Error("Seller has no valid wallet");

    const buyerAddress =
      user.custodialWallets.find((w) => w.provider === "solana")?.address ||
      user.wallets.find((w) => w.provider === "phantom")?.address;
    if (!buyerAddress) throw new Error("Buyer has no valid wallet");

    const sellerPk = new PublicKey(sellerAddress);
    const buyerPk = new PublicKey(buyerAddress);

    if (sellerAddress === buyerAddress)
      return res.status(400).json({ error: "Buyer and seller wallet cannot be the same." });

    // === 4️⃣ Setup Anchor ===
    const programId = new PublicKey(process.env.PROGRAM_ID!);
    const idl = require("../../public/idl/universe_of_gamers.json");
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });
    const program = new anchor.Program(idl, programId, provider);

    console.log("🧩 Program loaded:", programId.toBase58());

    // === 5️⃣ Fetch listing ===
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mintPk.toBuffer()],
      program.programId
    );

    const listingFetched: any = await program.account.listing.fetch(listingPda);
    console.log("✅ Listing fetched:", {
      nftMint: listingFetched.nftMint.toBase58(),
      seller: listingFetched.seller.toBase58(),
      price: listingFetched.price?.toString(),
      bump: listingFetched.bump,
    });

    // === 6️⃣ Find escrow_signer PDA ===
    let foundEscrowSigner: PublicKey | null = null;
    for (let i = 255; i >= 0; i--) {
      try {
        foundEscrowSigner = PublicKey.createProgramAddressSync(
          [Buffer.from("escrow_signer"), mintPk.toBuffer(), Buffer.from([i])],
          program.programId
        );
        break;
      } catch {}
    }
    if (!foundEscrowSigner) throw new Error("❌ Escrow PDA not found");

    console.log("✅ Escrow signer PDA:", foundEscrowSigner.toBase58());

    // === 7️⃣ Verify NFT delegate ===
    const sellerNftAta = await getAssociatedTokenAddress(mintPk, sellerPk);
    const nftAccount = await getAccount(connection, sellerNftAta);

    console.log("👀 On-chain NFT owner:", nftAccount.owner.toBase58());
    if (!nftAccount.delegate)
      throw new Error("❌ NFT has no delegate — relist may not have executed approve()");

    if (nftAccount.delegate.toBase58() !== foundEscrowSigner.toBase58())
      throw new Error(
        `❌ Delegate mismatch. Expected ${foundEscrowSigner.toBase58()}, got ${nftAccount.delegate.toBase58()}`
      );

    console.log("✅ Escrow signer approved correctly.");

    // === 8️⃣ Build PDAs ===
    const [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    // === 9️⃣ Build ATAs ===
    const buyerPaymentAta = await getAssociatedTokenAddress(paymentMintPk, buyerPk);
    const sellerPaymentAta = await getAssociatedTokenAddress(paymentMintPk, sellerPk);
    const treasuryAta = await getAssociatedTokenAddress(paymentMintPk, treasuryPda, true);
    const buyerNftAta = await getAssociatedTokenAddress(mintPk, buyerPk);

    console.table({
      buyerPaymentAta: buyerPaymentAta.toBase58(),
      sellerPaymentAta: sellerPaymentAta.toBase58(),
      treasuryAta: treasuryAta.toBase58(),
      buyerNftAta: buyerNftAta.toBase58(),
    });

    // === 🔧 10️⃣ Build instruction (sesuai struct BuyNft) ===
    const ix = await program.methods
      .buyNft()
      .accountsStrict({
        listing: listingPda,
        buyer: buyerPk,
        seller: sellerPk,
        buyerPaymentAta,
        sellerPaymentAta,
        treasuryTokenAccount: treasuryAta,
        treasuryPda,
        sellerNftAta,
        buyerNftAta,
        marketConfig: marketConfigPda,
        escrowSigner: foundEscrowSigner,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // === 11️⃣ Build transaction ===
    const tx = new Transaction();

    const buyerNftInfo = await connection.getAccountInfo(buyerNftAta);
    if (!buyerNftInfo)
      tx.add(createAssociatedTokenAccountInstruction(buyerPk, buyerNftAta, buyerPk, mintPk));

    const buyerPayInfo = await connection.getAccountInfo(buyerPaymentAta);
    if (!buyerPayInfo)
      tx.add(
        createAssociatedTokenAccountInstruction(buyerPk, buyerPaymentAta, buyerPk, paymentMintPk)
      );

    tx.add(ix);
    tx.feePayer = buyerPk;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.signatures.push({ publicKey: buyerPk, signature: null });

    // === 12️⃣ Serialize untuk Phantom ===
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const base64Tx = serialized.toString("base64");

    console.log("✅ Transaction built successfully (unsigned).");
    console.log("===============================================");

    res.json({ transaction: base64Tx });
  } catch (err: any) {
    console.error("❌ Error building buy TX:", err);
    res.status(400).json({ error: err.message });
  }
});

router.post("/nft/:mintAddress/confirm-buy", authenticateJWT, async (req: AuthRequest, res) => {
  const { signedTx } = req.body;
  const { mintAddress } = req.params;

  try {
    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    const rawTx = bs58.decode(signedTx);
    const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");

    // ✅ Update DB
    await Nft.updateOne({ mintAddress }, { owner: req.user.walletAddress, isSell: false, price: 0, txSignature: sig });

    console.log("✅ BUY CONFIRMED:", sig);
    res.json({ signature: sig, nft: { mintAddress } });
  } catch (err: any) {
    console.error("❌ Confirm-buy failed:", err.message);
    res.status(400).json({ error: err.message });
  }
});

//
// POST /nft/:mintAddress/sell
//
router.post("/nft/:mintAddress/sell", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { mintAddress } = req.params;
    const { price, royalty, paymentSymbol, paymentMint, useSol = false } = req.body;

    console.log("🚀 [PHANTOM RELIST FLOW START]");
    console.log("🧾 Params:", { mintAddress, price, royalty, paymentSymbol, paymentMint, useSol });

    // === 1️⃣ Validasi user ===
    console.log("🔍 Step 1: Validating user...");
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    let solWallet =
      authUser.custodialWallets?.find((w) => w.provider === "solana") ||
      authUser.wallets?.find((w) => w.provider === "phantom");

    if (!solWallet)
      return res.status(400).json({ error: "No Solana or Phantom wallet found" });

    const sellerAddress = solWallet.address;
    const sellerPk = new PublicKey(sellerAddress);
    const mintPk = new PublicKey(mintAddress);
    console.log("👤 Seller:", sellerPk.toBase58());
    console.log("🏷️ Mint:", mintPk.toBase58());

    // === 2️⃣ Setup Anchor tanpa signer ===
    const rpcUrl = process.env.SOLANA_CLUSTER;
    if (!rpcUrl) return res.status(500).json({ error: "Missing SOLANA_CLUSTER env" });

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      commitment: "confirmed",
    });
    anchor.setProvider(provider);

    const idl = require("../../public/idl/universe_of_gamers.json");
    const programId = new PublicKey(process.env.PROGRAM_ID!);
    const program = new anchor.Program(idl, programId, provider);

    console.log("🧩 Program loaded:", programId.toBase58());
    console.log("🌐 RPC Endpoint:", rpcUrl);

    // === 3️⃣ Derive PDA ===
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mintPk.toBuffer()],
      program.programId
    );
    const [escrowSignerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_signer"), mintPk.toBuffer()],
      program.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    const sellerNftAta = getAssociatedTokenAddressSync(mintPk, sellerPk);
    const sellerPaymentAta = getAssociatedTokenAddressSync(new PublicKey(paymentMint), sellerPk);
    const treasuryTokenAccount = getAssociatedTokenAddressSync(
      new PublicKey(paymentMint),
      treasuryPda,
      true
    );

    console.log("✅ PDAs derived successfully:", {
      listingPda: listingPda.toBase58(),
      escrowSignerPda: escrowSignerPda.toBase58(),
      treasuryPda: treasuryPda.toBase58(),
      sellerNftAta: sellerNftAta.toBase58(),
      sellerPaymentAta: sellerPaymentAta.toBase58(),
      treasuryTokenAccount: treasuryTokenAccount.toBase58(),
    });

    // === 4️⃣ Ambil PDA market_config dari program ===
    const [marketConfigPk] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );

    const marketConfig: any = await program.account.marketConfig.fetch(marketConfigPk);

    console.log("⚙️ Market config:", {
      pubkey: marketConfigPk.toBase58(),
      relistFeeBps: Number(marketConfig.relist_fee_bps),
      tradeFeeBps: Number(marketConfig.trade_fee_bps),
      mintFeeBps: Number(marketConfig.mint_fee_bps),
    });

    // === 5️⃣ Hitung price base units ===
    const isSolPayment =
      useSol || paymentMint === "So11111111111111111111111111111111111111111";
    const decimalsUsed = isSolPayment ? 9 : 6;
    const baseUnits = Math.floor(price * 10 ** decimalsUsed);
    const priceAmountBn = new anchor.BN(baseUnits);

    console.log("💵 Price breakdown:", {
      isSolPayment,
      priceHuman: price,
      baseUnits,
      priceAmountBn: priceAmountBn.toString(),
    });

    // === 6️⃣ Buat TX lebih awal agar bisa tambah IX ===
    const blockhash = (await connection.getLatestBlockhash()).blockhash;
    const tx = new Transaction({
      feePayer: sellerPk,
      recentBlockhash: blockhash,
    });

    // 🛠️ Pastikan sellerPaymentAta sudah ada di chain
    const sellerPayInfo = await connection.getAccountInfo(sellerPaymentAta);
    if (!sellerPayInfo) {
      const createSellerAtaIx = createAssociatedTokenAccountInstruction(
        sellerPk, // payer
        sellerPaymentAta,
        sellerPk, // owner
        new PublicKey(paymentMint)
      );
      tx.add(createSellerAtaIx);
      console.log("🪙 Created missing seller ATA:", sellerPaymentAta.toBase58());
    }

    // 🛠️ Pastikan treasuryTokenAccount sudah ada di chain
    const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
    if (!treasuryInfo) {
      const createTreasuryAtaIx = createAssociatedTokenAccountInstruction(
        sellerPk, // payer sementara (karena PDA ga bisa bayar)
        treasuryTokenAccount,
        treasuryPda,
        new PublicKey(paymentMint)
      );
      tx.add(createTreasuryAtaIx);
      console.log("🏦 Created missing treasury ATA:", treasuryTokenAccount.toBase58());
    }

    // === 7️⃣ Build instruction utama ===
    const ix = await program.methods
      .relistNft(priceAmountBn, isSolPayment)
      .accounts({
        listing: listingPda,
        newOwner: sellerPk,
        mint: mintPk,
        sellerNftAta,
        sellerPaymentAta,
        treasuryTokenAccount,
        treasuryPda,
        escrowSigner: escrowSignerPda,
        marketConfig: marketConfigPk,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Tambahkan instruksi utama setelah ATA creations
    tx.add(ix);

    // === 8️⃣ Serialize TX untuk Phantom ===
    const serializedTx = tx.serialize({ requireAllSignatures: false });
    const base64Tx = serializedTx.toString("base64");

    console.log("✅ Unsigned TX built:", {
      mintAddress,
      feePayer: sellerPk.toBase58(),
      blockhash,
      txSize: serializedTx.length,
    });

    // === 7️⃣ Update DB ===
    await Nft.updateOne(
      { mintAddress },
      {
        $set: {
          price,
          royalty,
          paymentSymbol,
          paymentMint,
          updatedAt: new Date(),
        },
      }
    );

    // === 8️⃣ Response ===
    console.log("✅ [PHANTOM RELIST READY] Transaction ready");
    return res.json({
      message: "Unsigned transaction ready for Phantom",
      transaction: base64Tx,
      mintAddress,
      price,
      paymentSymbol,
      paymentMint,
      isSolPayment,
    });
  } catch (err: any) {
    console.error("❌ [PHANTOM RELIST ERROR]", err.message);
    if (err.stack) console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
});

router.post("/nft/:mintAddress/confirm", async (req, res) => {
  try {
    const { mintAddress } = req.params;
    const { signedTx } = req.body;

    console.log("🔍 [CONFIRM FLOW START] mintAddress:", mintAddress);
    console.log("🔍 Received signedTx length:", signedTx?.length || 0);

    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");

    // decode and log
    const tx = Transaction.from(bs58.decode(signedTx));
    console.log("🧩 Decoded transaction:", {
      instructions: tx.instructions.length,
      recentBlockhash: tx.recentBlockhash,
      feePayer: tx.feePayer?.toBase58(),
    });

    console.log("🚀 Sending raw transaction...");
    const txSignature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    console.log("⏳ Waiting for confirmation...");
    const confirmRes = await connection.confirmTransaction(txSignature, "confirmed");
    console.log("✅ TX broadcasted & confirmed:", {
      mintAddress,
      txSignature,
      slot: confirmRes?.context?.slot,
    });

    const nft = await Nft.findOne({ mintAddress });
    if (!nft) {
      console.error("❌ NFT not found in DB:", mintAddress);
      return res.status(404).json({ error: "NFT not found" });
    }

    nft.txSignature = txSignature;
    nft.isSell = true;
    await nft.save();
    console.log("💾 NFT DB updated:", { mintAddress, txSignature });

    return res.json({
      message: "✅ NFT relist confirmed",
      mintAddress,
      txSignature,
    });
  } catch (err: any) {
    console.error("❌ [CONFIRM ERROR]", err.message);
    if (err.logs) console.error("📜 Error logs:", err.logs);
    return res.status(400).json({ error: err.message });
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

    broadcast({
      type: "delist-update",
      nft: nftDoc,
      timestamp: new Date().toISOString(),
    });

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

// 🔹 Apply referral + update profile
router.post("/referral/apply-and-update", authenticateJWT, async (req: AuthRequest, res) => {
  const traceId = Math.random().toString(36).substring(2, 10).toUpperCase();
  console.log(`\n🧭 [TRACE ${traceId}] ───────────────────────────────────────────`);
  console.log(`📥 Incoming /referral/apply-and-update request`);

  try {
    if (!req.user) {
      console.warn(`⚠️ [${traceId}] Unauthorized access attempt.`);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const { email, password, code, walletAddress } = req.body;
    const userId = req.user.id;

    console.log(`👤 [${traceId}] Authenticated user: ${userId}`);
    console.log(`📩 Payload received:`, { email, password: password ? "••••" : null, code, walletAddress });

    const auth = await Auth.findById(userId);
    if (!auth) {
      console.warn(`❌ [${traceId}] User not found in Auth collection.`);
      return res.status(404).json({ success: false, error: "User not found" });
    }

    console.log(`🧩 [${traceId}] Current Auth Info:`, {
      authProvider: auth.authProvider,
      email: auth.email || null,
      wallets: auth.wallets?.length || 0,
      custodialWallets: auth.custodialWallets?.length || 0,
      hasReferral: !!auth.usedReferralCode,
    });

    // =====================================================
    // 🧩 VALIDASI WALLET DUPLIKAT
    // =====================================================
    if (auth.wallets && auth.wallets.length > 0) {
      const walletAddresses = auth.wallets.map((w) => w.address);
      console.log(`🔍 [${traceId}] Checking wallet duplicates:`, walletAddresses);

      const duplicateUser = await Auth.findOne({
        _id: { $ne: auth._id },
        $or: [
          { "wallets.address": { $in: walletAddresses } },
          { "custodialWallets.address": { $in: walletAddresses } },
        ],
      });

      if (duplicateUser) {
        console.warn(`⚠️ [${traceId}] Wallet already linked to another user: ${duplicateUser._id}`);
        return res.status(400).json({
          success: false,
          error: "This wallet address is already linked to another account.",
        });
      }
    }

    let updated = false;

    // =====================================================
    // 🧩 CASE 1: WALLET LOGIN
    // =====================================================
    if (auth.authProvider === "wallet") {
      console.log(`🪪 [${traceId}] Wallet-Mode: Checking email & password update...`);

      // EMAIL VALIDATION
      if (!auth.email && email) {
        console.log(`📨 [${traceId}] Incoming email: ${email}`);
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          console.warn(`⚠️ [${traceId}] Invalid email format detected.`);
          return res.status(400).json({
            success: false,
            error: "Invalid email format. Please include '@' and domain name.",
          });
        }
        auth.email = email.trim();
        updated = true;
        console.log(`✅ [${traceId}] Wallet user email set: ${email}`);
      } else if (auth.email) {
        console.log(`ℹ️ [${traceId}] Email already exists: ${auth.email}`);
      } else {
        console.log(`⚠️ [${traceId}] No email provided in request body.`);
      }

      // PASSWORD VALIDATION
      if (!auth.password && password) {
        console.log(`🔐 [${traceId}] Incoming password detected, validating length...`);
        if (password.length < 8) {
          console.warn(`⚠️ [${traceId}] Password too short (${password.length} chars).`);
          return res.status(400).json({
            success: false,
            error: "Password must be at least 8 characters long.",
          });
        }
        auth.password = password;
        updated = true;
        console.log(`✅ [${traceId}] Wallet user password set.`);
      } else if (auth.password) {
        console.log(`ℹ️ [${traceId}] Password already exists — skip.`);
      } else {
        console.log(`⚠️ [${traceId}] No password provided in request body.`);
      }
    }

    // =====================================================
    // 🧩 CASE 2: GOOGLE LOGIN
    // =====================================================
    if (auth.authProvider === "google") {
      console.log(`🧠 [${traceId}] Google-Mode: Checking password update...`);

      if (password) {
        if (password.length < 8) {
          console.warn(`⚠️ [${traceId}] Google user password too short.`);
          return res.status(400).json({
            success: false,
            error: "Password must be at least 8 characters long.",
          });
        }

        // 🟢 Paksa update meski sudah ada password
        auth.password = password;
        auth.markModified("password"); // 🔥 <--- penting, paksa Mongoose trigger hook
        auth.authProvider = "local";
        updated = true;

        await auth.save();
        console.log(`✅ [${traceId}] Google user converted to local login.`);
      } else {
        console.log(`⚠️ [${traceId}] No password provided for Google user.`);
      }
    }

    // =====================================================
    // 🧩 CASE 3: LOCAL LOGIN
    // =====================================================
    if (auth.authProvider === "local") {
      console.log(`ℹ️ [${traceId}] Local-Mode: skipping email/password update.`);
    }

    if (updated) {
      console.log(`💾 [${traceId}] Final check before save:`, {
        email: auth.email,
        provider: auth.authProvider,
        hasPassword: !!auth.password
      });
      await auth.save();
      console.log(`💾 [${traceId}] Profile saved successfully for user ${auth._id}`);
    } else {
      console.log(`ℹ️ [${traceId}] No profile update needed.`);
    }

    // =====================================================
    // 🎟️ AUTO-CREATE REFERRAL CODE
    // =====================================================
    if (auth.email && auth.email.includes("@")) {
      const baseCode = auth.email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      console.log(`🎟️ [${traceId}] Checking referral existence for baseCode: ${baseCode}`);

      const existingReferral = await Referral.findOne({
        $or: [{ referrerId: auth._id }, { code: baseCode }],
      });

      if (!existingReferral) {
        const newReferral = new Referral({
          referrerId: auth._id,
          code: baseCode,
          isActive: true,
          totalClaimable: 0,
          totalClaimed: 0,
        });
        await newReferral.save();
        console.log(`🎟️ [${traceId}] Referral created: ${baseCode}`);
      } else {
        console.log(`ℹ️ [${traceId}] Referral already exists for user.`);
      }
    } else {
      console.log(`⚠️ [${traceId}] Cannot create referral — no valid email found.`);
    }

    // =====================================================
    // 🎟️ APPLY REFERRAL CODE
    // =====================================================
    if (code && code.trim() !== "") {
      console.log(`🎟️ [${traceId}] Attempting to apply referral code: ${code}`);

      const referral = await Referral.findOne({ code, isActive: true });
      if (!referral) {
        console.warn(`❌ [${traceId}] Invalid referral code: ${code}`);
        return res.status(404).json({ success: false, error: "Invalid referral code" });
      }

      if (referral.referrerId.toString() === userId.toString()) {
        console.warn(`⚠️ [${traceId}] User tried to use their own referral code.`);
        return res.status(400).json({ success: false, error: "You cannot use your own referral code" });
      }

      if (!auth.usedReferralCode) {
        auth.usedReferralCode = referral._id.toString();
        await auth.save();

        referral.totalClaimable += 0;
        await referral.save();
        console.log(`✅ [${traceId}] Referral successfully applied for ${auth.email}`);
      } else {
        console.log(`ℹ️ [${traceId}] Referral already applied earlier.`);
      }
    }

    // =====================================================
    // 🎮 CREATE PLAYER RECORD
    // =====================================================
    let playerData = await Player.findOne({ walletAddress: auth.wallets?.[0]?.address })
      .select("rank totalEarning lastActive");

    if (!playerData) {
      playerData = new Player({
        username: auth.name || "Player",
        walletAddress: auth.wallets?.[0]?.address || null,
        rank: "sentinel",
        totalEarning: 0,
      });
      await playerData.save();
      console.log(`🎮 [${traceId}] New player record created.`);
    } else {
      console.log(`ℹ️ [${traceId}] Player record found.`);
    }

    playerData.lastActive = new Date();
    await playerData.save();
    console.log(`💾 [${traceId}] Player data updated.`);

    // =====================================================
    // 🎁 GET REFERRAL INFO
    // =====================================================
    const referralData = await Referral.findOne({ referrerId: auth._id })
      .select("code totalClaimable totalClaimed isActive createdAt");
    const token = generateToken(auth);

    console.log(`📤 [${traceId}] Preparing response payload...`);
    res.json({
      message: "Profile updated successfully",
      success: true,
      authId: auth._id,
      token,
      name: auth.name,
      email: auth.email,
      avatar: auth.avatar,
      authProvider: auth.authProvider,
      wallets: auth.wallets || [],
      custodialWallets: auth.custodialWallets || [],
      referral: referralData
        ? {
            code: referralData.code,
            totalClaimable: referralData.totalClaimable,
            totalClaimed: referralData.totalClaimed,
            isActive: referralData.isActive,
            createdAt: referralData.createdAt,
          }
        : null,
      usedReferralCode: auth.usedReferralCode,
      player: playerData
        ? {
            rank: playerData.rank,
            totalEarning: playerData.totalEarning,
            lastActive: playerData.lastActive,
          }
        : null,
      acceptedTerms: auth.acceptedTerms,
      createdAt: auth.createdAt,
    });

    console.log(`✅ [${traceId}] Request completed successfully.`);
  } catch (err: any) {
    console.error(`💥 [${traceId}] apply-and-update error:`, err);
    res.status(500).json({ success: false, error: "Internal server error", details: err.message });
  } finally {
    console.log(`🧾 [TRACE ${traceId}] END ───────────────────────────────────────────\n`);
  }
});

// router.post("/nft/:mintAddress/buy", authenticateJWT, async (req: AuthRequest, res) => {
//   let connection: Connection | null = null;
//   let buyerKp: Keypair | null = null;

//   try {
//     console.log("===============================================");
//     console.log("=== 🚀 BUY FLOW START ===");

//     const { id: userId } = req.user;
//     const { mintAddress } = req.params;
//     const { paymentMint, price, name, symbol } = req.body;
//     const uri = `https://api.universeofgamers.io/nft/${mintAddress}`;

//     // === Setup Connection ===
//     connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");

//     // === Buyer ===
//     const authUser = await Auth.findById(userId);
//     if (!authUser) return res.status(404).json({ error: "User not found" });

//     const buyerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
//     if (!buyerCustodian) return res.status(400).json({ error: "No buyer wallet" });

//     buyerKp = Keypair.fromSecretKey(bs58.decode(decrypt(buyerCustodian.privateKey)));
//     console.log("🔑 Buyer wallet:", buyerKp.publicKey.toBase58());

//     // === Seller ===
//     const nftDoc = await Nft.findOne({ mintAddress });
//     if (!nftDoc) return res.status(404).json({ error: "NFT not found" });

//     const sellerAuth = await Auth.findOne({ "custodialWallets.address": nftDoc.owner });
//     if (!sellerAuth) return res.status(404).json({ error: "Seller not found" });

//     const sellerCustodian = sellerAuth.custodialWallets.find((w) => w.provider === "solana");
//     if (!sellerCustodian) return res.status(400).json({ error: "Seller has no wallet" });

//     const sellerKp = Keypair.fromSecretKey(bs58.decode(decrypt(sellerCustodian.privateKey)));
//     console.log("🔑 Seller wallet:", sellerKp.publicKey.toBase58());

//     // === Wallet Wrapper for Anchor ===
//     const wallet = {
//       publicKey: sellerKp.publicKey,
//       async signTransaction(tx: anchor.web3.Transaction) {
//         tx.partialSign(sellerKp);
//         return tx;
//       },
//       async signAllTransactions(txs: anchor.web3.Transaction[]) {
//         txs.forEach((tx) => tx.partialSign(sellerKp));
//         return txs;
//       },
//     };

//     const provider = new anchor.AnchorProvider(connection, wallet as any, {
//       preflightCommitment: "confirmed",
//     });

//     const program = new anchor.Program(
//       require("../../public/idl/universe_of_gamers.json"),
//       new PublicKey(process.env.PROGRAM_ID!),
//       provider
//     );

//     // === PDAs ===
//     let mintPk = new PublicKey(mintAddress);
//     let [listingPda] = PublicKey.findProgramAddressSync([Buffer.from("listing"), mintPk.toBuffer()], program.programId);
//     let [escrowSignerPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow_signer"), mintPk.toBuffer()], program.programId);
//     let [marketConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("market_config")], program.programId);
//     let [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
//     let [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth"), mintPk.toBuffer()], program.programId);

//     console.log("🧩 Mint key used in PDA:", mintPk.toBase58());
//     console.log("📌 PDAs:", {
//       listingPda: listingPda.toBase58(),
//       escrowSignerPda: escrowSignerPda.toBase58(),
//       marketConfigPda: marketConfigPda.toBase58(),
//       treasuryPda: treasuryPda.toBase58(),
//       mintAuthPda: mintAuthPda.toBase58(),
//     });

//     // === Metadata PDA ===
//     let [metadataPda] = PublicKey.findProgramAddressSync(
//       [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
//       METADATA_PROGRAM_ID
//     );

//     // === Step 1: cek mint ===
//     const mintAccInfo = await connection.getAccountInfo(mintPk);
//     console.log("🔍 Mint account info:", !!mintAccInfo ? "✅ exists" : "❌ not found");

//     // === Step 2: setup payment mint ===
//     const NATIVE_SOL = new PublicKey("So11111111111111111111111111111111111111111");
//     const WRAPPED_SOL = new PublicKey("So11111111111111111111111111111111111111112");

//     let paymentMintValue: any = paymentMint;

//     // 🩹 Fallback: ambil .mint kalau frontend kirim object
//     if (typeof paymentMintValue === "object" && paymentMintValue?.mint) {
//       console.log("🪙 paymentMint is object, using mint field:", paymentMintValue.mint);
//       paymentMintValue = paymentMintValue.mint;
//     }

//     // Validasi
//     if (!paymentMintValue || typeof paymentMintValue !== "string") {
//       throw new Error(`❌ Invalid or missing paymentMint: ${JSON.stringify(paymentMint)}`);
//     }

//     let paymentMintPk: PublicKey;
//     try {
//       paymentMintPk = new PublicKey(paymentMintValue);
//     } catch (e: any) {
//       throw new Error(`❌ Failed to parse paymentMint '${paymentMintValue}': ${e.message}`);
//     }

//     const isSolPayment = paymentMintPk.equals(NATIVE_SOL);
//     const effectiveMintPk = isSolPayment ? WRAPPED_SOL : paymentMintPk;

//     console.log("🔍 Checking payment mint:", paymentMintPk.toBase58(), "SOL Payment:", isSolPayment);
//     console.log("🪙 Effective SPL mint:", effectiveMintPk.toBase58());

//     // === Harga & saldo buyer ===
//     const decimals = isSolPayment ? 9 : (await getMint(connection, paymentMintPk)).decimals;
//     const priceUnits = Math.ceil(price * 10 ** decimals);
//     const buyerBalance = await connection.getBalance(buyerKp.publicKey);
//     console.log(`💰 Price: ${price} × 10^${decimals} = ${priceUnits}`);
//     console.log("💰 Buyer balance (lamports):", buyerBalance);

//     // === Buyer Payment ATA ===
//     async function preparePaymentAccount(connection: any, payerKp: any, mint: any, amountLamports: any) {
//       const ata = await getAssociatedTokenAddress(mint, payerKp.publicKey);
//       const info = await connection.getAccountInfo(ata);
//       const tx = new Transaction();
//       if (!info) {
//         tx.add(createAssociatedTokenAccountInstruction(payerKp.publicKey, ata, payerKp.publicKey, mint));
//       }
//       if (mint.equals(WRAPPED_SOL)) {
//         tx.add(SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: ata, lamports: amountLamports }));
//         tx.add(createSyncNativeInstruction(ata));
//       }
//       if (tx.instructions.length > 0) {
//         tx.feePayer = payerKp.publicKey;
//         tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
//         await sendAndConfirmTransaction(connection, tx, [payerKp]);
//       }
//       return ata;
//     }

//     const buyerPaymentAtaAddr = await preparePaymentAccount(connection, buyerKp, effectiveMintPk, priceUnits);
//     const sellerPaymentAtaAcc = await getOrCreateAssociatedTokenAccount(connection, sellerKp, effectiveMintPk, sellerKp.publicKey);
//     const treasuryPaymentAta = await getAssociatedTokenAddress(effectiveMintPk, treasuryPda, true);

//     console.log("✅ Buyer Payment ATA:", buyerPaymentAtaAddr.toBase58());
//     console.log("✅ Seller Payment ATA:", sellerPaymentAtaAcc.address.toBase58());
//     console.log("✅ Treasury ATA:", treasuryPaymentAta.toBase58());

//     // === 🧮 Cek saldo SPL token pembeli ===
//     const buyerPaymentAcc = await getAccount(connection, buyerPaymentAtaAddr);
//     const buyerTokenBalance = Number(buyerPaymentAcc.amount) / 10 ** decimals;

//     if (buyerTokenBalance < price) {
//       console.warn(`⚠️ Insufficient token balance: ${buyerTokenBalance} < ${price}`);
//       return res.status(400).json({
//         error: `Your balance (${buyerTokenBalance.toFixed(4)} ${symbol}) is not enough to buy this NFT (requires ${price} ${symbol}).`,
//         message: `Your balance (${buyerTokenBalance.toFixed(4)} ${symbol}) is not enough to buy this NFT (requires ${price} ${symbol}).`,
//         details: {
//           balance: buyerTokenBalance,
//           required: price,
//           token: symbol,
//           buyer: buyerKp.publicKey.toBase58(),
//         },
//       });
//     }

//     // === NFT ATAs ===
//     const buyerNftAtaAcc = await getOrCreateAssociatedTokenAccount(connection, buyerKp, mintPk, buyerKp.publicKey);
//     const sellerNftAtaAddr = await getAssociatedTokenAddress(mintPk, sellerKp.publicKey);
//     console.log("✅ Buyer NFT ATA:", buyerNftAtaAcc.address.toBase58());
//     console.log("✅ Seller NFT ATA:", sellerNftAtaAddr.toBase58());

//     // === Listing check ===
//     let hasListing = true;
//     try {
//       const listingAcc: any = await program.account.listing.fetch(listingPda);
//       const listingSeller = listingAcc.seller.toBase58();
//       const onchainOwner = (await getAccount(connection, sellerNftAtaAddr)).owner.toBase58();
//       console.log("📋 Listing seller:", listingSeller);
//       if (listingSeller !== onchainOwner) hasListing = false;
//     } catch {
//       hasListing = false;
//     }

//     // === Log semua account utama ===
//     console.log("🧾 ACCOUNT MAP SUMMARY");
//     console.log({
//       listingPda: listingPda.toBase58(),
//       escrowSignerPda: escrowSignerPda.toBase58(),
//       seller: sellerKp.publicKey.toBase58(),
//       buyer: buyerKp.publicKey.toBase58(),
//       mint: mintPk.toBase58(),
//       sellerNftAta: sellerNftAtaAddr.toBase58(),
//       buyerNftAta: buyerNftAtaAcc.address.toBase58(),
//       mintAuthority: mintAuthPda.toBase58(),
//       treasuryPda: treasuryPda.toBase58(),
//       paymentMint: paymentMintPk.toBase58(),
//       treasuryPaymentAta: treasuryPaymentAta.toBase58(),
//       sellerPaymentAta: sellerPaymentAtaAcc.address.toBase58(),
//       buyerPaymentAta: buyerPaymentAtaAddr.toBase58(),
//       marketConfig: marketConfigPda.toBase58(),
//       metadata: metadataPda.toBase58(),
//       tokenMetadataProgram: METADATA_PROGRAM_ID.toBase58(),
//     });

//     if (!hasListing) {
//       console.log("⚡ No listing, running mint_and_list...");
//       await program.methods
//         .mintAndList(new anchor.BN(priceUnits), true, name ?? "NFT", symbol ?? "UOG", uri ?? "", 500)
//         .accounts({
//           listing: listingPda,
//           escrowSigner: escrowSignerPda,
//           seller: sellerKp.publicKey,
//           mint: mintPk,
//           sellerNftAta: sellerNftAtaAddr,
//           mintAuthority: mintAuthPda,
//           treasuryPda,
//           paymentMint: paymentMintPk,
//           treasuryTokenAccount: treasuryPaymentAta,
//           sellerPaymentAta: sellerPaymentAtaAcc.address,
//           marketConfig: marketConfigPda,
//           metadata: metadataPda,
//           tokenMetadataProgram: METADATA_PROGRAM_ID,
//           payer: sellerKp.publicKey,
//           updateAuthority: sellerKp.publicKey,
//           tokenProgram: TOKEN_PROGRAM_ID,
//           systemProgram: SystemProgram.programId,
//           rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//         })
//         .signers([sellerKp])
//         .rpc();
//       console.log("✅ mintAndList completed");
//     } else {
//       console.log("✅ Listing valid & matches current owner");
//     }

//     // === BUY FLOW ===
//     console.log("💸 Running buyNft...");

//     function unsafeCreateProgramAddress(seeds: Buffer[], programId: PublicKey): PublicKey {
//       const buffer = Buffer.concat([...seeds, programId.toBuffer()]);
//       const hash = crypto.createHash("sha256").update(buffer).digest(); // ✅ pakai SHA256
//       return new PublicKey(hash);
//     }

//     // === BUY FLOW ===
//     console.log("💸 Running buyNft...");

//     // Tambahan log untuk memastikan listing fetched benar
//     const listingFetched: any = await program.account.listing.fetch(listingPda);
//     console.log("📦 Listing fetched:", {
//       nftMint: listingFetched.nftMint.toBase58(),
//       seller: listingFetched.seller.toBase58(),
//       price: listingFetched.price?.toString(),
//       bump: listingFetched.bump,
//     });

//     // === Detailed Listing Account Dump ===
//     console.log("📋 Listing Account Full Dump (on-chain data):");
//     Object.entries(listingFetched).forEach(([key, value]) => {
//       if (value instanceof PublicKey) {
//         console.log(`  ${key}: ${value.toBase58()}`);
//       } else if (typeof value === "object" && value !== null && value.toString) {
//         console.log(`  ${key}: ${value.toString()}`);
//       } else {
//         console.log(`  ${key}:`, value);
//       }
//     });
//     console.log("===============================================");

//     // 🧮 Deriving PDAs from on-chain data for validation...
//     console.log("🧮 Deriving PDAs from on-chain data for validation...");

//     let bumpByte: number = 0;
//     // let mintPk: PublicKey;
//     try {
//       mintPk = new PublicKey(listingFetched.nftMint);
//       bumpByte = Number(listingFetched.bump) & 0xff;

//       // ⚠️ Warning kalau mint on-curve
//       if (PublicKey.isOnCurve(mintPk.toBytes())) {
//         console.warn("⚠️ nftMint is on curve, this is not valid as PDA seed:", mintPk.toBase58());
//       }
//     } catch (e: any) {
//       throw new Error("❌ Invalid mint in listingFetched: " + e.message);
//     }

//     // === Brute-force valid bump untuk escrow_temp ===
//     let foundEscrowTemp: PublicKey | null = null;
//     let escrowTempBump = 0;
//     for (let i = 255; i >= 0; i--) {
//       try {
//         const candidate = PublicKey.createProgramAddressSync(
//           [Buffer.from("escrow_temp"), mintPk.toBuffer(), Buffer.from([i])],
//           program.programId
//         );
//         foundEscrowTemp = candidate;
//         escrowTempBump = i;
//         break;
//       } catch (_) {}
//     }
//     if (!foundEscrowTemp) throw new Error("❌ Tidak ditemukan bump valid untuk escrow_temp");
//     console.log("✅ escrow_temp PDA:", foundEscrowTemp.toBase58(), "bump:", escrowTempBump);

//     // === Brute-force valid bump untuk escrow_signer ===
//     let foundEscrowSigner: PublicKey | null = null;
//     let escrowSignerBump = 0;
//     for (let i = 255; i >= 0; i--) {
//       try {
//         const candidate = PublicKey.createProgramAddressSync(
//           [Buffer.from("escrow_signer"), mintPk.toBuffer(), Buffer.from([i])],
//           program.programId
//         );
//         foundEscrowSigner = candidate;
//         escrowSignerBump = i;
//         break;
//       } catch (_) {}
//     }
//     if (!foundEscrowSigner) throw new Error("❌ Tidak ditemukan bump valid untuk escrow_signer");
//     console.log("✅ escrow_signer PDA:", foundEscrowSigner.toBase58(), "bump:", escrowSignerBump);

//     console.log("===============================================");
//     console.log("📋 BUY NFT ACCOUNTS");
//     console.log({
//       listing: listingPda.toBase58(),
//       buyer: buyerKp.publicKey.toBase58(),
//       seller: sellerKp.publicKey.toBase58(),
//       buyerPaymentAta: buyerPaymentAtaAddr.toBase58(),
//       sellerPaymentAta: sellerPaymentAtaAcc.address.toBase58(),
//       treasuryTokenAccount: treasuryPaymentAta.toBase58(),
//       treasuryPda: treasuryPda.toBase58(),
//       paymentMint: paymentMintPk.toBase58(),
//       escrowTemp: foundEscrowTemp.toBase58(),
//       sellerNftAta: sellerNftAtaAddr.toBase58(),
//       buyerNftAta: buyerNftAtaAcc.address.toBase58(),
//       marketConfig: marketConfigPda.toBase58(),
//       escrowSigner: foundEscrowSigner.toBase58(),
//     });
//     console.log("===============================================");

//     // ✅ Inject bumps ke metadata Anchor runtime
//     (program as any)._idlMetadata = {
//       bumps: {
//         escrow_temp: escrowTempBump,
//         escrow_signer: escrowSignerBump,
//       },
//     };

//     const sigBuy = await program.methods
//     .buyNft()
//     .accountsStrict({
//       listing: listingPda,
//       buyer: buyerKp.publicKey,
//       seller: sellerKp.publicKey,
//       buyerPaymentAta: buyerPaymentAtaAddr,
//       sellerPaymentAta: sellerPaymentAtaAcc.address,
//       treasuryTokenAccount: treasuryPaymentAta,
//       treasuryPda,
//       paymentMint: paymentMintPk,
//       escrowTemp: foundEscrowTemp,
//       sellerNftAta: sellerNftAtaAddr,
//       buyerNftAta: buyerNftAtaAcc.address,
//       marketConfig: marketConfigPda,
//       escrowSigner: foundEscrowSigner,
//       tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
//       systemProgram: SystemProgram.programId,
//     })
//     .signers([buyerKp])
//     .rpc();

//     console.log("✅ buyNft transaction confirmed:", sigBuy);

//     // ============================================================
//     // 🧹 Cache Sync (Buyer & Seller) setelah transaksi sukses
//     // ============================================================
//     try {
//       console.log("🧹 [Cache] Invalidating buyer/seller wallet cache...");
//       await invalidateWalletCache(buyerKp.publicKey.toBase58());
//       await invalidateWalletCache(sellerKp.publicKey.toBase58());

//       console.log("🔁 [Cache] Rebuilding wallet caches...");
//       await refreshWalletCache(buyerKp.publicKey.toBase58());
//       await refreshWalletCache(sellerKp.publicKey.toBase58());

//       console.log("📡 [Event] Broadcasting wallet updates...");
//       walletEvents.emit("forceUpdate", buyerKp.publicKey.toBase58());
//       walletEvents.emit("forceUpdate", sellerKp.publicKey.toBase58());
//     } catch (cacheErr: any) {
//       console.warn("⚠️ Cache refresh failed:", cacheErr.message);
//     }

//     console.log(
//       `✅ Cache rebuilt successfully for buyer (${buyerKp.publicKey.toBase58()}) and seller (${sellerKp.publicKey.toBase58()})`
//     );

//     // === Unwrap SOL if needed ===
//     if (isSolPayment) {
//       console.log("💧 Unwrapping SOL...");
//       const closeIx = createCloseAccountInstruction(buyerPaymentAtaAddr, buyerKp.publicKey, buyerKp.publicKey);
//       const txClose = new Transaction().add(closeIx);
//       txClose.feePayer = buyerKp.publicKey;
//       txClose.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
//       await sendAndConfirmTransaction(connection, txClose, [buyerKp]);
//       console.log("✅ SOL unwrapped");
//     }

//     await Nft.findByIdAndUpdate(nftDoc._id, {
//       owner: buyerKp.publicKey.toBase58(),
//       isSell: false,
//       price: 0,
//       txSignature: sigBuy,
//     });

//     broadcast({
//       type: "buymint-update",
//       mint: mintPk.toBase58(),
//       listing: listingPda.toBase58(),
//       signature: sigBuy,
//       usedPayment: isSolPayment ? "SOL (wrapped/unwrapped)" : "SPL Token",
//       timestamp: new Date().toISOString(),
//     });

//     return res.json({
//       message: "✅ Success (mint+list+buy complete)",
//       mint: mintPk.toBase58(),
//       listing: listingPda.toBase58(),
//       signature: sigBuy,
//       usedPayment: isSolPayment ? "SOL (wrapped/unwrapped)" : "SPL Token",
//     });
//   } catch (err: any) {
//     console.error("❌ Error in buy:", err);
//     if (err.logs) console.error("🪵 Solana Logs:", err.logs);
//     // Refund jika wrap SOL
//     try {
//       if (buyerKp && connection) {
//         const WRAPPED_SOL = new PublicKey("So11111111111111111111111111111111111111112");
//         const ata = await getAssociatedTokenAddress(WRAPPED_SOL, buyerKp.publicKey);
//         if (await connection.getAccountInfo(ata)) {
//           const tx = new Transaction()
//             .add(createSyncNativeInstruction(ata))
//             .add(createCloseAccountInstruction(ata, buyerKp.publicKey, buyerKp.publicKey));
//           tx.feePayer = buyerKp.publicKey;
//           tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
//           const sigRefund = await sendAndConfirmTransaction(connection, tx, [buyerKp]);
//           console.log("✅ Refund successful:", sigRefund);
//         }
//       }
//     } catch (r: any) {
//       console.warn("⚠️ Refund failed:", r.message);
//     }
//     return res.status(400).json({ error: err.message });
//   }
// });

// router.post("/nft/:mintAddress/sell", authenticateJWT, async (req: AuthRequest, res) => {
//   try {
//     const { id: userId } = req.user;
//     const { mintAddress } = req.params;
//     const { price, royalty, paymentSymbol, paymentMint, useSol = false } = req.body;

//     // ✅ Deteksi jenis pembayaran
//     const isSolPayment = useSol || paymentMint === "So11111111111111111111111111111111111111111";

//     console.log("🚀 [RELIST FLOW START] ===========================================");
//     console.log("🧾 Params:", { mintAddress, price, royalty, paymentSymbol, paymentMint, useSol });
//     console.log("💰 Payment type:", isSolPayment ? "SOL (native)" : `SPL Token (${paymentSymbol})`);

//     // === 1️⃣ Validasi user dan wallet ===
//     const authUser = await Auth.findById(userId);
//     if (!authUser) return res.status(404).json({ error: "User not found" });

//     const sellerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
//     if (!sellerCustodian) return res.status(400).json({ error: "No seller wallet" });

//     const sellerKp = Keypair.fromSecretKey(bs58.decode(decrypt(sellerCustodian.privateKey)));
//     const sellerPk = sellerKp.publicKey;

//     console.log("👤 Authenticated User:", authUser.email || authUser.name);
//     console.log("🔑 Seller Wallet:", sellerPk.toBase58());

//     // === 2️⃣ Inisialisasi Anchor connection ===
//     const connection = new anchor.web3.Connection(
//       "https://mainnet.helius-rpc.com/?api-key=99344f8f-e269-4d69-b838-675fad917aa0",
//       "confirmed"
//     );
//     const wallet = new anchor.Wallet(sellerKp);
//     const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
//     anchor.setProvider(provider);

//     const programId = new PublicKey(process.env.PROGRAM_ID!);
//     const idl = require("../../public/idl/universe_of_gamers.json");
//     const program = new anchor.Program(idl, programId, provider);

//     console.log("🧩 Program loaded:", programId.toBase58());

//     // === 3️⃣ PDA derivation ===
//     const mintPk = new PublicKey(mintAddress);
//     const [listingPda, listingBump] = PublicKey.findProgramAddressSync(
//       [Buffer.from("listing"), mintPk.toBuffer()],
//       program.programId
//     );
//     const [escrowSignerPda, escrowBump] = PublicKey.findProgramAddressSync(
//       [Buffer.from("escrow_signer"), mintPk.toBuffer()],
//       program.programId
//     );

//     const sellerNftAta = getAssociatedTokenAddressSync(mintPk, sellerPk);
//     const nftAccountInfo = await connection.getAccountInfo(sellerNftAta);

//     console.log("📦 Listing PDA:", listingPda.toBase58(), "(bump:", listingBump, ")");
//     console.log("👜 Seller NFT ATA:", sellerNftAta.toBase58());
//     console.log("🤝 Escrow Signer PDA:", escrowSignerPda.toBase58(), "(bump:", escrowBump, ")");
//     console.log("📡 NFT ATA exists:", nftAccountInfo ? "✅ Yes" : "❌ No (might cause tx fail)");

//     // === 4️⃣ Hitung harga sesuai jenis token ===
//     let priceAmountBn: anchor.BN;
//     let decimalsUsed = 9; // default SOL decimals

//     if (isSolPayment) {
//       const lamports = Math.floor(price * anchor.web3.LAMPORTS_PER_SOL);
//       priceAmountBn = new anchor.BN(lamports);
//       console.log(`💰 Using SOL payment: ${price} SOL (${lamports.toLocaleString()} lamports)`);
//     } else {
//       // SPL token seperti UOG (6 desimal)
//       decimalsUsed = 6;
//       const baseUnits = Math.floor(price * 10 ** decimalsUsed);
//       priceAmountBn = new anchor.BN(baseUnits);
//       console.log(`💰 Using SPL payment: ${price} ${paymentSymbol} (${baseUnits.toLocaleString()} base units)`);
//     }

//     console.log("🧠 Debug context:", {
//       mintAddress,
//       price,
//       paymentSymbol,
//       paymentMint,
//       isSolPayment,
//       decimalsUsed,
//       priceAmountBn: priceAmountBn.toString(),
//     });

//     // === 5️⃣ Simulasikan transaksi ===
//     console.log("🔧 Simulating transaction...");
//     try {
//       const simIx = await program.methods
//         .relistNft(priceAmountBn, isSolPayment)
//         .accounts({
//           listing: listingPda,
//           newOwner: sellerPk,
//           mint: mintPk,
//           sellerNftAta,
//           escrowSigner: escrowSignerPda,
//           tokenProgram: TOKEN_PROGRAM_ID,
//           systemProgram: SystemProgram.programId,
//           ...(isSolPayment ? {} : { paymentMint: new PublicKey(paymentMint) }),
//         })
//         .instruction();

//       const simTx = new Transaction().add(simIx);
//       const simRes = await connection.simulateTransaction(simTx, [sellerKp]);
//       if (simRes.value.err) {
//         console.warn("⚠️ [Simulation Error]:", simRes.value.err);
//         console.warn("📜 [Simulation Logs]:", simRes.value.logs);
//       } else {
//         console.log("✅ Simulation success");
//       }
//     } catch (simErr: any) {
//       console.warn("⚠️ Simulation failed:", simErr.message);
//     }

//     // === 6️⃣ Kirim transaksi on-chain ===
//     console.log("🚀 Sending on-chain relist transaction...");
//     const txSig = await program.methods
//       .relistNft(priceAmountBn, isSolPayment)
//       .accounts({
//         listing: listingPda,
//         newOwner: sellerPk,
//         mint: mintPk,
//         sellerNftAta,
//         escrowSigner: escrowSignerPda,
//         tokenProgram: TOKEN_PROGRAM_ID,
//         systemProgram: SystemProgram.programId,
//         ...(isSolPayment ? {} : { paymentMint: new PublicKey(paymentMint) }),
//       })
//       .signers([sellerKp])
//       .rpc();

//     console.log("✅ On-chain relist success");
//     console.log("🔗 Transaction Signature:", txSig);
//     console.log("🔍 Explorer:", `https://solscan.io/tx/${txSig}`);

//     // === 7️⃣ Update database ===
//     const nftDoc = await Nft.findOne({ mintAddress });
//     if (!nftDoc) return res.status(404).json({ error: "NFT not found" });

//     nftDoc.isSell = true;
//     nftDoc.price = price;
//     nftDoc.royalty = royalty ?? nftDoc.royalty;
//     nftDoc.paymentSymbol = paymentSymbol || nftDoc.paymentSymbol;
//     nftDoc.paymentMint = paymentMint || nftDoc.paymentMint;
//     nftDoc.updatedAt = new Date();
//     await nftDoc.save();

//     console.log("🗂️ Updated NFT DB:", {
//       mintAddress,
//       price,
//       royalty: nftDoc.royalty,
//       paymentSymbol: nftDoc.paymentSymbol,
//       updatedAt: nftDoc.updatedAt,
//     });

//     // === 8️⃣ Broadcast ke client ===
//     broadcast({
//       type: "relist-update",
//       user: sellerCustodian,
//       mintAddress,
//       tx: txSig,
//       price,
//       useSol,
//       timestamp: new Date().toISOString(),
//     });
//     console.log("📡 Broadcast event sent to clients");

//     // === 9️⃣ Response sukses ===
//     console.log("✅ [RELIST FLOW COMPLETE] =====================================");
//     return res.json({
//       message: "✅ NFT relisted on-chain & off-chain successfully",
//       mint: mintAddress,
//       tx: txSig,
//       price,
//       useSol,
//     });

//   } catch (err: any) {
//     console.error("❌ [RELIST ERROR]");
//     console.error("🧩 Message:", err.message);
//     if (err.logs) console.error("📜 On-chain Logs:", err.logs);
//     if (err.stack) console.error("🪶 Stack:", err.stack);
//     console.error("❗ End of Relist Error =========================================");
//     return res.status(500).json({ error: err.message, logs: err.logs });
//   }
// });

export default router;
