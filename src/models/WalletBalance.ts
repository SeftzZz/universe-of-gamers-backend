import mongoose, { Schema, Document } from "mongoose";

export interface IWalletBalance extends Document {
  address: string;
  lamports: number;
  sol: number;
  solPriceUsd: number;
  usdValue: number;
  percentChange: number;
  trend: number;
  lastUpdated: Date;
}

const WalletBalanceSchema: Schema = new Schema({
  address: { type: String, required: true, index: true },
  lamports: { type: Number, required: true },
  sol: { type: Number, required: true },
  solPriceUsd: { type: Number, required: true },
  usdValue: { type: Number, required: true },
  percentChange: { type: Number, required: true },
  trend: { type: Number, enum: [-1, 0, 1], default: 0 },
  lastUpdated: { type: Date, default: Date.now },
});

export default mongoose.model<IWalletBalance>("WalletBalance", WalletBalanceSchema);
