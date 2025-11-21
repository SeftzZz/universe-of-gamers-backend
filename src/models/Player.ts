import mongoose, { Schema, Document } from "mongoose";

export interface IPlayer extends Document {
  username: string;
  walletAddress?: string;
  rank:
    | "sentinel"
    | "vanguard"
    | "phantom"
    | "revenant"
    | "warden"
    | "arcanist"
    | "ascedant"
    | "immortal"
    | "eternal"
    | "mythic"
    | "godslayer";
  totalEarning: number;
  lastActive: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PlayerSchema = new Schema<IPlayer>(
  {
    username: {
      type: String,
      required: true,
      trim: true,
    },
    walletAddress: {
      type: String,
      trim: true,
    },
    rank: {
      type: String,
      enum: [
        "sentinel",
        "vanguard",
        "phantom",
        "revenant",
        "warden",
        "arcanist",
        "ascedant",
        "immortal",
        "eternal",
        "mythic",
        "godslayer",
      ],
      default: "sentinel",
    },
    totalEarning: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now },
  },
  {
    collection: "players",
    timestamps: true,
  }
);

// 🛡️ VALIDASI MANUAL — Cegah insert username duplikat TANPA error MongoDB
PlayerSchema.pre("save", async function (next) {
  try {
    const Player = mongoose.models.Player;

    const exists = await Player.findOne({
      username: this.username,
      _id: { $ne: this._id },
    });

    if (exists) {
      console.log(`⚠️ [Player] Duplicate username, skipping: ${this.username}`);

      // 🛑 Hack Mongoose: tandai bahwa dokumen bukan dokumen baru
      (this as any).isNew = false;

      return next(); // skip tanpa error
    }

    next();
  } catch (err: any) {
    console.log("⚠️ [Player] Validation failed:", err.message);

    // Tetap skip save tanpa error
    (this as any).isNew = false;
    return next();
  }
});

export const Player = mongoose.model<IPlayer>("Player", PlayerSchema);
