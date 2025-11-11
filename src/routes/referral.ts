import express, { Request, Response } from "express";
import dotenv from "dotenv";
import bs58 from "bs58";
import mongoose from "mongoose";
import { authenticateJWT } from "../middleware/auth";
import { Referral } from "../models/Referral";
import Auth from "../models/Auth";
import {
  Connection,
  SystemProgram,
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

dotenv.config();
const router = express.Router();

/* ============================================================
   🔧 Solana Configuration
============================================================ */
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

if (!process.env.ADMIN_PRIVATE_KEY) {
  throw new Error("Missing ADMIN_PRIVATE_KEY in .env");
}

const adminSecret = bs58.decode(process.env.ADMIN_PRIVATE_KEY);
const adminKeypair = Keypair.fromSecretKey(adminSecret);

console.log("✅ Loaded admin wallet:", adminKeypair.publicKey.toBase58());

/* ============================================================
   🔹 POST /referral/claim — Check email, verify referral, transfer SOL
============================================================ */
router.post("/claim", authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    if (!userId) throw new Error("User not authenticated.");

    console.log("──────────────────────────────────────────────");
    console.log("⚙️  [Referral Claim] START for user:", userId);
    console.log("🕒  Timestamp:", new Date().toISOString());

    // 1️⃣ Ambil data user
    const user = await Auth.findById(userId).lean();
    if (!user) throw new Error("User not found.");
    console.log("📧 User email:", user.email || "(no email)");

    // 2️⃣ Ambil data referral milik user
    const referral = await Referral.findOne({ referrerId: userId });
    if (!referral) throw new Error("Referral not found for this user.");
    if (!referral.isActive) throw new Error("Referral inactive or blocked.");

    console.log("💾 Referral found:");
    console.table({
      totalClaimable_SOL: referral.totalClaimable,
      totalClaimed_SOL: referral.totalClaimed,
      historyRecords: referral.history.length,
    });

    // 3️⃣ Pastikan email cocok
    const referrerAuth = await Auth.findById(referral.referrerId).lean();
    if (!referrerAuth) throw new Error("Referrer account not found.");
    if (referrerAuth.email !== user.email) {
      console.warn(`⚠️ Email mismatch! Expected: ${referrerAuth.email}, Got: ${user.email}`);
      throw new Error("Email mismatch — this referral does not belong to your account.");
    }

    // 4️⃣ Cek saldo claimable (dalam SOL)
    const claimableSOL = referral.totalClaimable || 0;
    console.log("💰 Claimable balance (SOL):", claimableSOL);

    if (claimableSOL <= 0) {
      console.log("🪫 User has no claimable balance.");
      return res.status(400).json({
        error: "No claimable SOL balance available.",
        currentSOL: claimableSOL,
      });
    }

    // === Fetch harga SOL↔USD dari CoinGecko ===
    console.log("🌐 Fetching real-time SOL↔USD price from CoinGecko...");
    let solPriceUsd = 0;
    try {
      const cgRes = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
      );
      const cgData = await cgRes.json();
      solPriceUsd = cgData.solana?.usd || 0;
      if (!solPriceUsd) throw new Error("Missing SOL price from CoinGecko");
      console.log(`💹 1 SOL = $${solPriceUsd.toFixed(2)} USD`);
    } catch (err) {
      console.warn("⚠️ CoinGecko fetch failed, fallback = $100");
      solPriceUsd = 100;
    }

    // Hitung konversi SOL → USD
    const claimableUSD = claimableSOL * solPriceUsd;
    console.log(`💱 ${claimableSOL} SOL ≈ $${claimableUSD.toFixed(2)} USD`);

    if (claimableUSD < 10) {
      const missing = (10 - claimableUSD).toFixed(2);
      console.warn(`🚫 Claim rejected: below $10 threshold (${claimableUSD} USD)`);
      return res.status(400).json({
        error: "Minimum claimable value is $10 USD.",
        currentUSD: claimableUSD,
        currentSOL: claimableSOL,
        missingUSD: missing,
      });
    }

    // 5️⃣ Ambil wallet Phantom penerima
    const phantomWallet = user.wallets?.find(w => w.provider === "phantom");
    if (!phantomWallet) throw new Error("No Phantom wallet linked to your account.");

    const recipientPubkey = new PublicKey(phantomWallet.address);
    console.log("💼 Recipient Phantom wallet:", recipientPubkey.toBase58());

    // 6️⃣ Transfer SOL
    const lamports = Math.floor(claimableSOL * LAMPORTS_PER_SOL);
    console.log(`💸 Preparing transfer of ${claimableSOL} SOL (${lamports} lamports)`);

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: adminKeypair.publicKey,
        toPubkey: recipientPubkey,
        lamports,
      })
    );

    console.log("📦 Sending transaction to Solana RPC...");
    const signature = await sendAndConfirmTransaction(connection, tx, [adminKeypair]);

    console.log("✅ Transfer success!");
    console.table({
      Signature: signature,
      Explorer: `https://solscan.io/tx/${signature}?cluster=mainnet`,
    });

    // 7️⃣ Update referral data
    referral.totalClaimed += claimableSOL;
    referral.totalClaimable = 0;
    referral.history.push({
      txType: "CLAIM",
      amount: 0,
      reward: claimableSOL,
      txSignature: signature,
      createdAt: new Date(),
    });

    await referral.save();
    console.log("🧾 Referral data updated successfully.");

    // 8️⃣ Kirim response sukses
    res.json({
      message: "✅ Referral claimed and SOL transferred successfully",
      claimedSOL: claimableSOL,
      claimedUSD: claimableUSD,
      solPriceUsd,
      signature,
      explorer: `https://solscan.io/tx/${signature}?cluster=mainnet`,
    });

    console.log("🎉 [Referral Claim Completed]");
    console.log("──────────────────────────────────────────────");

  } catch (err: any) {
    console.error("❌ [Referral Claim Error]:", err.message);
    if (err.stack) console.error(err.stack);
    console.log("──────────────────────────────────────────────");
    res.status(400).json({ error: err.message });
  }
});

export default router;
