import mongoose from "mongoose";

export interface IPendingTx extends mongoose.Document {
  userId: string;
  wallet: string;
  to?: string;
  mint?: string;
  amount?: number;
  txBase64: string;
  signedTx?: string;
  signature?: string;
  signedTxAdmin?: string;
  status: "admin_stage" | "pending" | "signed" | "confirmed" | "failed";
  createdAt: Date;
  signedAt?: Date;
  updatedAt?: Date;
}

const PendingTxSchema = new mongoose.Schema({
  // 🔹 User info
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "Auth", required: true },

  // 🔹 Wallet pengirim (sender)
  wallet: { type: String, required: true },

  // 🔹 Tujuan (recipient)
  to: { type: String },

  // 🔹 Info token
  mint: { type: String },    // mint address SPL token
  amount: { type: Number },  // nominal transfer

  // 🔹 Transaksi
  txBase64: { type: String, required: true }, // unsigned transaction
  signedTx: { type: String },                 // hasil tanda tangan base64
  signature: { type: String },
  signedTxAdmin: { type: String, default: null },                // signature blockchain setelah submit

  // 🔹 Status
  status: {
    type: String,
    enum: ["admin_stage", "pending", "signed", "confirmed", "failed"],
    default: "pending"
  },

  // 🔹 Timestamp
  createdAt: { type: Date, default: Date.now },
  signedAt: { type: Date },
  updatedAt: { type: Date, default: Date.now },
});

// 📌 Index untuk pencarian cepat
PendingTxSchema.index({ wallet: 1, status: 1 });
PendingTxSchema.index({ userId: 1, createdAt: -1 });

export const PendingTx = mongoose.model<IPendingTx>("PendingTx", PendingTxSchema);
