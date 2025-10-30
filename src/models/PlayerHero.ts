import mongoose, { Schema, Document, Types } from "mongoose";

export interface IPlayerHero extends Document {
  playerId: String; // relasi ke Player
  rarity: "common" | "rare" | "epic" | "legendary";
  level: 1 | 2 | 3;
  equipped: boolean; // true jika sedang dipakai dalam tim aktif
}

const PlayerHeroSchema = new Schema<IPlayerHero>(
  {
    playerId: {
      type: String,
      required: true,
    },
    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary"],
      required: true,
    },
    level: {
      type: Number,
      min: 1,
      max: 3,
      required: true,
    },
    equipped: {
      type: Boolean,
      default: false, // true jika dipakai di tim aktif
    },
  },
  {
    collection: "player_heroes",
    timestamps: true, // createdAt & updatedAt
  }
);

export const PlayerHero = mongoose.model<IPlayerHero>(
  "PlayerHero",
  PlayerHeroSchema
);
