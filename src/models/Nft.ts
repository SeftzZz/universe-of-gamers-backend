import mongoose, { Schema, Document, Types } from "mongoose";
import { ICharacter } from "./Character";

export interface INft extends Document {
  _id: any;
  owner: string; // wallet address user
  character: Types.ObjectId | ICharacter; // ref ke Character blueprint

  // metadata tambahan
  name: string;
  description: string;
  image: string;
  royalty?: number;

  level: number;
  exp: number;

  hp: number;
  atk: number;
  def: number;
  spd: number;
  critRate: number;
  critDmg: number;

  equipped?: {
    weapon?: string;
    armor?: string;
    rune?: string;
    [key: string]: string | undefined;
  };

  price?: number;
  txSignature?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NftSchema = new Schema<INft>(
  {
    owner: { type: String, required: true },
    character: { type: Schema.Types.ObjectId, ref: "Character", required: true },

    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    royalty: { type: Number, default: 0 },

    level: { type: Number, min: 1, default: 1 },
    exp: { type: Number, min: 0, default: 0 },

    hp: { type: Number, min: 1, required: true },
    atk: { type: Number, min: 0, required: true },
    def: { type: Number, min: 0, required: true },
    spd: { type: Number, min: 0, required: true },
    critRate: { type: Number, min: 0, max: 100, default: 0 },
    critDmg: { type: Number, min: 0, max: 500, default: 0 },

    equipped: {
      type: Map,
      of: String,
      default: {}
    },

    price: { type: Number },
    txSignature: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  },
  { collection: "nfts" }
);

export const Nft = mongoose.model<INft>("Nft", NftSchema);
