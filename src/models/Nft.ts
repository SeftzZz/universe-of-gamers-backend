import mongoose, { Schema, Document, Types } from "mongoose";
import { ICharacter } from "./Character";
import { IRune } from "./Rune";

export interface INft extends Document {
  _id: any;
  owner: string;
  character?: Types.ObjectId | ICharacter;
  rune?: Types.ObjectId | IRune;

  name: string;
  description: string;
  image: string;
  royalty?: number;
  base_name?: string;

  mintAddress: string;

  level: number;
  exp: number;

  hp: number;
  atk: number;
  def: number;
  spd: number;
  critRate: number;
  critDmg: number;

  equipped: Types.ObjectId[];

  isEquipped: boolean;
  equippedTo?: Types.ObjectId | INft | null;

  isSell: boolean;
  price?: number;
  paymentSymbol: string;
  paymentMint: string;

  txSignature?: string;

  status: "pending" | "minted" | "failed";

  trial: Date | null | undefined;

  createdAt: Date;
  updatedAt: Date;
}

const NftSchema = new Schema<INft>(
  {
    owner: { type: String, required: true },

    character: { type: Schema.Types.ObjectId, ref: "Character" },
    rune: { type: Schema.Types.ObjectId, ref: "Rune" },

    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    royalty: { type: Number, default: 0 },
    base_name: { type: String, required: false },

    mintAddress: { type: String, required: true, unique: true },

    level: { type: Number, min: 1, default: 1 },
    exp: { type: Number, min: 0, default: 0 },

    hp: { type: Number, min: 0, required: true },
    atk: { type: Number, min: 0, required: true },
    def: { type: Number, min: 0, required: true },
    spd: { type: Number, min: 0, required: true },
    critRate: { type: Number, min: 0, max: 100, default: 0 },
    critDmg: { type: Number, min: 0, max: 1000, default: 0 },

    equipped: [{ type: Schema.Types.ObjectId, ref: "Nft" }],

    isEquipped: { type: Boolean, default: false },
    equippedTo: { type: Schema.Types.ObjectId, ref: "Nft", default: null },

    isSell: { type: Boolean, default: false },
    price: { type: Number, default: 0 },
    paymentSymbol: { type: String, default: "SOL" },
    paymentMint: { type: String, default: "" },

    txSignature: { type: String },

    status: {
      type: String,
      enum: ["pending", "minted", "failed"],
      default: "pending",
    },

    // 🆕 TRIAL: hanya berlaku kalau status = pending
    trial: {
      type: Date,
      default: function (this: any) {
        return this.status === "pending"
          ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          : undefined;
      }
    },
  },
  { collection: "nfts", timestamps: true }
);

// 🔥 Auto-remove trial ketika status berubah menjadi "minted"
NftSchema.pre("save", function (next) {
  if (!this.isNew && this.isModified("status") && this.status === "minted") {
    this.trial = undefined; // hapus field trial
  }
  next();
});

export const Nft = mongoose.model<INft>("Nft", NftSchema);
