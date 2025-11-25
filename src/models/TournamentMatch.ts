import mongoose, { Schema, Document, Types } from "mongoose";

export interface ITournamentMatch extends Document {
  tournamentId: Types.ObjectId;

  // phase flexible
  phase: "round32" | "round16" | "quarter" | "semi" | "final";

  player1: string;
  player2: string;

  team1?: Types.ObjectId;
  team2?: Types.ObjectId;

  winner?: string;
  battleId?: Types.ObjectId;
  completed: boolean;

  matchTime?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const TournamentMatchSchema = new Schema<ITournamentMatch>(
  {
    tournamentId: {
      type: Schema.Types.ObjectId,
      ref: "Tournament",
      required: true,
    },

    phase: {
      type: String,
      enum: ["round32", "round16", "quarter", "semi", "final"],
      required: true,
    },

    player1: { type: String, required: true },
    player2: { type: String, required: true },

    team1: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    team2: { type: Schema.Types.ObjectId, ref: "Team", default: null },

    winner: { type: String, default: null },
    battleId: { type: Schema.Types.ObjectId, ref: "Battle", default: null },

    completed: { type: Boolean, default: false },

    matchTime: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "tournament_matches" }
);

// Auto-update timestamp
TournamentMatchSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// Fix dev reload
if (mongoose.models.TournamentMatch) {
  mongoose.deleteModel("TournamentMatch");
}

export const TournamentMatch = mongoose.model<ITournamentMatch>(
  "TournamentMatch",
  TournamentMatchSchema
);
