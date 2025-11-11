import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';

/** =============================
 *  Subschema: External Wallet
 *  ============================= */
export interface IWallet {
  provider: 'phantom' | 'metamask' | 'walletconnect' | 'other';
  address: string;
}

const WalletSchema = new Schema<IWallet>(
  {
    provider: {
      type: String,
      enum: ['phantom', 'metamask', 'walletconnect', 'other'],
      required: true,
    },
    address: { type: String, required: true },
  },
  { _id: false }
);

/** =============================
 *  Subschema: Custodial Wallet
 *  ============================= */
export interface ICustodialWallet {
  provider: 'solana' | 'ethereum';
  address: string;
  privateKey: string; // encrypted
  mnemonic?: string;
}

const CustodialWalletSchema = new Schema<ICustodialWallet>(
  {
    provider: {
      type: String,
      enum: ['solana', 'ethereum'],
      required: true,
    },
    address: { type: String, required: true },
    privateKey: { type: String, required: true },
    mnemonic: { type: String, required: false },
  },
  { _id: false }
);

/** =============================
 *  Main Auth Schema
 *  ============================= */
export interface IAuth extends Document {
  _id: mongoose.Types.ObjectId;
  name?: string;
  email?: string;
  password?: string;
  googleId?: string;
  wallets: IWallet[];
  custodialWallets: ICustodialWallet[];
  authProvider: 'local' | 'google' | 'wallet' | 'custodial';
  acceptedTerms: boolean;
  avatar: string;
  notifyNewItems: boolean;
  notifyEmail: boolean;
  twoFactorEnabled: boolean;
  otpSecret?: string; 
  createdAt: Date;
  role?: string;
  usedReferralCode?: string | null;
  comparePassword(password: string): Promise<boolean>;
}

const AuthSchema = new Schema<IAuth>(
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
      enum: ['local', 'google', 'wallet', 'custodial'],
      default: 'local',
    },
    acceptedTerms: { type: Boolean, default: false },
    avatar: { type: String, default: '' },
    notifyNewItems: { type: Boolean, default: false },
    notifyEmail: { type: Boolean, default: false },
    twoFactorEnabled: { type: Boolean, default: false },
    otpSecret: { type: String, select: false },
    createdAt: { type: Date, default: Date.now },
    role: { type: String, default: '' },
    usedReferralCode: { type: String, default: null },
  },
  { collection: 'users' }
);

/** =============================
 *  Hooks & Methods
 *  ============================= */

// 🔒 Hash password (hanya untuk local signup)
AuthSchema.pre<IAuth>('save', async function (next) {
  if (!this.isModified('password')) return next();
  if (!this.password) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err as any);
  }
});

// 🔑 Method untuk verifikasi password
AuthSchema.methods.comparePassword = async function (
  password: string
): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(password, this.password);
};

export default mongoose.model<IAuth>('Auth', AuthSchema);
