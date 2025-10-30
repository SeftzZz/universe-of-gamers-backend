import mongoose, { Schema, Document } from "mongoose";

export interface IRankConfig extends Document {
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
  modifier: number;
}

const RankConfigSchema = new Schema<IRankConfig>(
  {
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
      unique: true, // pastikan tiap rank hanya 1 konfigurasi
    },
    modifier: { type: Number, required: true },
  },
  {
    collection: "rank_configs",
    timestamps: true, // createdAt, updatedAt
  }
);

export const RankConfig = mongoose.model<IRankConfig>(
  "RankConfig",
  RankConfigSchema
);
