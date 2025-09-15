import mongoose, { Schema, Document } from "mongoose";

export interface IReward {
  type: "character" | "rune";   // jenis reward
  rarity: string;               // Common, Rare, Epic, Legendary
  chance: number;               // persentase drop (0–100)
}

export interface IGatchaPack extends Document {
  name: string;
  description: string;
  priceUOG?: number;
  priceSOL?: number;
  rewards: IReward[];
  createdAt: Date;
  updatedAt: Date;
}

const RewardSchema = new Schema<IReward>(
  {
    type: { type: String, enum: ["character", "rune"], required: true },
    rarity: { type: String, required: true },
    chance: { type: Number, required: true, min: 0, max: 100 }
  },
  { _id: false }
);

const GatchaPackSchema = new Schema<IGatchaPack>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    priceUOG: { type: Number, default: 0 },
    priceSOL: { type: Number, default: 0 },
    rewards: { type: [RewardSchema], required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "gatcha_packs" }
);

export const GatchaPack = mongoose.model<IGatchaPack>("GatchaPack", GatchaPackSchema);