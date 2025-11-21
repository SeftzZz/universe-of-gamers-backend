import mongoose, { Schema, Document } from "mongoose";

export interface ITournamentPack extends Document {
  name: string;
  description?: string;

  // harga sesuai gatcha
  priceUOG: number;
  priceSOL: number;
  priceUSD: number;

  createdAt: Date;
  updatedAt: Date;
}

const TournamentPackSchema = new Schema<ITournamentPack>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    priceUOG: { type: Number, default: 0 },
    priceSOL: { type: Number, default: 0 },
    priceUSD: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "tournament_packs" }
);

export const TournamentPack = mongoose.model<ITournamentPack>("TournamentPack", TournamentPackSchema);
