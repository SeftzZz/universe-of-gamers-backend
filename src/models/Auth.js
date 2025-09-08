const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// Schema untuk external wallet
const WalletSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['phantom', 'metamask', 'walletconnect', 'other'],
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
  },
  { _id: false }
);

// Schema untuk custodial wallet (server-generated)
const CustodialWalletSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['solana', 'ethereum'],
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    privateKey: {
      type: String,
      required: true,
    },
  },
  { _id: false }
);

const AuthSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      minlength: 2,
      maxlength: 100,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
    },
    password: {
      type: String,
      minlength: 8,
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
    },
    wallets: [WalletSchema],
    custodialWallets: [CustodialWalletSchema],
    authProvider: {
      type: String,
      enum: ['local', 'google', 'wallet'],
      default: 'local',
    },
    acceptedTerms: {
      type: Boolean,
      default: false,
    },
    avatar: {
      type: String,
      default: '',
    },
    notifyNewItems: {
      type: Boolean,
      default: false,
    },
    notifyEmail: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { collection: 'users' }
);

// 🔒 Hash password (hanya untuk local signup)
AuthSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (!this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// 🔑 Method untuk verifikasi password
AuthSchema.methods.comparePassword = async function (password) {
  return bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('Auth', AuthSchema);
