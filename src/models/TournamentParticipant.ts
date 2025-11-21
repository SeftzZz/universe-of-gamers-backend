import mongoose, { Schema, Document, Types } from "mongoose";

export interface ITournamentParticipant extends Document {
  tournamentId: Types.ObjectId;
  walletAddress: string;
  team: Types.ObjectId;
  eliminated: boolean;
  createdAt: Date;
}

const ParticipantSchema = new Schema<ITournamentParticipant>(
  {
    tournamentId: {
      type: Schema.Types.ObjectId,
      ref: "Tournament",
      required: true,
    },
    walletAddress: { type: String, required: true },
    team: { type: Schema.Types.ObjectId, ref: "Team", required: true },
    eliminated: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "tournament_participants" }
);

export const TournamentParticipant = mongoose.model<ITournamentParticipant>("TournamentParticipant", ParticipantSchema);