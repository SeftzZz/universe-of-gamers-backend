import express from 'express';
import jwt from 'jsonwebtoken';
import Auth from '../models/Auth.js';
import { encrypt, decrypt } from '../utils/cryptoHelper.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

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
    const auth = new Auth({ name, email, password, acceptedTerms, authProvider: 'local' });
    await auth.save();

    // ✅ Generate custodial wallet (Solana)
    const kp = Keypair.generate();
    const privateKeyBase58 = bs58.encode(kp.secretKey);

    const wallet = {
      provider: 'solana',
      address: kp.publicKey.toBase58(),
      privateKey: encrypt(privateKeyBase58),
    };

    auth.custodialWallets.push(wallet);
    auth.authProvider = 'custodial';
    await auth.save();

    const token = generateToken(auth);

    res.status(201).json({
      message: 'User registered with custodial wallet',
      authId: auth._id,
      token,
      wallet: { provider: wallet.provider, address: wallet.address }, // jangan kirim privateKey!
    });
  } catch (err) {
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
    res.json({ message: 'Login successful', authId: auth._id, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === Login with Google ===
router.post('/google', async (req, res) => {
  try {
    const { googleId, email, name } = req.body;
    let auth = await Auth.findOne({ googleId });

    if (!auth) {
      auth = new Auth({ googleId, email, name, authProvider: 'google' });
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
    res.json({ message: 'Login successful', authId: auth._id, wallets: auth.wallets, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === Generate Custodial Wallet ===
router.post('/auth/custodial', async (req, res) => {
  try {
    const { userId, provider } = req.body;

    const auth = await Auth.findById(userId);
    if (!auth) return res.status(404).json({ error: 'User not found' });

    if (provider === 'solana') {
      const kp = Keypair.generate();
      const privateKeyBase58 = bs58.encode(kp.secretKey);

      const wallet = {
        provider: 'solana',
        address: kp.publicKey.toBase58(),
        privateKey: encrypt(privateKeyBase58), // ✅ simpan terenkripsi
      };

      auth.custodialWallets.push(wallet);
      auth.authProvider = 'custodial';
      await auth.save();

      return res.json({
        message: 'Custodial wallet created',
        wallet: { provider: wallet.provider, address: wallet.address },
      });
    }

    res.status(400).json({ error: 'Unsupported provider' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
