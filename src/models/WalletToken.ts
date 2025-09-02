import mongoose, { Schema, Document } from "mongoose";

export interface IWalletToken extends Document {
  address: string;
  mint: string;
  owner: string;
  amount: number;
  decimals: number;
  name: string | null;
  symbol: string;
  logoURI: string | null;
  priceUsd: number;
  usdValue: number;
  percentChange: number;
  trend: number;
  lastUpdated: Date;
}

const WalletTokenSchema: Schema = new Schema({
  address: { type: String, required: true, index: true },
  mint: { type: String, required: true },
  owner: { type: String, required: true },
  amount: { type: Number, required: true },
  decimals: { type: Number, required: true },
  name: { type: String, default: null },
  symbol: { type: String, default: "Unknown Token" },
  logoURI: { type: String, default: null },
  priceUsd: { type: Number, default: 0 },
  usdValue: { type: Number, default: 0 },
  percentChange: { type: Number, default: 0 },
  trend: { type: Number, enum: [-1, 0, 1], default: 0 },
  lastUpdated: { type: Date, default: Date.now },
});

export default mongoose.model<IWalletToken>("WalletToken", WalletTokenSchema);
