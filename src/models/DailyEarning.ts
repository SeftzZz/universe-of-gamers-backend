import mongoose, { Schema, Document, Types } from "mongoose";

export interface IHeroUsed {
  rarity: "common" | "rare" | "epic" | "legendary";
  level: number;
}

export interface IDailyEarning extends Document {
  walletAddress: String;
  date: Date;
  rank:
    | "sentinel"
    | "vanguard"
    | "phantom"
    | "revenant"
    | "warden"
    | "arcanist"
    | "ascedant"
    | "immortal"
    | "eternal"
    | "mythic"
    | "godslayer";
  winStreak: number;
  totalFragment: number;
  totalDailyEarning: number;
  heroesUsed: IHeroUsed[];
  createdAt: Date;
  updatedAt: Date;
}

const DailyEarningSchema = new Schema<IDailyEarning>(
  {
    walletAddress: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    rank: {
      type: String,
      enum: [
        "sentinel",
        "vanguard",
        "phantom",
        "revenant",
        "warden",
        "arcanist",
        "ascedant",
        "immortal",
        "eternal",
        "mythic",
        "godslayer",
      ],
      required: true,
    },
    winStreak: { type: Number, required: true },
    totalFragment: { type: Number, required: true },
    totalDailyEarning: { type: Number, required: true },
    heroesUsed: [
      {
        rarity: {
          type: String,
          enum: ["common", "rare", "epic", "legendary"],
        },
        level: { type: Number, min: 1, max: 3 },
      },
    ],
  },
  {
    collection: "daily_earnings",
    timestamps: true, // otomatis buat createdAt dan updatedAt
  }
);

// 🧩 Index unik opsional: 1 data per hari per player
DailyEarningSchema.index(
  { walletAddress: 1, date: 1 },
  { unique: true, partialFilterExpression: { walletAddress: { $exists: true } } }
);

export const DailyEarning = mongoose.model<IDailyEarning>(
  "DailyEarning",
  DailyEarningSchema
);
