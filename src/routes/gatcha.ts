import express from "express";
import bs58Module from "bs58";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { BN } from "@project-serum/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getMint,
  createTransferInstruction
} from "@solana/spl-token";
import { GatchaPack } from "../models/GatchaPack";
import { Nft, INft } from "../models/Nft";
import { doGatchaRoll, doMultiGatchaRolls } from "../services/gatchaService";
import { decrypt } from "../utils/cryptoHelper";
import Auth from "../models/Auth";
import { Referral } from "../models/Referral";
import { authenticateJWT, AuthRequest } from "../middleware/auth";
import { buildMintTransactionPhantom } from "../services/mintService";
import { generateNftMetadata } from "../services/metadataGenerator";
import { Client } from "@solana-tracker/data-api";
import { broadcast } from "../index";

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import https from "https";

const router = express.Router();

// ✅ Fix default import (ESM / CJS interop)
const bs58: any = (bs58Module as any).default || bs58Module;

let lastGatchaPackSnapshot: any[] | null = null;

export const getAdminKeypair = (): Keypair => {
  console.log("🔑 [getAdminKeypair] Loading from .env...");
  const secret = process.env.ADMIN_TREASURY_KEY;

  if (!secret) {
    console.error("❌ [getAdminKeypair] Missing ADMIN_TREASURY_KEY in .env");
    throw new Error("Missing ADMIN_TREASURY_KEY in .env");
  }

  try {
    const secretKey = bs58.decode(secret.trim());
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log("👑 [Admin Keypair Loaded]", keypair.publicKey.toBase58());
    return keypair;
  } catch (err: any) {
    console.error("❌ [getAdminKeypair] Invalid key format:", err.message);
    throw new Error("Invalid ADMIN_TREASURY_KEY format (must be base58)");
  }
};

const client = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY as string });

export async function applyReferralReward(
  userId: any,
  amount: number | undefined,
  paymentMint: string | undefined,
  txSignature: string | undefined
) {
  try {
    const finalAmount = Number(amount) || 0;
    const finalMint = paymentMint || "So11111111111111111111111111111111111111111";
    const finalTx = txSignature || "UNKNOWN_TX";

    // === Cari user & referrer ===
    const user = await Auth.findById(userId);
    if (!user || !user.usedReferralCode) {
      console.log("ℹ️ [Referral] User has no referrer, skip reward.");
      return;
    }

    const ref = await Referral.findById(user.usedReferralCode);
    if (!ref) {
      console.log("⚠️ [Referral] Referrer record not found for code:", user.usedReferralCode);
      return;
    }

    // === Ambil harga token ===
    let tokenPriceUsd = 0;
    let tokenSymbol = "UNKNOWN";
    try {
      const info = await client.getTokenInfo(String(finalMint));
      const pools = info?.pools || [];
      if (pools.length > 0 && pools[0].price?.usd) tokenPriceUsd = pools[0].price.usd;
      tokenSymbol = info?.token?.symbol || "TOKEN";
    } catch (err: any) {
      console.warn(`⚠️ [Referral] Failed to fetch price for ${finalMint}: ${err.message}`);
    }

    const amountUsd = tokenPriceUsd > 0 ? finalAmount * tokenPriceUsd : finalAmount;
    const rewardUsd = amountUsd * 0.1;
    if (rewardUsd <= 0) return console.log("⚠️ [Referral] No valid reward to apply.");

    ref.totalClaimable = (ref.totalClaimable || 0) + rewardUsd;
    ref.history.push({
      fromUserId: user._id,
      txType: "GATCHA",
      amount: finalAmount,
      reward: rewardUsd,
      paymentMint: finalMint,
      tokenSymbol,
      tokenPriceUsd,
      txSignature: finalTx,
      createdAt: new Date(),
    });

    await ref.save();

    console.log("💰 [Referral Reward Added]", {
      refCode: ref.code,
      tokenSymbol,
      price: `$${tokenPriceUsd.toFixed(4)}`,
      rewardUsd: rewardUsd.toFixed(4),
      totalClaimable: ref.totalClaimable.toFixed(4),
    });
  } catch (err: any) {
    console.error("❌ [Referral Error]", err.message);
  }
}

