import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Model: Referral
 * Tujuan:
 * - Menyimpan data kode referral per pengguna (referrer)
 * - Melacak total bonus referral yang bisa diklaim & sudah diklaim
 * - Menyimpan histori transaksi referral (dari Gatcha)
 */

const ReferralSchema = new Schema({
  // 🔹 User yang punya kode referral
  referrerId: {
    type: Schema.Types.ObjectId,
    ref: "Auth",
    required: true,
    index: true,
  },

  // 🔹 Kode unik yang dibagikan (ex: MIKAEL10)
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
  },

  // 🔹 Total reward yang belum diklaim
  totalClaimable: {
    type: Number,
    default: 0,
  },

  // 🔹 Total reward yang sudah diklaim
  totalClaimed: {
    type: Number,
    default: 0,
  },

  // 🔹 Referral aktif (bisa dinonaktifkan jika abuse)
  isActive: {
    type: Boolean,
    default: true,
  },

  // 🔹 Log setiap transaksi referral (opsional)
  history: [
    {
      fromUserId: { type: Schema.Types.ObjectId, ref: "Auth" },
      packId: { type: Schema.Types.ObjectId, ref: "GatchaPack", default: null },
      txType: { type: String, default: "GATCHA" },
      amount: Number, // total transaksi Gatcha user baru
      reward: Number, // 10% dari amount
      txSignature: { type: String },
      createdAt: { type: Date, default: Date.now },
    },
  ],

  // 🔹 Timestamp
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const Referral = mongoose.model("Referral", ReferralSchema);
