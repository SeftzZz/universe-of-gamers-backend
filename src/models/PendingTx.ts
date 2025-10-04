import mongoose from "mongoose";

const PendingTxSchema = new mongoose.Schema({
  userId: String,
  wallet: String,
  txBase64: String,
  signedTx: String, // 🆕 hasil tanda tangan base64 disimpan di sini
  status: { type: String, enum: ["pending", "signed", "failed"], default: "pending" },
  signature: String, // 🆗 signature blockchain (setelah submit)
  createdAt: { type: Date, default: Date.now },
  signedAt: Date,
});

export const PendingTx = mongoose.model("PendingTx", PendingTxSchema);