/* ================================================================
   🔥 AUTO WITHDRAW PRIZEPOOL + FORWARD TO ADMIN PROGRAM
================================================================ */
export async function withdrawPrizepoolAndForward(amountSol: number) {
  console.log("⚙️ [withdrawPrizepoolAndForward] START");

  const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
  const MARKET_CONFIG = new PublicKey(process.env.MARKET_CONFIG!);
  const TREASURY_PDA = new PublicKey(process.env.TREASURY_PDA!);

  const rpcUrl = process.env.SOLANA_CLUSTER!;
  const connection = new Connection(rpcUrl, "confirmed");

  // =====================================================
  // 🔑 Load admin multisig keypairs
  // =====================================================
  const admin1 = getAdminKeypair();
  const admin2 = getAdminKeypair(); 
  const adminMain = getAdminKeypair();

  // =============================================================
  // 🔑 Load admin program wallet from ENV (ADMIN_PRIVATE_KEY)
  // =============================================================
  const adminProgramSecret = process.env.ADMIN_PRIVATE_KEY;

  if (!adminProgramSecret) {
    throw new Error("❌ ADMIN_PRIVATE_KEY missing in .env");
  }

  let adminProgram: Keypair;

  try {
    const secretBytes = bs58.decode(adminProgramSecret.trim());
    adminProgram = Keypair.fromSecretKey(secretBytes);
  } catch (err: any) {
    console.error("❌ Invalid ADMIN_PRIVATE_KEY format:", err.message);
    throw new Error("ADMIN_PRIVATE_KEY must be a base58-encoded secret key");
  }

  console.log("👑 Admin Program:", adminProgram.publicKey.toBase58());

  // =====================================================
  // Setup Anchor provider
  // =====================================================
  const wallet = new anchor.Wallet(admin1);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  // =====================================================
  // Load IDL + Program
  // =====================================================
  const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!idl) throw new Error("IDL not found on chain");

  const program = new anchor.Program(idl, PROGRAM_ID, provider);

  // =====================================================
  // GET mintFeeBps FROM on-chain marketConfig
  // =====================================================
  const mc = await program.account.marketConfig.fetch(MARKET_CONFIG);
  const mintFeeBps = Number(mc.mintFeeBps?.toString() || "0");

  console.log("🔢 On-chain mintFeeBps =", mintFeeBps);

  // =====================================================
  // Hitung fee sebenarnya
  // =====================================================
  let finalAmountSol = amountSol; // default dari parameter

  if (mintFeeBps > 0) {
    // override menggunakan mintFeeBps yg benar
    finalAmountSol = amountSol * (mintFeeBps / 10_000);
  }

  console.log("💰 Final fee to withdraw (SOL):", finalAmountSol);

  const lamports = Math.floor(finalAmountSol * LAMPORTS_PER_SOL);
  console.log("💰 Withdraw Amount (lamports):", lamports);

  // =====================================================
  // Dummy mint untuk memuaskan Anchor SPL constraints
  // =====================================================
  const DUMMY_MINT = new PublicKey(
    "So11111111111111111111111111111111111111112"
  );

  const dummyAta = await getAssociatedTokenAddressSync(
    DUMMY_MINT,
    admin1.publicKey,
    true
  );

  // =====================================================
  // BUILD withdraw Treasury TX
  // =====================================================
  const tx = await program.methods
    .withdrawTreasury(new BN(lamports))
    .accounts({
      marketConfig: MARKET_CONFIG,
      treasuryPda: TREASURY_PDA,
      admin: adminMain.publicKey,
      signer1: admin1.publicKey,
      signer2: admin2.publicKey,
      mint: DUMMY_MINT,
      treasuryTokenAccount: dummyAta,
      adminTokenAccount: dummyAta,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .transaction();

  tx.feePayer = admin1.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // =====================================================
  // Sign multisig
  // =====================================================
  tx.partialSign(adminMain);
  tx.partialSign(admin1);
  tx.partialSign(admin2);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("❌ Simulation error:", sim.value.err);
    console.log(sim.value.logs);
    throw new Error("Simulation failed");
  }

  // =====================================================
  // SEND WITHDRAW TX
  // =====================================================
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log("🎉 Withdraw Success:", sig);

  // =====================================================
  // STEP 2: FORWARD TO ADMIN PROGRAM
  // =====================================================
  const balAdmin = await connection.getBalance(admin1.publicKey);
  const adminSol = balAdmin / LAMPORTS_PER_SOL;

  if (adminSol <= 0.001) {
    console.log("🪫 Admin1 tidak cukup SOL untuk forward.");
    return { withdrawSig: sig, forwarded: false };
  }

  const forwardSol = finalAmountSol;
  const forwardLamports = Math.floor(forwardSol * LAMPORTS_PER_SOL);

  console.log("🔁 Forwarding:", {
    from: admin1.publicKey.toBase58(),
    to: adminProgram.publicKey.toBase58(),
    forwardSol,
  });

  const forwardTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin1.publicKey,
      toPubkey: adminProgram.publicKey,
      lamports: forwardLamports,
    })
  );

  forwardTx.feePayer = admin1.publicKey;
  forwardTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  forwardTx.sign(admin1);

  const sim2 = await connection.simulateTransaction(forwardTx);
  if (sim2.value.err) {
    console.error("❌ Forward Simulation Failed:", sim2.value.err);
    console.log(sim2.value.logs);
    throw new Error("Forward simulation error");
  }

  const sigForward = await connection.sendRawTransaction(
    forwardTx.serialize()
  );
  await connection.confirmTransaction(sigForward, "confirmed");

  console.log("🎉 Forward Success:", sigForward);

  return {
    withdrawSig: sig,
    forwardSig: sigForward,
    forwarded: true,
  };
}

/**
 * ============================================================
 *   GATCHA AUTO WATCHER (REALTIME BROADCAST TANPA USER HIT)
 * ============================================================
 */
const WATCH_INTERVAL = 4000; // 4 seconds

async function runGatchaWatcher() {
  try {
    const packs = await GatchaPack.find({ priceSOL: { $gt: 0 } }).lean();

    if (!lastGatchaPackSnapshot) {
      // console.log("🆕 [WATCHER] Initial snapshot created");
      lastGatchaPackSnapshot = packs;

      console.log("📡 [WATCHER] First broadcast");
      broadcast({
        type: "gatcha_packs_update",
        timestamp: Date.now(),
        packs,
      });
      return;
    }

    const snapshotStr = JSON.stringify(lastGatchaPackSnapshot);
    const newDataStr = JSON.stringify(packs);

    if (snapshotStr !== newDataStr) {
      console.log("🟡 [WATCHER] GatchaPack changed");

      packs.forEach((newPack) => {
        const oldPack = lastGatchaPackSnapshot!.find(
          (p) => p._id.toString() === newPack._id.toString()
        );

        if (!oldPack) {
          console.log(`🆕 [WATCHER] New pack added: ${newPack._id}`);
          return;
        }

        const diff: any = {};
        const newPackRec = newPack as unknown as Record<string, any>;
        const oldPackRec = oldPack as unknown as Record<string, any>;

        Object.keys(newPackRec).forEach((key) => {
          if (JSON.stringify(newPackRec[key]) !== JSON.stringify(oldPackRec[key])) {
            diff[key] = {
              before: oldPackRec[key],
              after: newPackRec[key],
            };
          }
        });

        if (Object.keys(diff).length > 0) {
          console.log(`🔄 [WATCHER] Pack updated: ${newPack._id}`, diff);
        }
      });

      lastGatchaPackSnapshot = packs;

      console.log("📡 [WATCHER] Broadcast sent");
      broadcast({
        type: "gatcha_packs_update",
        timestamp: Date.now(),
        packs,
      });
    } else {
      // console.log("⏸ [WATCHER] No changes → No broadcast");
    }
  } catch (err: any) {
    console.error("❌ [WATCHER] Error:", err.message);
  }
}

