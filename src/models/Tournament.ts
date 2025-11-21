import mongoose, { Schema, Document, Types } from "mongoose";

export interface ITournament extends Document {
  name: string;
  pack: Types.ObjectId; // ref to TournamentPack
  currentPhase: "quarter" | "semi" | "final" | "completed";
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
      enum: ["quarter", "semi", "final", "completed"],
      default: "quarter",
    },
    winner: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "tournaments" }
);

export const Tournament = mongoose.model<ITournament>("Tournament", TournamentSchema);
