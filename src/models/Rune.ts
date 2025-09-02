import mongoose, { Schema, Document } from "mongoose";

export interface IRune extends Document {
  itemName: string;
  hpBonus: number;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  critRateBonus: number;
  critDmgBonus: number;
  description: string;
  createdAt: Date;
}

const RuneSchema = new Schema<IRune>({
  itemName: { type: String, required: true },
  hpBonus: { type: Number, default: 0 },
  atkBonus: { type: Number, default: 0 },
  defBonus: { type: Number, default: 0 },
  spdBonus: { type: Number, default: 0 },
  critRateBonus: { type: Number, default: 0 },
  critDmgBonus: { type: Number, default: 0 },
  description: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
});

export const Rune = mongoose.model<IRune>("Rune", RuneSchema);