const agent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false, // sementara false, bisa true setelah TLS OK
});

// ============================================================
// 🔥 Ambil harga SOL dari market (SolanaTracker)
// ============================================================
async function getUsdPrice(mint: string): Promise<number> {
  const url = `https://data.solanatracker.io/tokens/${mint}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": process.env.SOLANATRACKER_API_KEY || "d1df9e86-48aa-4875-bd20-b41bcad5c389",
  };

  const res = await fetch(url, { headers, agent }); // ⚡ gunakan https agent
  if (!res.ok)
    throw new Error(`Solana Tracker error ${res.status}: ${res.statusText}`);

  const data = await res.json();
  const pools = Array.isArray(data.pools) ? data.pools : [];
  const top = pools.sort(
    (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
  )[0];

  return top?.price?.usd ?? 0;
}

/* =======================================================================
   END OF WATCHER — ROUTER BELOW STILL NORMAL / WORKS AS REST ENDPOINT
======================================================================= */

// ============================================================
// 🔥 GET /gatcha-packs → override priceSOL dari priceUSD & harga SOL
// ============================================================
router.get("/", async (_req, res) => {
  try {
    const packs = await GatchaPack.find({ priceUSD: { $gt: 0 } })
      .lean()
      .sort({ createdAt: 1 });

    const solPrice = await getUsdPrice("So11111111111111111111111111111111111111112");
    const safeSolPrice = solPrice > 0 ? solPrice : 1;

    const mapped = packs.map((p) => {
      const usd = p.priceUSD ?? 0;

      // pastikan selalu number
      const solValue: number =
        usd > 0 ? usd / safeSolPrice : p.priceSOL ?? 0;

      return {
        ...p,
        priceSOL: Number(solValue.toFixed(6)),
      };
    });

    res.json(mapped);
  } catch (err: any) {
    console.error("❌ Error fetching packs:", err);
    res.status(500).json({ error: "Failed to fetch gatcha packs" });
  }
});

/**
 * CREATE Gatcha Pack
 */
router.post("/", async (req, res) => {
  try {
    const pack = new GatchaPack(req.body);
    await pack.save();
    res.status(201).json(pack);
  } catch (err: any) {
    console.error("❌ Error creating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to create gatcha pack" });
  }
});

/**
 * GET Gatcha Pack by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error fetching gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to fetch gatcha pack" });
  }
});

/**
 * UPDATE Gatcha Pack
 */
router.put("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error updating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to update gatcha pack" });
  }
});

/**
 * DELETE Gatcha Pack
 */
router.delete("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndDelete(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json({ message: "Gatcha pack deleted successfully" });
  } catch (err: any) {
    console.error("❌ Error deleting gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to delete gatcha pack" });
  }
});

/**
 * POST /pull
 * Generate NFT + metadata JSON
 */
router.post("/pull", async (req, res) => {
  try {
    const { packId, user, pulls = 1 } = req.body;
    if (!packId || !user) {
      return res.status(400).json({ error: "packId and user required" });
    }

    const pack = await GatchaPack.findById(packId).lean();
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    const results = [];
    for (let i = 0; i < pulls; i++) {
      const result = await doGatchaRoll(pack, user);
      results.push(result);
    }

    res.status(201).json({
      message: "Gatcha successful",
      pack: pack.name,
      pulls,
      results,
    });
  } catch (err: any) {
    console.error("❌ Error in gatcha pull:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** 
 * POST /:id/pull/custodian
 * Gatcha versi custodial:
 * - Ambil privateKey user dari Auth
 * - Decrypt
 * - Sign & broadcast TX di backend
 */
// Untuk demo custodian, ga perlu paymentMint
router.post("/:id/pull/custodian", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    // const { id: userId } = req.body;
    // const { id: packId } = req.params;

    // console.log("⚡ Custodian gatcha request:", { userId, packId });

    // // === Ambil user
    // const authUser = await Auth.findById(userId);
    // if (!authUser) return res.status(404).json({ error: "User not found" });

    // // === Ambil semua wallet user (hanya eksternal)
    // const allWallets = Array.isArray(authUser.wallets) ? authUser.wallets : [];

    // // === Cari wallet Solana
    // const custodian = allWallets.find(
    //   (w: any) => w.provider === "phantom" || w.provider === "solana" || w.chain === "solana"
    // );

    // // === Validasi wallet
    // if (!custodian) {
    //   return res.status(400).json({ error: "No Solana wallet found in user account" });
    // }

    // console.log("🪙 Using external Solana wallet:", custodian.address);

    // // Ambil pack
    // const pack = await GatchaPack.findById(packId);
    // if (!pack) return res.status(404).json({ error: "Pack not found" });

    // // Roll gatcha multi (0 NFT)
    // const rolls = await doMultiGatchaRolls(pack, custodian.address, 0);

    // const processedResults = [];

    // for (let i = 0; i < rolls.length; i++) {
    //   let { nft } = rolls[i];

    //   const mintKp = Keypair.generate();
    //   const mintAddress = mintKp.publicKey.toBase58();
    //   nft.mintAddress = mintAddress;

    //   if (nft.character) nft = await nft.populate("character");
    //   if (nft.rune) nft = await nft.populate("rune");

    //   // === Generate nama & base_name
    //   if (nft.character && (nft.character as any)._id) {
    //     const charId = (nft.character as any)._id;
    //     const charName = (nft.character as any).name;
    //     const existingCount = await Nft.countDocuments({ character: charId });
    //     nft.name = `${charName} #${existingCount + 1}`;
    //     nft.base_name = charName;
    //   } else if (nft.rune && (nft.rune as any)._id) {
    //     const runeId = (nft.rune as any)._id;
    //     const runeName = (nft.rune as any).name;
    //     const existingCount = await Nft.countDocuments({ rune: runeId });
    //     nft.name = `${runeName} #${existingCount + 1}`;
    //     nft.base_name = runeName;
    //   } else {
    //     throw new Error("NFT tidak punya karakter atau rune");
    //   }

    //   await nft.save();

    //   // === Metadata JSON dummy
    //   const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
    //   const outputDir = path.join(process.cwd(), baseDir);
    //   if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    //   const filePath = path.join(outputDir, `${mintAddress}.json`);
    //   const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
    //   if (!metadataResult.success) throw new Error(`Metadata generation failed: ${metadataResult.error}`);

    //   processedResults.push({
    //     nft,
    //     blueprint: rolls[i].blueprint,
    //     rewardInfo: rolls[i].rewardInfo,
    //     mintAddress,
    //     metadata: metadataResult.metadata,
    //     filePath
    //   });
    // }

    // // === STEP 3: Apply Referral Reward (hanya sekali per transaksi)
    // console.log("🎁 Checking referral reward eligibility...");
    // const ownerUser = await Auth.findOne({
    //   $or: [
    //     { 'wallets.address': custodian.address },
    //     { 'custodialWallets.address': custodian.address },
    //   ],
    // });

    // if (ownerUser) {
    //   const totalAmount = (pack.priceSOL || 0); // bisa diganti total semua NFT jika multi
    //   await applyReferralReward(
    //     ownerUser._id,
    //     totalAmount,
    //     "So11111111111111111111111111111111111111112",
    //     `CUSTODIAN_${Date.now()}`
    //   );
    //   console.log("💰 Referral reward applied successfully.");
    // } else {
    //   console.log("⚠️ [Referral] Owner not found, skip reward.");
    // }

    // // // TX dummy
    // const resultsWithTx = processedResults.map(r => ({
    //   ...r,
    //   tx: {
    //     mintAddress: r.mintAddress,
    //     txSignature: `DUMMY_${Date.now()}_${r.mintAddress.slice(0, 6)}`
    //   }
    // }));

    res.json({
      success: true,
      message: "No Rewards"
    });
  } catch (err: any) {
    console.error("❌ Custodian gatcha error:", err);
    res.status(500).json({ error: err.message });
  }
});

