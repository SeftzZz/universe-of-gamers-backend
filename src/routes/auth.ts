import express from 'express';
import jwt from 'jsonwebtoken';
import Auth from '../models/Auth.js';
import { encrypt, decrypt } from '../utils/cryptoHelper.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';

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
const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, email: user.email, provider: user.authProvider },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
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

    const custodialWallet = {
      provider: 'solana',
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
          provider: 'other', // default external type
          address: address,    // sama dengan custodial
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
    console.error('❌ Register error:', err);
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
    console.error('❌ Login error:', err);
    res.status(400).json({ error: err.message });
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
  } catch (err) {
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
    console.error('❌ Wallet login error:', err);
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

    const selectedProvider = provider || 'solana';

    if (selectedProvider === 'solana') {
      // ✅ Generate custodial wallet (Solana)
      const kp = Keypair.generate();
      const privateKeyBase58 = bs58.encode(kp.secretKey);

      const wallet = {
        provider: 'solana',
        address: kp.publicKey.toBase58(),
        privateKey: encrypt(privateKeyBase58), // 🔒 simpan terenkripsi
      };

      auth.custodialWallets.push(wallet);
      auth.authProvider = 'custodial';
      await auth.save();

      const token = generateToken(auth); // 🔑 kalau mau langsung login token JWT

      return res.status(201).json({
        success: true,
        message: 'Custodial wallet created',
        authId: auth._id,
        token,
        wallet: { provider: wallet.provider, address: wallet.address }, // ❌ jangan kirim privateKey!
      });
    }

    return res.status(400).json({ error: 'Unsupported provider' });
  } catch (err: any) {
    console.error('❌ Error create custodial wallet:', err);
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
  } catch (err) {
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
  } catch (err) {
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
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
