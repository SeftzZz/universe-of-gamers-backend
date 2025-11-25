import express, { Request, Response } from "express";
import { broadcast } from "../index";   // ⬅ pastikan ada ini
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as anchor from "@project-serum/anchor";
import { SystemProgram, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Player } from "../models/Player";

const router = express.Router();

/* ============================================================
   🔧 RPC
============================================================ */
const RPC_URL = process.env.SOLANA_CLUSTER!;

const connection = new Connection(RPC_URL, "confirmed");

/* ============================================================
   🏦 PRIZEPOOL TREASURY
============================================================ */
const TREASURY_ADDRESS = process.env.TREASURY_PDA!;
const treasuryPubkey = new PublicKey(TREASURY_ADDRESS);

// UOG mint
const UOG_MINT = process.env.UOG_MINT!;
const SOL_MINT = "So11111111111111111111111111111111111111112";

/* ============================================================
   Fetch USD price via SolanaTracker
============================================================ */
async function getUsdPrice(mint: string): Promise<number> {
  const url = `https://data.solanatracker.io/tokens/${mint}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": process.env.SOLANATRACKER_API_KEY || "",
  };

  const res = await fetch(url, { headers });
  if (!res.ok) return 0;

  const data = await res.json();
  const pools = Array.isArray(data.pools) ? data.pools : [];
  const best = pools.sort((a: any, b: any) => 
    (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
  )[0];

  return best?.price?.usd ?? 0;
}

/* ============================================================
   🛰 PRIZEPOOL WATCHER (Realtime)
============================================================ */
let lastPrizepoolSnapshot: any = null;

// interval (ms)
const PRIZEPOOL_POLL_INTERVAL = 3600000;

async function fetchPrizepoolData() {
  const lamports = await connection.getBalance(treasuryPubkey);
  const sol = lamports / 1_000_000_000;

  const [solUsd, uogUsd] = await Promise.all([
    getUsdPrice(SOL_MINT),
    getUsdPrice(UOG_MINT),
  ]);

  const uogPerSol = solUsd && uogUsd ? solUsd / uogUsd : 0;
  const mintFeeBps = 1000;

  const feeSol = sol * (mintFeeBps / 10_000);
  const feeUog = uogPerSol ? feeSol * uogPerSol : 0;
  const feeSpl = Math.ceil(feeUog * 1_000_000);

  // ===============================================
  // 🔥 Step 1: Ambil 30%
  // ===============================================
  const sol30 = sol * 0.3;
  const usd30 = (sol * solUsd) * 0.3;

  // ===============================================
  // 🔥 Step 2: Ambil 30% dari 30% (total 9%)
  // ===============================================
  const sol_final = sol30 * 0.3;
  const usd_final = usd30 * 0.3;

  return {
    prizepool_address: TREASURY_ADDRESS,

    balance_SOL: sol_final, // 🔥 30% dari 30% (9%)
    value_usd: usd_final,   // 🔥 30% dari 30% (9%)

    balance_lamports: lamports, // tetap full
    sol_usd: solUsd,
    uog_usd: uogUsd,
    uog_per_sol: uogPerSol,

    mintFeeBps,
    fee_estimate: { feeSol, feeUog, feeSpl },
  };
}

/* ============================================================
   🟢 Helper Load Admin Keys from ENV
============================================================ */
function loadAdminKeypair(envKey: string): Keypair {
  const b58 = process.env[envKey];
  if (!b58) throw new Error(`Missing ENV: ${envKey}`);

  const raw = bs58.decode(b58);
  return Keypair.fromSecretKey(raw);
}

const adminMain = loadAdminKeypair("ADMIN_TREASURY_KEY");
const admin1 = loadAdminKeypair("ADMIN_TREASURY_KEY");
const admin2 = loadAdminKeypair("ADMIN_TREASURY_KEY");

// 🔥 WATCH LOOP
export function runPrizepoolWatcher() {
  console.log("🚀 [WATCHER] Prizepool watcher started...");

  setInterval(async () => {
    try {
      const data = await fetchPrizepoolData();

      if (!lastPrizepoolSnapshot) {
        lastPrizepoolSnapshot = data;
        // console.log("🆕 [PRIZEPOOL WATCHER] Initial snapshot created");

        broadcast({
          type: "prizepool_update",
          timestamp: Date.now(),
          data,
        });

        // console.log("📡 [PRIZEPOOL WATCHER] First broadcast");
        return;
      }

      const oldSnap = lastPrizepoolSnapshot;
      const newSnap = data;

      const oldStr = JSON.stringify(oldSnap);
      const newStr = JSON.stringify(newSnap);

      if (oldStr !== newStr) {
        console.log("🟡 [PRIZEPOOL WATCHER] Changes detected");

        // 🔎 diff detail
        const diff: any = {};
        const newRec = newSnap as Record<string, any>;
        const oldRec = oldSnap as Record<string, any>;

        Object.keys(newRec).forEach((k) => {
          if (JSON.stringify(newRec[k]) !== JSON.stringify(oldRec[k])) {
            diff[k] = {
              before: oldRec[k],
              after: newRec[k],
            };
          }
        });

        // console.log("🔄 [PRIZEPOOL WATCHER] DIFF:", diff);

        lastPrizepoolSnapshot = newSnap;

        broadcast({
          type: "prizepool_update",
          timestamp: Date.now(),
          data: newSnap,
        });

        // console.log("📡 [PRIZEPOOL WATCHER] Broadcast sent");
      } else {
        // console.log("⏸ [PRIZEPOOL WATCHER] No changes → No broadcast");
      }

    } catch (err: any) {
      // console.error("❌ [PRIZEPOOL WATCHER ERROR]", err.message);
    }
  }, PRIZEPOOL_POLL_INTERVAL);
}

/* ============================================================
   🟣 GET /prizepool/status
============================================================ */
router.get("/prizepool/status", async (req: Request, res: Response) => {
  try {
    console.log("──────────────────────────────");
    console.log("📊 Fetching PrizePool status...");

    // 1️⃣ Ambil saldo SOL
    const lamports = await connection.getBalance(treasuryPubkey);
    const balanceSOL = lamports / 1_000_000_000;

    // 2️⃣ Ambil transaksi
    const sigs = await connection.getSignaturesForAddress(
      treasuryPubkey,
      { limit: 100 }
    );

    // 3️⃣ Ambil harga SOL + UOG
    const [solUsd, uogUsd] = await Promise.all([
      getUsdPrice(SOL_MINT),
      getUsdPrice(UOG_MINT),
    ]);

    // 4️⃣ Ratio UOG per SOL
    const uogPerSol = solUsd && uogUsd ? solUsd / uogUsd : 0;

    // 5️⃣ Estimasi fee (10%)
    const mintFeeBps = 1000;
    const feeSol = balanceSOL * (mintFeeBps / 10_000);
    const mintFeeUog = uogPerSol ? feeSol * uogPerSol : 0;
    const mintFeeSpl = Math.ceil(mintFeeUog * 1_000_000);

    // ============================================================
    // ⭐ APPLY 30% → lalu 30% lagi (total = 9%)
    // ============================================================
    const sol30 = balanceSOL * 0.3;                 // 30%
    const solFinal = sol30 * 0.3;                   // 30% dari 30% (9%)

    const usdValue = balanceSOL * solUsd;           // total USD
    const usd30 = usdValue * 0.3;                   // 30%
    const usdFinal = usd30 * 0.3;                   // 30% dari 30% (9%)

    return res.json({
      prizepool_address: TREASURY_ADDRESS,

      // 🔥 HANYA 30% dari 30% (9%)
      balance_SOL: solFinal,
      value_usd: usdFinal,

      // tetap tampilkan saldo asli
      balance_lamports: lamports,

      // harga & ratio
      sol_usd: solUsd,
      uog_usd: uogUsd,
      uog_per_sol: uogPerSol,

      mintFeeBps,

      fee_estimate: {
        feeSol,
        feeUog: mintFeeUog,
        feeSpl: mintFeeSpl,
      },

      total_transactions: sigs.length,
    });

  } catch (err: any) {
    console.error("❌ PrizePool Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🟩 POST /prizepool/distribute
   → Hitung 30% × 30% prizepool
   → Bagi rata berbasis totalEarning
   → Kirim SOL via Anchor withdrawTreasury
============================================================ */
// router.post("/prizepool/distribute", async (_req, res) => {
//   try {
//     console.log("────────────────────────────────────");
//     console.log("🎁 Starting ON-CHAIN PrizePool Distribution (Anchor)…");

//     /* -------------------------------
//        1️⃣ Ambil saldo treasury
//     ------------------------------- */
//     const lamports = await connection.getBalance(treasuryPubkey);
//     const sol = lamports / 1_000_000_000;

//     const sol30 = sol * 0.3;
//     const solFinal = sol30 * 0.3; // 9%

//     console.log(`💰 Treasury SOL: ${sol}`);
//     console.log(`💰 PrizePool Final (30% × 30%): ${solFinal}`);

//     if (solFinal <= 0) {
//       return res.status(400).json({ error: "Prizepool empty." });
//     }

//     /* -------------------------------
//        2️⃣ Ambil semua player eligible
//     ------------------------------- */
//     const players = await Player.find({ totalEarning: { $gt: 0 } });

//     if (!players.length) {
//       return res.status(400).json({ error: "No eligible players." });
//     }

//     console.log(`👥 Eligible Players: ${players.length}`);

//     // total earning
//     const totalEarningAll = players.reduce(
//       (sum, p) => sum + p.totalEarning,
//       0
//     );

//     if (totalEarningAll <= 0) {
//       return res.status(400).json({ error: "Total earning = 0." });
//     }

//     console.log(`Σ TotalEarningAll: ${totalEarningAll}`);

//     /* -------------------------------
//        3️⃣ Setup Anchor Program
//     ------------------------------- */
//     const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
//     const program = new anchor.Program(idl!, PROGRAM_ID, provider);

//     const DUMMY_MINT = new PublicKey("So11111111111111111111111111111111111111112");

//     const distributionLog: any[] = [];

//     /* -------------------------------
//        4️⃣ Loop semua player
//     ------------------------------- */
//     for (const p of players) {
//       if (!p.walletAddress) {
//         console.log(`⚠️ Skip player ${p.username}: no wallet`);
//         continue;
//       }

//       const weight = p.totalEarning / totalEarningAll;
//       const shareSol = weight * solFinal;
//       const shareLamports = Math.floor(shareSol * 1_000_000_000);

//       console.log("\n🎯 DISTRIBUTE TO PLAYER");
//       console.log(`👤 ${p.username}`);
//       console.log(`🏦 Wallet: ${p.walletAddress}`);
//       console.log(`📊 Earning Weight: ${weight}`);
//       console.log(`💵 Share: ${shareSol} SOL`);

//       // dummy ATA
//       const dummyAta = await getAssociatedTokenAddress(
//         DUMMY_MINT,
//         admin1.publicKey,
//         true
//       );

//       /* -------------------------------------
//          Build TX withdrawTreasury (multisig)
//       -------------------------------------- */
//       const tx = await program.methods
//         .withdrawTreasury(new anchor.BN(shareLamports))
//         .accounts({
//           marketConfig: MARKET_CONFIG,
//           treasuryPda: TREASURY_PDA,
//           admin: adminMain.publicKey,
//           signer1: admin1.publicKey,
//           signer2: admin2.publicKey,
//           mint: DUMMY_MINT,
//           treasuryTokenAccount: dummyAta,
//           adminTokenAccount: dummyAta,
//           systemProgram: SystemProgram.programId,
//           tokenProgram: TOKEN_PROGRAM_ID,
//         })
//         .transaction();

//       tx.feePayer = admin1.publicKey;
//       tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

//       // partialSign multisig
//       tx.partialSign(adminMain);
//       tx.partialSign(admin1);
//       tx.partialSign(admin2);

//       /* -------------------------------------
//          Send TX
//       -------------------------------------- */
//       const sig = await connection.sendRawTransaction(tx.serialize());
//       console.log(`🚀 TX Sent: ${sig}`);

//       distributionLog.push({
//         username: p.username,
//         wallet: p.walletAddress,
//         shareSol,
//         lamports: shareLamports,
//         signature: sig,
//       });

//       /* -------------------------------------
//          Broadcast to all clients
//       -------------------------------------- */
//       broadcast({
//         type: "prizepool_payout",
//         wallet: p.walletAddress,
//         shareSol,
//         signature: sig,
//         time: new Date().toISOString(),
//       });
//     }

//     /* -------------------------------
//        5️⃣ Return hasil
//     ------------------------------- */
//     return res.json({
//       success: true,
//       prizepool: solFinal,
//       distribution: distributionLog,
//     });

//   } catch (err: any) {
//     console.error("❌ Distribution Anchor Error:", err.message);
//     return res.status(500).json({ error: err.message });
//   }
// });

router.post("/prizepool/distribute", async (_req, res) => {
  try {
    console.log("────────────────────────────────────");
    console.log("🎁 PrizePool Distribution Simulation (NO ON-CHAIN)");

    /* -------------------------------
       1️⃣ Ambil saldo treasury
    ------------------------------- */
    const lamports = await connection.getBalance(treasuryPubkey);
    const sol = lamports / 1_000_000_000;

    const sol30 = sol * 0.3;
    const solFinal = sol30 * 0.3; // 9%

    console.log(`💰 Treasury SOL: ${sol}`);
    console.log(`💰 PrizePool Final (30% × 30%): ${solFinal}`);

    if (solFinal <= 0) {
      return res.status(400).json({ error: "Prizepool empty." });
    }

    /* -------------------------------
       2️⃣ Ambil semua player eligible
    ------------------------------- */
    const players = await Player.find({ totalEarning: { $gt: 0 } });

    if (!players.length) {
      return res.status(400).json({ error: "No eligible players." });
    }

    console.log(`👥 Eligible Players: ${players.length}`);

    const totalEarningAll = players.reduce(
      (sum, p) => sum + p.totalEarning,
      0
    );

    if (totalEarningAll <= 0) {
      return res.status(400).json({ error: "Total earning = 0." });
    }

    console.log(`Σ TotalEarningAll: ${totalEarningAll}`);

    /* -------------------------------
       3️⃣ SIMULASI PEMBAGIAN
    ------------------------------- */
    const distributionSim: any[] = [];

    for (const p of players) {
      const weight = p.totalEarning / totalEarningAll;
      const shareSol = weight * solFinal;
      const shareLamports = Math.floor(shareSol * 1_000_000_000);

      console.log("\n🎯 SIMULATED DISTRIBUTION");
      console.log(`👤 ${p.username}`);
      console.log(`📊 Earning Weight: ${weight}`);
      console.log(`💵 Share: ${shareSol} SOL`);

      distributionSim.push({
        username: p.username,
        wallet: p.walletAddress,
        weight,
        shareSol,
        lamports: shareLamports,
      });
    }

    /* -------------------------------
       4️⃣ Return SIMULATION ONLY
    ------------------------------- */
    return res.json({
      success: true,
      mode: "simulation_only",
      prizepool_total: solFinal,
      total_players: players.length,
      distribution: distributionSim,
    });

  } catch (err: any) {
    console.error("❌ PrizePool Simulation Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get("/prizepool/eligible", async (req, res) => {
  const count = await Player.countDocuments({ totalEarning: { $gt: 0 } });
  res.json({ count });
});

router.get("/prizepool/distribute/simulate", async (_req, res) => {
  try {
    console.log("────────────────────────────────────");
    console.log("🎁 PrizePool Distribution Simulation (NO TX)");

    const lamports = await connection.getBalance(treasuryPubkey);
    const sol = lamports / 1_000_000_000;

    const sol30 = sol * 0.3;
    const solFinal = sol30 * 0.3; // 9%

    if (solFinal <= 0) return res.status(400).json({ error: "Prizepool empty." });

    const players = await Player.find({ totalEarning: { $gt: 0 } });

    if (!players.length) return res.status(400).json({ error: "No eligible players." });

    const totalEarningAll = players.reduce((a, b) => a + b.totalEarning, 0);
    if (totalEarningAll <= 0) return res.status(400).json({ error: "Total earning = 0." });

    const distributionSim = players.map((p) => {
      const weight = p.totalEarning / totalEarningAll;
      const shareSol = weight * solFinal;
      const shareLamports = Math.floor(shareSol * 1_000_000_000);

      return {
        username: p.username,
        wallet: p.walletAddress,
        totalEarning: p.totalEarning,
        weight,
        shareSol,
        lamports: shareLamports,
      };
    });

    // Sort hasil distribusi descending berdasarkan totalEarning
    distributionSim.sort((a, b) => b.totalEarning - a.totalEarning);

    return res.json({
      success: true,
      prizepool_total: solFinal,
      total_players: players.length,
      distribution: distributionSim,
    });

  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   ▶ AUTO-RUN PRIZEPOOL WATCHER (once)
============================================================ */
let prizepoolWatcherStarted = false;

function startPrizepoolWatcherOnce() {
  if (prizepoolWatcherStarted) return; // ⛔ avoid double start
  prizepoolWatcherStarted = true;

  // console.log("🔔 [PRIZEPOOL] Auto-start watcher from router");
  runPrizepoolWatcher();
}

startPrizepoolWatcherOnce();

export default router;