// === PULL: Buat unsigned transaction untuk Phantom ===
router.post("/:id/pull", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { id: packId } = req.params;
    const { paymentMint, activeWallet } = req.body;
    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");

    console.log("⚡ [Phantom Gatcha] Start request:", { userId, packId, paymentMint, activeWallet });
    if (!activeWallet) return res.status(400).json({ error: "Missing active wallet address" });

    // === Ambil user & pack
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const pack = await GatchaPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    // === Pastikan wallet milik user
    const isValidWallet =
      authUser.wallets.some(w => w.address === activeWallet) ||
      authUser.custodialWallets?.some(w => w.address === activeWallet);
    if (!isValidWallet) return res.status(403).json({ error: "Invalid wallet address" });

    // === Cegah double pull (masih ada mint pending)
    // const existingPending = await Nft.findOne({ owner: activeWallet, status: "pending" });
    // if (existingPending) {
    //   console.log("🚫 Pending mint exists, skip new pull:", existingPending.mintAddress);
    //   return res.status(400).json({
    //     error: "You already have a pending mint. Please confirm it first.",
    //     mintAddress: existingPending.mintAddress,
    //   });
    // }

    console.log("🎁 Selected Pack:", {
      name: pack.name,
      priceSOL: pack.priceSOL,
      priceUOG: pack.priceUOG,
      type: paymentMint === "So11111111111111111111111111111111111111111" ? "SOL" : "UOG",
    });

    // === Roll reward
    console.log("🎲 Rolling reward...");
    let { nft, blueprint, rewardInfo } = await doGatchaRoll(pack, String(authUser._id));
    console.log("🎯 Roll result:", { nftType: nft.character ? "Character" : "Rune", blueprint, rewardInfo });

    // === Generate mint address
    const mintKp = Keypair.generate();
    const mintAddress = mintKp.publicKey.toBase58();
    nft.mintAddress = mintAddress;
    console.log("🪙 Generated Mint Address:", mintAddress);

    // === Populate karakter/rune
    if (nft.character) nft = await nft.populate("character");
    if (nft.rune) nft = await nft.populate("rune");

    // === Penamaan final
    let finalName = "";
    if (nft.character) {
      const char = nft.character as any;
      const count = await Nft.countDocuments({ character: char._id });
      finalName = `${char.name} #${count + 1}`;
      Object.assign(nft, {
        name: finalName,
        base_name: char.name,
        description: char.description || `${char.name} is a brave hero in Universe of Gamers.`,
        image: char.image || "https://api.universeofgamers.io/assets/placeholder.png",
        hp: char.baseHp,
        atk: char.baseAtk,
        def: char.baseDef,
        spd: char.baseSpd,
      });
    } else if (nft.rune) {
      const rune = nft.rune as any;
      const count = await Nft.countDocuments({ rune: rune._id });
      finalName = `${rune.name} #${count + 1}`;
      Object.assign(nft, {
        name: finalName,
        base_name: rune.name,
        description: rune.description || `${rune.name} — magical rune of power.`,
        image: rune.image || "https://api.universeofgamers.io/assets/placeholder.png",
        hp: rune.hpBonus || 1,
        atk: rune.atkBonus || 0,
        def: rune.defBonus || 0,
        spd: rune.spdBonus || 0,
        critRate: rune.critRateBonus || 0,
        critDmg: rune.critDmgBonus || 0,
      });
    } else {
      throw new Error("NFT not have character or rune");
    }

    console.log("🎨 NFT Final:", { name: nft.name, mintAddress, stats: { hp: nft.hp, atk: nft.atk, def: nft.def, spd: nft.spd } });

    // === Build unsigned TX untuk Phantom
    console.log("⚙️ Building unsigned transaction for Phantom...");
    const txData = await buildMintTransactionPhantom(
      activeWallet,
      {
        name: nft.name,
        symbol: "UOGNFT",
        uri: "",
        price: paymentMint === "So11111111111111111111111111111111111111111" ? pack.priceSOL || 0 : pack.priceUOG || 0,
        royalty: nft.royalty || 0,
      },
      paymentMint,
      mintKp
    );

    console.log("🧾 Unsigned TX Built:", {
      user: activeWallet,
      mint: txData.mint,
      paymentMint,
      mintPubkey: mintKp.publicKey.toBase58(),
    });

    // === Simpan pending NFT
    const newNft = await Nft.create({
      name: nft.name,
      base_name: nft.base_name,
      mintAddress: txData.mint,
      owner: activeWallet,
      txSignature: "",
      status: "pending",
      isSell: false,
      price: paymentMint === "So11111111111111111111111111111111111111111" ? pack.priceSOL || 0 : pack.priceUOG || 0,
      paymentSymbol: paymentMint === "So11111111111111111111111111111111111111111" ? "SOL" : "UOG",
      paymentMint,
      hp: nft.hp,
      atk: nft.atk,
      def: nft.def,
      spd: nft.spd,
      critRate: 0,
      critDmg: 0,
      level: 1,
      exp: 0,
      equipped: [],
      isEquipped: false,
      equippedTo: null,
      character: nft.character?._id,
      rune: nft.rune?._id,
    });

    console.log("💾 NFT Saved to DB:", { id: newNft._id, name: newNft.name, mint: newNft.mintAddress });

    // === Return ke frontend
    console.log("✅ [Phantom Gatcha] TX ready for signing:", { user: activeWallet, mintAddress: txData.mint, txLength: txData.transaction.length });
    return res.json({
      message: "Unsigned transaction ready for Phantom",
      transaction: txData.transaction,
      mintAddress: txData.mint,
      listing: txData.listing,
      rewardInfo,
      blueprint,
      nft,
      costs: {
        priceAmount: paymentMint === "So11111111111111111111111111111111111111111" ? pack.priceSOL || 0 : pack.priceUOG || 0,
        paymentMint,
      },
    });
  } catch (err: any) {
    console.error("❌ Gatcha build error:", err.message);
    if (req.body.mintAddress) {
      const nft = await Nft.findOne({ mintAddress: req.body.mintAddress });
      if (nft) {
        nft.status = "failed";
        await nft.save();
      }
    }
    res.status(400).json({ error: err.message });
  }
});

