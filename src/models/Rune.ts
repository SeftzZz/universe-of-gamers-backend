import mongoose, { Schema, Document } from "mongoose";

export interface IRune extends Document {
  name: string;
  description: string;
  image: string;
  rarity: "Common" | "Rare" | "Epic" | "Legendary"; // 🔥 NEW FIELD

  hpBonus: number;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  critRateBonus: number;
  critDmgBonus: number;

  createdAt: Date;
}

const RuneSchema = new Schema<IRune>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },

    rarity: { 
      type: String, 
      enum: ["Common", "Rare", "Epic", "Legendary"], 
      required: true,
      default: "Common" 
    }, // 🔥 NEW FIELD

    hpBonus: { type: Number, default: 0 },
    atkBonus: { type: Number, default: 0 },
    defBonus: { type: Number, default: 0 },
    spdBonus: { type: Number, default: 0 },
    critRateBonus: { type: Number, default: 0 },
    critDmgBonus: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now }
  },
  { collection: "runes" }
);

export const Rune = mongoose.model<IRune>("Rune", RuneSchema);
