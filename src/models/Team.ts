import mongoose, { Schema, Document, Types } from "mongoose";
import { INft } from "./Nft";

export interface ITeam extends Document {
  name: string;                // nama tim (optional, bisa diisi user)
  owner: string;               // wallet address user (biar jelas siapa pemilik tim)
  members: Types.ObjectId[];   // array NFT yang jadi anggota tim (harus 3)
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TeamSchema = new Schema<ITeam>(
  {
    name: { type: String, required: true },
    owner: { type: String, required: true }, // wallet address
    members: {
      type: [{ type: Schema.Types.ObjectId, ref: "Nft" }],
      default: [] // biar aman kalau belum ada member
    },
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "teams" }
);

// ✅ Validasi jumlah anggota tim = 0 atau 3
TeamSchema.pre("save", function (next) {
  if (Array.isArray(this.members)) {
    const len = this.members.length;
    if (len < 0 || len > 3) {
      return next(new Error("A team must have between 0 and 3 NFTs"));
    }
  }
  next();
});

export const Team = mongoose.model<ITeam>("Team", TeamSchema);