// === CONFIRM setelah Phantom sign dan submit tx ===
router.post("/:id/confirm", async (req, res) => {
  try {
    const { mintAddress, signedTx } = req.body;

    console.log("⚡ [Gatcha Confirm] Incoming request:", {
      mintAddress,
      signedTxLen: signedTx ? signedTx.length : 0,
    });

    if (!mintAddress || !signedTx)
      return res.status(400).json({ error: "Missing mintAddress or signedTx" });

    // === Step 1: Siapkan koneksi & admin signer ===
    const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    // const adminKeypair = getAdminKeypair();

    // console.log("👑 [Admin Keypair Loaded]", adminKeypair.publicKey.toBase58());

    // === Step 2: Decode TX dari Phantom (signed oleh user) ===
    const tx = Transaction.from(bs58.decode(signedTx));
    console.log("🧩 Decoded TX signers:");
    tx.signatures.forEach((s, i) => {
      console.log(`#${i} ${s.publicKey.toBase58()} signed=${!!s.signature}`);
    });

    // ✅ Validasi tanda tangan user (seller)
    if (!tx.signatures?.some(s => s.signature)) {
      throw new Error("No user signature found in Phantom TX");
    }

    // ✅ Log tanda tangan sebelum ditambah admin
    console.log("🖋️ Signers before adding admin:", 
      tx.signatures.map(s => ({
        pubkey: s.publicKey?.toBase58(),
        signed: !!s.signature,
      }))
    );

    // === Step 3: Admin ikut tanda tangan (partial sign) ===
    // tx.partialSign(adminKeypair);
    // console.log(`✍️ Added admin signature: ${adminKeypair.publicKey.toBase58()}`);

    // === Step 4: Validasi fee payer & log final signatures ===
    if (tx.feePayer) {
      console.log("💸 Fee payer:", tx.feePayer.toBase58());
    } else {
      throw new Error("Missing feePayer in transaction");
    }

    console.log("🖋️ Signers before send:",
      tx.signatures.map(s => ({
        pubkey: s.publicKey?.toBase58(),
        signed: !!s.signature,
      }))
    );

    // === Step 5: Kirim transaksi ke jaringan ===
    console.log("🚀 Sending raw transaction to network...");
    const rawTx = tx.serialize();
    const txSignature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: "processed",
    });

    console.log("⏳ Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction(txSignature, "confirmed");

    console.log("✅ TX broadcasted & confirmed:", {
      mintAddress,
      txSignature,
      slot: confirmation?.context?.slot,
    });

    // === Step 6: Update NFT record ===
    const nft = await Nft.findOne({ mintAddress }).populate("character").populate("rune");
    if (!nft) {
      console.error("❌ NFT not found in DB:", mintAddress);
      return res.status(404).json({ error: "NFT not found" });
    }

    nft.txSignature = txSignature;
    nft.status = "minted";
    await nft.save();

    console.log("💾 NFT updated in DB:", {
      id: nft._id,
      name: nft.name,
      owner: nft.owner,
      txSignature,
    });

    // === Step 7: Apply referral reward ===
    const ownerUser = await Auth.findOne({
      $or: [
        { "wallets.address": nft.owner },
        { "custodialWallets.address": nft.owner },
      ],
    });

    if (ownerUser) {
      await applyReferralReward(
        ownerUser._id,
        nft.price,
        nft.paymentMint,
        nft.txSignature
      );
    } else {
      console.log("⚠️ [Referral] Owner not found, skip reward.");
    }

    // === Step 8: Generate metadata ===
    const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
    const outputDir = path.join(process.cwd(), baseDir);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${mintAddress}.json`);

    console.log("🧠 Generating metadata JSON...");
    const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
    if (!metadataResult.success)
      throw new Error(`Metadata generation failed: ${metadataResult.error}`);

    fs.writeFileSync(filePath, JSON.stringify(metadataResult.metadata, null, 2));
    const metadataUri = `https://api.universeofgamers.io/api/nft/${mintAddress}/metadata`;

    // Tambah image jika kosong
    if (!nft.image || nft.image === "") {
      const imageFromMeta = metadataResult.metadata?.image || null;
      if (imageFromMeta) {
        nft.image = imageFromMeta;
        await nft.save();
        console.log("🖼️ NFT image updated from metadata:", imageFromMeta);
      } else {
        console.warn("⚠️ No image found in metadata for:", mintAddress);
      }
    }

    console.log("🎉 [Gatcha Confirm Success]", {
      name: nft.name,
      mintAddress,
      image: nft.image,
      type: nft.character ? "Character" : nft.rune ? "Rune" : "Unknown",
      metadataUri,
      price: nft.price,
      paymentMint: nft.paymentMint,
    });

    // =====================================================
    // 🟣 Step X: Withdraw Prizepool (10% from NFT Price)
    // =====================================================
    try {
      if (nft.price) {
        const feeSol = nft.price * 0.10;
        console.log(`💰 [Prizepool] Auto-withdraw triggered: ${feeSol} SOL`);

        await withdrawPrizepoolAndForward(nft.price);

        console.log(`✅ Prizepool withdraw forwarded successfully: ${feeSol} SOL`);
      } else {
        console.warn("⚠️ NFT price empty, skip prizepool withdraw.");
      }
    } catch (err: any) {
      console.error("❌ Prizepool withdraw error:", err.message);
    }

    res.json({
      message: "🎲 Gatcha success!",
      rewardInfo: null,
      blueprint: null,
      nft,
      metadata: {
        path: filePath,
        metadata: metadataResult.metadata,
      },
      mintAddress,
      signature: txSignature,
      listing: null,
      costs: {
        priceAmount: nft.price || 0,
        paymentMint: nft.paymentMint || "unknown",
      },
    });
  } catch (err: any) {
    console.error("❌ Gatcha confirm error:", err.message);

    if (req.body.mintAddress) {
      const failedNft = await Nft.findOne({ mintAddress: req.body.mintAddress });
      if (failedNft && failedNft.status === "pending") {
        console.log(`🗑️ Deleting failed NFT: ${failedNft.name} (${failedNft.mintAddress})`);
        await failedNft.deleteOne();
      }
    }

    return res.status(400).json({ error: "Gatcha payment failed." });
  }
});

