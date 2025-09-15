import mongoose, { Schema, Document, Types } from "mongoose";
import { INft } from "./Nft";

export interface ITeam extends Document {
  name: string;                // nama tim (optional, bisa diisi user)
  owner: string;               // wallet address user (biar jelas siapa pemilik tim)
  members: Types.ObjectId[];   // array NFT yang jadi anggota tim (harus 3)
  createdAt: Date;
  updatedAt: Date;
}

const TeamSchema = new Schema<ITeam>(
  {
    name: { type: String, required: true },
    owner: { type: String, required: true }, // wallet address
    members: [
      { type: Schema.Types.ObjectId, ref: "Nft", required: true }
    ],
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "teams" }
);

// ✅ Validasi jumlah anggota tim = 3
TeamSchema.pre("save", function (next) {
  if (this.members.length !== 3) {
    return next(new Error("A team must have exactly 3 NFTs"));
  }
  next();
});

export const Team = mongoose.model<ITeam>("Team", TeamSchema);
