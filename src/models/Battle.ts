import mongoose, { Schema, Document, Types } from "mongoose";
import { ITeam } from "./Team";

export interface IBattleLog {
  turn: number;
  attacker: string;   // NFT id / name
  defender: string;   // NFT id / name
  skill: string;      // skill/attack used
  damage: number;
  isCrit: boolean;    // ✅ baru ditambah
  remainingHp: number;
  timestamp: Date;
}

export interface IBattle extends Document {
  players: {
    user: string;             // wallet address / userId
    team: Types.ObjectId;     // ref ke Team
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
    turn: { type: Number, required: true },
    attacker: { type: String, required: true },
    defender: { type: String, required: true },
    skill: { type: String, required: true },
    damage: { type: Number, required: true },
    isCrit: { type: Boolean, default: false }, // ✅ baru ditambah
    remainingHp: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const BattleSchema = new Schema<IBattle>(
  {
    players: [
      {
        user: { type: String, required: true },
        team: { type: Schema.Types.ObjectId, ref: "Team", required: true },
        isWinner: { type: Boolean, default: false }
      }
    ],
    mode: {
      type: String,
      enum: ["pvp", "adventure"],
      required: true
    },
    result: {
      type: String,
      enum: ["init_battle", "end_battle"],
      default: "init_battle"
    },
    log: { type: [BattleLogSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "battles" }
);

export const Battle = mongoose.model<IBattle>("Battle", BattleSchema);
