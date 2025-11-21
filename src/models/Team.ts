import mongoose, { Schema, Document, Types } from "mongoose";
import { INft } from "./Nft";

export interface ITeam extends Document {
  name: string;
  owner: string;
  members: Types.ObjectId[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TeamSchema = new Schema<ITeam>(
  {
    name: { type: String, required: true },
    owner: { type: String, required: true },
    members: {
      type: [{ type: Schema.Types.ObjectId, ref: "Nft" }],
      default: []
    },
    isActive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "teams" }
);

// ✅ Validasi jumlah anggota (0–3)
TeamSchema.pre("save", function (next) {
  if (Array.isArray(this.members)) {
    const len = this.members.length;
    if (len < 0 || len > 3) {
      return next(new Error("A team must have between 0 and 3 NFTs"));
    }
  }
  next();
});

// ✅ Validasi unik name + owner tanpa menyebabkan MongoDB E11000
TeamSchema.pre("save", async function (next) {
  try {
    const Team = mongoose.models.Team;

    const exists = await Team.findOne({
      name: this.name,
      owner: this.owner,
      _id: { $ne: this._id } // agar update tetap bisa
    });

    if (exists) {
      return next(new Error("You already have a team with this name."));
    }

    next();
  } catch (err) {
    console.error("❌ Team validation error:", (err as any).message);
    next(new Error("Failed validating team uniqueness."));
  }
});

export const Team = mongoose.model<ITeam>("Team", TeamSchema);
