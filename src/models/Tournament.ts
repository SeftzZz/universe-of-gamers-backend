import mongoose, { Schema, Document, Types } from "mongoose";

export interface ITournament extends Document {
  name: string;
  pack: Types.ObjectId;
  currentPhase: "round32" | "round16" | "quarter" | "semi" | "final" | "completed";
  paymentSymbol: "USD" | "UOG" | "SOL";
  rarity: "common" | "rare" | "epic" | "legendary";
  winner?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TournamentSchema = new Schema<ITournament>(
  {
    name: { type: String, required: true },
    pack: { type: Schema.Types.ObjectId, ref: "TournamentPack", required: true },

    currentPhase: {
      type: String,
      enum: ["round32", "round16", "quarter", "semi", "final", "completed"],
      required: true,   // ⬅ FIXED (tidak default)
    },

    paymentSymbol: {
      type: String,
      enum: ["USD", "UOG", "SOL"],
      default: "USD",
      required: true,
    },

    rarity: {
      type: String,
      enum: ["common", "rare", "epic", "legendary"],
      default: "common",
      required: true,
    },

    winner: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "tournaments" }
);

export const Tournament = mongoose.model<ITournament>(
  "Tournament",
  TournamentSchema
);