// router.post("/:id/pull", authenticateJWT, async (req: AuthRequest, res) => {
//   try {
//     const { id: userId } = req.user;
//     const { id: packId } = req.params;
//     const { paymentMint } = req.body;

//     console.log("⚡ Custodian gatcha request:", { userId, packId, paymentMint });

//     // === Ambil user & custodian wallet
//     const authUser = await Auth.findById(userId);
//     if (!authUser) return res.status(404).json({ error: "User not found" });

//     const custodian = authUser.custodialWallets.find(w => w.provider === "solana");
//     if (!custodian) return res.status(400).json({ error: "No Solana wallet" });

//     const decrypted = decrypt(custodian.privateKey);
//     const userKp = Keypair.fromSecretKey(bs58.decode(decrypted));
//     console.log("🔓 Custodian wallet:", userKp.publicKey.toBase58());

//     const anchorLib = await import("@project-serum/anchor");
//     const provider = anchorLib.AnchorProvider.env();
//     const conn = provider.connection;

//     // === Ambil pack
//     const pack = await GatchaPack.findById(packId);
//     if (!pack) return res.status(404).json({ error: "Pack not found" });

//     // 🧾 Log detail pack
//     console.log("🎁 Gatcha Pack Selected ===============================");
//     console.log(`📦 Pack ID       : ${pack._id}`);
//     console.log(`🏷️  Name          : ${pack.name}`);
//     console.log(`📝 Description   : ${pack.description || "-"}`);
//     console.log(`💰 Price (SOL)   : ${pack.priceSOL || 0}`);
//     console.log(`🪙 Price (UOG)   : ${pack.priceUOG || 0}`);
//     console.log(`📅 Created At    : ${pack.createdAt}`);
//     console.log(`📅 Updated At    : ${pack.updatedAt}`);

//     if (pack.rewards && pack.rewards.length > 0) {
//       console.log("🎯 Rewards Table:");
//       console.log("─────────────────────────────────────────────");
//       pack.rewards.forEach((r, i) => {
//         console.log(
//           `  #${i + 1}. Type: ${r.type.padEnd(10)} | Rarity: ${r.rarity.padEnd(10)} | Chance: ${r.chance}%`
//         );
//       });
//       console.log("─────────────────────────────────────────────");
//     } else {
//       console.log("⚠️  No rewards configured for this pack.");
//     }
//     console.log("========================================================");

//     let priceAmount = 0;

//     if (paymentMint === "So11111111111111111111111111111111111111111") {
//       const balanceLamports = await conn.getBalance(userKp.publicKey);
//       const balanceSol = balanceLamports / anchorLib.web3.LAMPORTS_PER_SOL;
//       priceAmount = pack.priceSOL || 0;

//       const MIN_SOL_RENT = 0.005; // realistic buffer
//       const totalNeeded = priceAmount + MIN_SOL_RENT;

//       if (balanceSol < totalNeeded) {
//         const deficit = (totalNeeded - balanceSol).toFixed(6);
//         return res.status(400).json({
//           error: "Insufficient SOL balance to perform gatcha.",
//           suggestion: `You need at least ${totalNeeded.toFixed(6)} SOL but currently have ${balanceSol.toFixed(6)} SOL.`,
//           details: `Add ${deficit} SOL more to cover mint account rent and network fees.`,
//         });
//       }

