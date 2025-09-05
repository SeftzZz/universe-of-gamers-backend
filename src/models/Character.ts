import mongoose, { Schema, Document } from "mongoose";

// 🔹 Skill Interface
export interface ISkill {
  skillName: string;
  atkMultiplier: number;
  defMultiplier: number;
  hpMultiplier: number;
  description: string;
}

// 🔹 Character Interface
export interface ICharacter extends Document {
  displayName: string;
  element: "Fire" | "Water" | "Earth" | "Wind";
  level: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  critRate: number;
  critDmg: number;
  basicAttack: ISkill;
  skillAttack: ISkill;
  ultimateAttack: ISkill;
  createdAt: Date;
}

// 🔹 Skill Schema
const SkillSchema = new Schema<ISkill>({
  skillName: { type: String, required: true },
  atkMultiplier: { type: Number, default: 0 },
  defMultiplier: { type: Number, default: 0 },
  hpMultiplier: { type: Number, default: 0 },
  description: { type: String, default: "" }
});

// 🔹 Character Schema
const CharacterSchema = new Schema<ICharacter>(
{
  displayName: { type: String, required: true },
  element: { type: String, enum: ["Fire", "Water", "Earth", "Wind"], required: true },
  level: { type: Number, min: 1, default: 1 },
  hp: { type: Number, min: 1, required: true },
  atk: { type: Number, min: 0, required: true },
  def: { type: Number, min: 0, required: true },
  spd: { type: Number, min: 0, required: true },
  critRate: { type: Number, min: 0, max: 100, default: 0 },
  critDmg: { type: Number, min: 0, max: 500, default: 0 },
  basicAttack: { type: SkillSchema, required: true },
  skillAttack: { type: SkillSchema, required: true },
  ultimateAttack: { type: SkillSchema, required: true },
  createdAt: { type: Date, default: Date.now }
},
{ collection: "characters" } // add by fpp 05/09/25
);

export const Character = mongoose.model<ICharacter>("Character", CharacterSchema);
