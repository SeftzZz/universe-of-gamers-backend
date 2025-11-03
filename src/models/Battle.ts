import mongoose, { Schema, Document, Types } from "mongoose";
import { ITeam } from "./Team";

export interface IBattleLog {
  attacker: string;
  defender: string;
  skill: string;
  damage: number;
  isCrit: boolean;
  remainingHp: number;   // ✅ added back
  timestamp: Date;
}

export interface IBattle extends Document {
  players: {
    user: string;
    team: Types.ObjectId;
    isWinner?: boolean;
  }[];
  mode: "pvp" | "adventure";
  result: "init_battle" | "end_battle";
  log: IBattleLog[];
  createdAt: Date;
  updatedAt: Date;
}

const BattleLogSchema = new Schema<IBattleLog>(
  {
    attacker: { type: String, required: true },
    defender: { type: String, required: true },
    skill: { type: String, required: true },
    damage: { type: Number, required: true },
    isCrit: { type: Boolean, default: false },
    remainingHp: { type: Number, required: true },  // ✅ added
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const BattleSchema = new Schema<IBattle>(
  {
    players: [
      {
        user: { type: String, required: true },
        team: { type: Schema.Types.ObjectId, ref: "Team", required: true },
        isWinner: { type: Boolean, default: false },
      },
    ],
    mode: { type: String, enum: ["pvp", "adventure"], required: true },
    result: { type: String, enum: ["init_battle", "end_battle"], default: "init_battle" },
    log: { type: [BattleLogSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "battles" }
);

// 🔥 Force reload model
if (mongoose.models.Battle) {
  mongoose.deleteModel("Battle");
}

export const Battle = mongoose.model<IBattle>("Battle", BattleSchema);
