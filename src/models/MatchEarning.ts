import mongoose, { Schema, Document } from "mongoose";

export interface IMatchEarning extends Document {
  walletAddress: string; // ✅ ganti dari ObjectId
  gameNumber: number;
  winCount: number;
  skillFragment: number;
  economicFragment: number;
  booster: number;
  rankModifier: number;
  totalFragment: number;
  createdAt: Date;
  updatedAt: Date;
}

const MatchEarningSchema = new Schema<IMatchEarning>(
  {
    walletAddress: {
      type: String, // ✅ ubah dari ObjectId
      required: true,
    },
    gameNumber: { type: Number, required: true },
    winCount: { type: Number, required: true },
    skillFragment: { type: Number, required: true },
    economicFragment: { type: Number, required: true },
    booster: { type: Number, required: true },
    rankModifier: { type: Number, required: true },
    totalFragment: { type: Number, required: true },
  },
  {
    collection: "match_earnings",
    timestamps: true,
  }
);

export const MatchEarning = mongoose.model<IMatchEarning>(
  "MatchEarning",
  MatchEarningSchema
);
