import mongoose, { Schema, Document, Types } from "mongoose";

export interface ITournamentMatch extends Document {
  tournamentId: Types.ObjectId;     // ID turnamen
  phase: "quarter" | "semi" | "final";

  player1: string;                  // wallet address
  player2: string;                  // wallet address

  team1?: Types.ObjectId;           // Team reference (optional)
  team2?: Types.ObjectId;           // Team reference (optional)

  winner?: string;                  // wallet address pemenang
  battleId?: Types.ObjectId;        // ref ke Battle (optional)
  completed: boolean;               // apakah match sudah selesai

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

    // quarter → semi → final
    phase: {
      type: String,
      enum: ["quarter", "semi", "final"],
      required: true,
    },

    // player wallet addresses
    player1: { type: String, required: true },
    player2: { type: String, required: true },

    // reference to Team (optional but flexible)
    team1: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    team2: { type: Schema.Types.ObjectId, ref: "Team", default: null },

    // Winner wallet address
    winner: { type: String, default: null },

    // result ID dari Battle engine
    battleId: { type: Schema.Types.ObjectId, ref: "Battle", default: null },

    // match selesai atau belum
    completed: { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "tournament_matches" }
);

// 🔄 Auto-update timestamp
TournamentMatchSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// 🔥 Fix OverwriteModelError in dev
if (mongoose.models.TournamentMatch) {
  mongoose.deleteModel("TournamentMatch");
}

export const TournamentMatch = mongoose.model<ITournamentMatch>("TournamentMatch", TournamentMatchSchema);