//       console.log("💰 [BALANCE CHECK - SOL]");
//       console.log(`👤 Wallet: ${userKp.publicKey.toBase58()}`);
//       console.log(`🔹 Current SOL Balance : ${balanceSol.toFixed(4)} SOL`);
//       console.log(`🔸 Pack Price (SOL)    : ${priceAmount} SOL`);
//       console.log(`📊 Remaining After Buy : ${(balanceSol - priceAmount).toFixed(4)} SOL`);
//       console.log("──────────────────────────────────────────────");

//       if (balanceSol < priceAmount) {
//         return res.status(400).json({
//           error: "Insufficient SOL balance",
//           balance: balanceSol,
//           required: priceAmount,
//         });
//       }
//     } else if (paymentMint === process.env.UOG_MINT) {
//       const UOG_MINT = new PublicKey(process.env.UOG_MINT!);
//       const tokenAccounts = await conn.getTokenAccountsByOwner(userKp.publicKey, { mint: UOG_MINT });

//       if (tokenAccounts.value.length === 0) {
//         return res.status(400).json({ error: "User has no UOG account" });
//       }

//       const accountInfo = await conn.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
//       const balanceUOG = parseFloat(accountInfo.value.uiAmountString || "0");
//       priceAmount = pack.priceUOG || 0;

//       console.log("💰 [BALANCE CHECK - UOG]");
//       console.log(`👤 Wallet: ${userKp.publicKey.toBase58()}`);
//       console.log(`🔹 Current UOG Balance : ${balanceUOG.toFixed(2)} UOG`);
//       console.log(`🔸 Pack Price (UOG)    : ${priceAmount} UOG`);
//       console.log(`📊 Remaining After Buy : ${(balanceUOG - priceAmount).toFixed(2)} UOG`);
//       console.log("──────────────────────────────────────────────");

//       if (balanceUOG < priceAmount) {
//         return res.status(400).json({
//           error: "Insufficient UOG balance",
//           balance: balanceUOG,
//           required: priceAmount,
//         });
//       }

//     } else {
//       return res.status(400).json({ error: "Invalid paymentMint" });
//     }

//     // === Roll gatcha
//     let { nft, blueprint, rewardInfo } = await doGatchaRoll(pack, custodian.address);

//     // === Generate mint keypair
//     const mintKp = Keypair.generate();
//     const mintAddress = mintKp.publicKey.toBase58();
//     nft.mintAddress = mintAddress;

//     // === Populate char/rune + naming
//     if (nft.character) nft = await nft.populate("character");
//     if (nft.rune) nft = await nft.populate("rune");

//     let finalName: string;
//     if (nft.character && (nft.character as any)._id) {
//       const charId = (nft.character as any)._id;
//       const charName = (nft.character as any).name;
//       const existingCount = await Nft.countDocuments({ character: charId });
//       finalName = `${charName} #${existingCount + 1}`;
//       nft.name = finalName;
//       nft.base_name = charName;
//     } else if (nft.rune && (nft.rune as any)._id) {
//       const runeId = (nft.rune as any)._id;
//       const runeName = (nft.rune as any).name;
//       const existingCount = await Nft.countDocuments({ rune: runeId });
//       finalName = `${runeName} #${existingCount + 1}`;
//       nft.name = finalName;
//       nft.base_name = runeName;
//     } else {
//       throw new Error("NFT tidak punya karakter atau rune untuk generate name");
//     }
//     console.log("DEBUG finalName:", finalName);

//     // === Direktori metadata
//     const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
//     const outputDir = path.join(process.cwd(), baseDir);
//     if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
//     const filePath = path.join(outputDir, `${mintAddress}.json`);

//     try {
//       // === 1️⃣ Bayar + Mint (langsung dari buildMintTransactionPhantom)
//       const { mintSignature, mint, listing } = await buildMintTransactionPhantom(
//         custodian.address,
//         {
//           name: nft.name,
//           symbol: "UOGNFT",
//           uri: "", // metadata dibuat setelah mint sukses
//           price: priceAmount,
//           royalty: nft.royalty || 0,
//         },
//         paymentMint,
//         // userKp,
//         mintKp
//       );

//       if (!mintSignature) throw new Error("Mint transaction failed");

//       console.log("✅ Payment + Mint confirmed:", { mintSignature });

//       // === 3️⃣ Simpan ke database lebih awal agar bisa ditemukan saat generate metadata
//       nft.txSignature = mintSignature;
//       nft.owner = userKp.publicKey.toBase58();
//       nft.isSell = false;
//       nft.price = 0;
//       await nft.save();
//       await Nft.findByIdAndUpdate(nft._id, { mintAddress });

//       // === 4️⃣ Generate metadata setelah NFT tersimpan
//       const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
//       if (!metadataResult.success) throw new Error(`Metadata generation failed: ${metadataResult.error}`);

//       fs.writeFileSync(filePath, JSON.stringify(metadataResult.metadata, null, 2));
//       console.log(`✅ Metadata for NFT ${mintAddress} saved to ${filePath}`);

//       const metadataUri = `https://api.universeofgamers.io/api/nft/${mintAddress}/metadata`;

//       // (Optional) — bisa update metadata URI on-chain lewat metode updateMetadataUri()
//       // await updateNftMetadataUri(mintAddress, metadataUri, userKp);

//       // === 5️⃣ Response sukses
//       res.json({
//         message: "🎲 Gatcha success!",
//         rewardInfo,
//         blueprint,
//         nft,
//         metadata: {
//           path: filePath,
//           metadata: metadataResult.metadata,
//         },
//         mintAddress,
//         signature: mintSignature,
//         listing,
//         costs: {
//           priceAmount,
//           paymentMint,
//         },
//       });
//     } catch (err: any) {
//       console.error("❌ Gatcha failed!");
//       console.error("───────────────────────────────");

//       // 🧩 Error message & stack
//       console.error("🧩 Error Message :", err.message || "Unknown error");
//       if (err.code) console.error("📦 Error Code    :", err.code);
//       if (err.name) console.error("📛 Error Name    :", err.name);
//       if (err.stack) console.error("📜 Stack Trace   :", err.stack.split("\n").slice(0, 6).join("\n"));

