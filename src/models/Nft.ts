import mongoose, { Schema, Document, Types } from "mongoose";
import { ICharacter } from "./Character"; // pastikan path sesuai

/**
 * =====================
 *  NFT Interface
 * =====================
 */
export interface INft extends Document {
  name: string;
  description: string;
  image: string;
  price: number;
  metadata: object;
  txSignature?: string;
  createdAt: Date;
  character?: Types.ObjectId | ICharacter; // 🔗 reference ke Character
}

/**
 * =====================
 *  NFT Schema
 * =====================
 */
const NftSchema = new Schema<INft>({
  name: { type: String, required: true },
  description: String,
  image: String,
  price: Number,
  metadata: Object,
  txSignature: String,
  createdAt: { type: Date, default: Date.now },

  // 🔗 Relasi ke Character
  character: { type: Schema.Types.ObjectId, ref: "Character" }
});

/**
 * =====================
 *  Export NFT Model
 * =====================
 */
export const Nft = mongoose.model<INft>("Nft", NftSchema);
