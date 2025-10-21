import mongoose, { Schema, Document, Types } from "mongoose";
import { ICharacter } from "./Character";
import { IRune } from "./Rune";

export interface INft extends Document {
  _id: any;
  owner: string; // wallet address user
  character?: Types.ObjectId | ICharacter; // ref ke Character blueprint
  rune?: Types.ObjectId | IRune;           // ref ke Rune blueprint

  // metadata tambahan
  name: string;
  description: string;
  image: string;
  royalty?: number;
  base_name?: string;

  // 🔥 address mint di blockchain (unik & wajib)
  mintAddress: string;

  level: number;
  exp: number;

  hp: number;
  atk: number;
  def: number;
  spd: number;
  critRate: number;
  critDmg: number;

  // ✅ sekarang equipped jadi array of rune NFT IDs
  equipped: Types.ObjectId[]; // daftar rune NFT yang terpasang

  // 🔥 Status rune (kalau NFT ini adalah Rune)
  isEquipped: boolean;                     // apakah rune ini sedang dipakai
  equippedTo?: Types.ObjectId | INft | null; // ref ke NFT Character yang memakai rune

  isSell: boolean;
  price?: number;
  paymentSymbol: string, // ex: SOL, USDC, BONK, UOG
  paymentMint: string,      // optional: mint address SPL token

  txSignature?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NftSchema = new Schema<INft>(
  {
    owner: { type: String, required: true },

    // opsional: bisa karakter atau rune
    character: { type: Schema.Types.ObjectId, ref: "Character" },
    rune: { type: Schema.Types.ObjectId, ref: "Rune" },

    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    royalty: { type: Number, default: 0 },
    base_name: { type: String, required: false },

    // 🔥 wajib ada mintAddress (unik di blockchain)
    mintAddress: { type: String, required: true, unique: true },

    level: { type: Number, min: 1, default: 1 },
    exp: { type: Number, min: 0, default: 0 },

    hp: { type: Number, min: 1, required: true },
    atk: { type: Number, min: 0, required: true },
    def: { type: Number, min: 0, required: true },
    spd: { type: Number, min: 0, required: true },
    critRate: { type: Number, min: 0, max: 100, default: 0 },
    critDmg: { type: Number, min: 0, max: 500, default: 0 },

    // ✅ ganti jadi array of rune NFT IDs
    equipped: [{ type: Schema.Types.ObjectId, ref: "Nft" }],

    isEquipped: { type: Boolean, default: false },
    equippedTo: { type: Schema.Types.ObjectId, ref: "Nft", default: null },

    isSell: { type: Boolean, default: false },
    price: { type: Number, default: 0 },
    paymentSymbol: { type: String, default: "SOL" }, // ex: SOL, USDC, BONK, UOG
    paymentMint: { type: String, default: "" },      // optional: mint address SPL token

    txSignature: { type: String },
  },
  { collection: "nfts", timestamps: true }
);

export const Nft = mongoose.model<INft>("Nft", NftSchema);