//       // 🧠 Solana / Anchor diagnostics
//       if (err.logs) {
//         console.error("📜 On-chain Logs:");
//         err.logs.forEach((log: string) => console.error("   ", log));
//       }

//       if (err.errorLogs) {
//         console.error("📜 Anchor Error Logs:");
//         err.errorLogs.forEach((log: string) => console.error("   ", log));
//       }

//       if (err.programErrorStack) {
//         console.error("🧩 ProgramErrorStack:", err.programErrorStack);
//       }

//       // 🧾 Transaction simulation failure
//       if (err.simulationResponse) {
//         console.error("🧪 Simulation Result:");
//         console.error(JSON.stringify(err.simulationResponse, null, 2));
//       }

//       // 🔍 Check Solana-specific fields
//       if (err.signature) console.error("🖋️ TX Signature :", err.signature);
//       if (err.transactionMessage) console.error("📜 TX Message :", JSON.stringify(err.transactionMessage, null, 2));
//       if (err.transactionInstruction) console.error("📦 TX Instruction :", JSON.stringify(err.transactionInstruction, null, 2));

//       console.error("───────────────────────────────");

//       // 🧠 Intelligent error mapping
//       const msg = (err.message || "").toLowerCase();
//       const logs = JSON.stringify(err.logs || []).toLowerCase();

//       if (msg.includes("custom:0x1") || logs.includes("custom:0x1")) {
//         console.error("💡 Detected: MathOverflow or invalid lamports transfer.");
//       }
//       if (msg.includes("insufficient funds") || logs.includes("insufficient")) {
//         console.error("💡 Detected: Seller wallet has insufficient balance.");
//       }
//       if (logs.includes("invalidprice")) {
//         console.error("💡 Detected: require!(price > 0 or mint_fee_spl > 0) failed on-chain.");
//       }
//       if (logs.includes("transfer") && logs.includes("failed")) {
//         console.error("💡 Detected: SPL transfer to treasury or seller_payment_ata failed.");
//       }

//       // 🎮 Contextual data
//       console.error("🎮 Gatcha Context:");
//       console.error({
//         userWallet: userKp?.publicKey?.toBase58?.() || "N/A",
//         custodian: custodian?.address || "N/A",
//         packName: pack?.name || "N/A",
//         priceAmount: priceAmount || 0,
//         paymentMint,
//         mintAddress: mintKp?.publicKey?.toBase58?.() || "N/A",
//         nftId: nft?._id || "N/A",
//         cluster: process.env.SOLANA_CLUSTER,
//         env: process.env.NODE_ENV,
//       });
//       console.error("───────────────────────────────");


//       // 📦 Contextual details
//       console.error("🎮 Gatcha Context:");
//       console.error(`👤 User Wallet   : ${userKp?.publicKey?.toBase58?.() || "N/A"}`);
//       console.error(`💼 Custodian Addr: ${custodian?.address || "N/A"}`);
//       console.error(`📦 Pack Name     : ${pack?.name || "N/A"}`);
//       console.error(`💰 Price Amount  : ${priceAmount || 0}`);
//       console.error(`🪙 Payment Mint  : ${paymentMint}`);
//       console.error(`🔑 Mint Address  : ${mintKp?.publicKey?.toBase58?.() || "N/A"}`);
//       console.error(`🧱 NFT ID (DB)   : ${nft?._id || "N/A"}`);
//       console.error("───────────────────────────────");

//       // 🧠 Intelligent error detection
//       const logString = JSON.stringify(err.message || "") + JSON.stringify(err.logs || "");
//       let userFriendlyMessage = "Payment or mint transaction failed.";
//       let suggestedAction = "";

//       if (/insufficient lamports/i.test(err.message) || /Custom:1/i.test(err.message)) {
//         return res.status(400).json({
//           error: "Insufficient SOL balance during transaction.",
//           suggestion: "Please top up at least 0.01 SOL to your wallet and try again.",
//         });
//       } else if (/Simulation failed.*Custom:1/i.test(logString)) {
//         userFriendlyMessage = "Transaction simulation failed due to low SOL balance.";
//         suggestedAction = "Top up your SOL wallet to ensure enough rent and fee balance for minting.";
//       } else if (/blockhash not found/i.test(logString)) {
//         userFriendlyMessage = "Transaction expired or was not confirmed in time.";
//         suggestedAction = "Please retry your gatcha after a few seconds.";
//       } else if (/Listing PDA on-curve/i.test(logString)) {
//         userFriendlyMessage = "Internal PDA derivation error.";
//         suggestedAction = "Please retry the gatcha — a new mint will be generated automatically.";
//       } else if (/custom program error/i.test(logString)) {
//         userFriendlyMessage = "On-chain program error occurred during minting.";
//         suggestedAction = "Please retry later or contact support if the issue persists.";
//       }

//       // === Rollback
//       try {
//         if (fs.existsSync(filePath)) {
//           fs.unlinkSync(filePath);
//           console.warn(`🗑️  Deleted metadata file: ${filePath}`);
//         }
//         if (nft && nft._id) {
//           await Nft.findByIdAndDelete(nft._id);
//           console.warn(`🗑️  Deleted NFT record ID: ${nft._id}`);
//         }
//       } catch (rollbackErr: any) {
//         console.warn("⚠️ Rollback warning:", rollbackErr.message);
//       }

//       console.error("───────────────────────────────");
//       console.error("❗ End of Gatcha Failure Log");
//       console.error("───────────────────────────────");

//       // === Send detailed JSON response to user
//       res.status(500).json({
//         error: userFriendlyMessage,
//         suggestion: suggestedAction,
//         details: err.message,
//       });
//     }
//   } catch (err: any) {
//     console.error("❌ Gatcha error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

setInterval(runGatchaWatcher, WATCH_INTERVAL);
console.log(`⏳ Gatcha Watcher started (interval ${WATCH_INTERVAL}ms)`);

export default router;
