import mongoose, { Schema, Document } from "mongoose";

export interface IPlayer extends Document {
  username: string;
  walletAddress?: string;
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
  totalEarning: number;
  lastActive: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PlayerSchema = new Schema<IPlayer>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    walletAddress: {
      type: String,
      trim: true,
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
      default: "sentinel",
    },
    totalEarning: {
      type: Number,
      default: 0,
    },
    lastActive: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "players",
    timestamps: true, // otomatis buat createdAt & updatedAt
  }
);

export const Player = mongoose.model<IPlayer>("Player", PlayerSchema);
