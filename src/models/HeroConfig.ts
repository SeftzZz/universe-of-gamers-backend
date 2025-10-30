import mongoose, { Schema, Document } from "mongoose";

export interface IHeroConfig extends Document {
  rarity: "common" | "rare" | "epic" | "legendary";
  teamModifier: number;
  teamValue: {
    1: number;
    2: number;
    3: number;
  };
}

const HeroConfigSchema = new Schema<IHeroConfig>(
  {
    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary"],
      required: true,
      unique: true, // biar tiap rarity cuma satu config
    },
    teamModifier: { type: Number, required: true },
    teamValue: {
      1: { type: Number, required: true },
      2: { type: Number, required: true },
      3: { type: Number, required: true },
    },
  },
  {
    collection: "hero_configs",
    timestamps: true, // createdAt, updatedAt
  }
);

export const HeroConfig = mongoose.model<IHeroConfig>(
  "HeroConfig",
  HeroConfigSchema
);
