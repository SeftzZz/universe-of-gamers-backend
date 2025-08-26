import mongoose, { Schema, Document } from "mongoose";

export interface INft extends Document {
  name: string;
  description: string;
  image: string;
  price: number;
  metadata: object;
  txSignature?: string;
  createdAt: Date;
}

const NftSchema = new Schema<INft>({
  name: { type: String, required: true },
  description: String,
  image: String,
  price: Number,
  metadata: Object,
  txSignature: String,
  createdAt: { type: Date, default: Date.now }
});

export const Nft = mongoose.model<INft>("Nft", NftSchema);
