import mongoose, { Schema, Document } from "mongoose";
import { ISkill, SkillSchema } from "./Skill";

export interface ICharacter extends Document {
  name: string;
  description: string;
  image: string;
  element: "Fire" | "Water" | "Earth" | "Wind";
  rarity: "Common" | "Rare" | "Epic" | "Legendary"; // 🔥 NEW FIELD

  baseHp: number;
  baseAtk: number;
  baseDef: number;
  baseSpd: number;
  baseCritRate: number;
  baseCritDmg: number;

  basicAttack: ISkill;
  skillAttack: ISkill;
  ultimateAttack: ISkill;

  createdAt: Date;
}

const CharacterSchema = new Schema<ICharacter>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    element: { type: String, enum: ["Fire", "Water", "Earth", "Wind"], required: true },

    rarity: { 
      type: String, 
      enum: ["Common", "Rare", "Epic", "Legendary"], 
      required: true,
      default: "Common" 
    }, // 🔥 NEW FIELD

    baseHp: { type: Number, min: 1, required: true },
    baseAtk: { type: Number, min: 0, required: true },
    baseDef: { type: Number, min: 0, required: true },
    baseSpd: { type: Number, min: 0, required: true },
    baseCritRate: { type: Number, min: 0, max: 100, default: 0 },
    baseCritDmg: { type: Number, min: 0, max: 500, default: 0 },

    basicAttack: { type: SkillSchema, required: true },
    skillAttack: { type: SkillSchema, required: true },
    ultimateAttack: { type: SkillSchema, required: true },

    createdAt: { type: Date, default: Date.now }
  },
  { collection: "characters" }
);

export const Character = mongoose.model<ICharacter>("Character", CharacterSchema);
