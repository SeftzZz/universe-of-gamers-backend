import mongoose, { Schema, Document } from "mongoose";

export interface ISkill extends Document {
  name: string;
  description: string;
  image: string;

  atkMultiplier: number;
  defMultiplier: number;
  hpMultiplier: number;

  createdAt: Date;
}

const SkillSchema = new Schema<ISkill>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },

    atkMultiplier: { type: Number, default: 0 },
    defMultiplier: { type: Number, default: 0 },
    hpMultiplier: { type: Number, default: 0 },

    createdAt: { type: Date, default: Date.now }
  },
  { collection: "skills" }
);

export const Skill = mongoose.model<ISkill>("Skill", SkillSchema);
