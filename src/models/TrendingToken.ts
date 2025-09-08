// models/TrendingToken.ts
import mongoose, { Schema, Document } from "mongoose";

export interface ITrendingToken extends Document {
  mint: string;
  name: string;
  symbol: string;
  logoURI?: string;
  decimals: number;
  priceUsd: number;
  usdValue?: number;
  liquidity: number;
  marketCap: number;
  percentChange: number;
  trend: number; // -1, 0, 1
  holders?: number;
  lastUpdated: Date;
}

const TrendingTokenSchema: Schema = new Schema(
  {
    mint: { type: String, required: true, index: true },
    name: { type: String, required: true },
    symbol: { type: String, required: true },
    logoURI: { type: String },
    decimals: { type: Number, default: 0 },
    priceUsd: { type: Number, default: 0 },
    usdValue: { type: Number, default: 0 },
    liquidity: { type: Number, default: 0 },
    marketCap: { type: Number, default: 0 },
    percentChange: { type: Number, default: 0 },
    trend: { type: Number, enum: [-1, 0, 1], default: 0 },
    holders: { type: Number, default: 0 },
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model<ITrendingToken>(
  "TrendingToken",
  TrendingTokenSchema
);
