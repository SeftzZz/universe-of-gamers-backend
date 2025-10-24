import { Router, Request, Response } from "express";
import { 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL, 
  Keypair, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  LoadedAddresses,
  AddressLookupTableAccount,
  TransactionInstruction,
  ParsedAccountData,
  AccountMeta
} from "@solana/web3.js";
import { ComputeBudgetProgram, sendAndConfirmRawTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction, 
  NATIVE_MINT,
  createCloseAccountInstruction,
  getAccount,
  createApproveInstruction,
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getTokenInfo } from "../services/priceService";
import {
  validateUserBalances,
  loadProgramAndParseTransaction,
  getProgramDerivedAddresses,
  prepareTokenAccountsAndInstructions,
  buildSwapInstruction,
  buildFinalTransaction,
  buildDFlowSwap2Instruction,
  buildRaydiumCpmmswapInstruction,
} from "../services/swapService";

import { getMint } from "@solana/spl-token";

import Auth from "../models/Auth";
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import { encrypt, decrypt } from '../utils/cryptoHelper';
import bs58 from 'bs58';
import bcrypt from 'bcrypt';
import * as crypto from "crypto";

import WalletBalance from "../models/WalletBalance";
import WalletToken from "../models/WalletToken";
import TrendingToken from "../models/TrendingToken";
import { Nft } from "../models/Nft";
import { PendingTx } from "../models/PendingTx";
const fs = require("fs");
import { Client } from "@solana-tracker/data-api";
import { broadcast } from "../index";
import chalk from "chalk";
import { struct, u8 } from "@solana/buffer-layout";
import { u64 } from "@solana/buffer-layout-utils";
import pLimit from "p-limit";

import Redis from "ioredis";

dotenv.config();
const router = Router();
const limit = pLimit(5);

// 🔑 Redis client
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

const solanaTracker = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY as string });

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DUMMY_SOL_MINT = "So11111111111111111111111111111111111111111";
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UOG_MINT = "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk";
const CUSTOM_TOKENS: Record<string, { id: string, symbol: string, name: string, logoURI: string }> = {
  "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk": {
    id: "universe-of-gamers",
    symbol: "UOG",
    name: "Universe Of Gamers",
    logoURI: "https://assets.coingecko.com/coins/images/68112/standard/IMG_0011.jpeg" // link resmi coingecko
  }
};
const TOKEN_ALIASES: Record<string, string> = {
  "Gr8Kcyt8UVRF1Pux7YHiK32Spm7cmnFVL6hd7LSLHqoB": UOG_MINT,
};

// 🔑 Registry default (phantom-like)
const REGISTRY: Record<
  string,
  { name: string; symbol: string; logoURI: string; decimals: number }
> = {
  [SOL_MINT]: {
    name: "Solana",
    symbol: "SOL",
    logoURI:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    decimals: 9,
  },
  [USDC_MINT]: {
    name: "USD Coin",
    symbol: "USDC",
    logoURI:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    decimals: 6,
  },
  [UOG_MINT]: {
    name: "Universe Of Gamers",
    symbol: "UOG",
    logoURI:
      "https://assets.coingecko.com/coins/images/68112/standard/IMG_0011.jpeg",
    decimals: 6,
  },
};

const AMM_PROGRAMS: Record<string, string> = {
  // Raydium AMM v4
  "HevUp4n4swwEWLvPVxrVey8cnKB8PBFRNTBb5BJ9dxiW": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  // Raydium CLMM
  "CAMMCzo5YLs9gDSPJkM2kN1U79hgXaqvC8mqwpRooS4q": "Raydium CLMM",
  // Lifinity
  "Lifinityj111111111111111111111111111111111111": "Lifinity AMM",
  // Meteora DLMM
  "DLMM11111111111111111111111111111111111111111": "Meteora DLMM",
};

// const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const DUMMY = "11111111111111111111111111111111";

const makeAcc = (pubkey: string | null, isSigner = false, isWritable = false) =>
  pubkey
    ? { pubkey, isSigner, isWritable }
    : { pubkey: DUMMY, isSigner: false, isWritable: false };

const rpc = process.env.SOLANA_CLUSTER;
console.log("⚙️ [wallet.ts] RPC   =", rpc);

const MAX_CACHE_AGE = 5 * 60 * 1000; // 5 menit

function formatError(err: any) {
  let logs: string[] = [];
  let message = err.message || "Unexpected error";

  // Tangkap logs dari SendTransactionError (web3.js)
  if (err.logs) {
    logs = err.logs;
  } else if (typeof err.message === "string" && err.message.includes("Logs:")) {
    // Extract logs array dari string message
    const match = err.message.match(/\[([\s\S]*)\]/m);
    if (match) {
      try {
        logs = JSON.parse(match[0]);
      } catch {
        logs = match[0].split("\n").map((l: string) => l.trim()).filter(Boolean);
      }
    }
  }

  // Bersihkan message utama (hilangkan block Logs:)
  if (message.includes("Logs:")) {
    message = message.split("Logs:")[0].trim();
  }

  return {
    success: false,
    error: {
      message,
      logs,
      details: err.response?.data ?? null,
    },
  };
}

// Helper konversi UI amount -> raw integer amount
async function toRawAmount(mintAddress: string, uiAmount: number): Promise<bigint> {
  const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

  const mintInfo = await getMint(connection, new PublicKey(mintAddress));
  const decimals = mintInfo.decimals;
  const raw = BigInt(Math.floor(uiAmount * 10 ** decimals));
  return raw;
}

async function getDefaultTokens() { 
  const defaultMints = [SOL_MINT, USDC_MINT, UOG_MINT];
  const result: any[] = [];

  for (const mint of defaultMints) {
    try {
      const info: any = await solanaTracker.getTokenInfo(String(mint));
      const priceUsd = info?.priceUsd ?? 0;
      const liquidity = info?.liquidityUsd ?? 0;
      const marketCap = info?.marketCapUsd ?? 0;
      const percentChange = info?.percentChange24h ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      const tokenData = {
        mint,
        name: REGISTRY[mint]?.name ?? info?.name ?? "",
        symbol: REGISTRY[mint]?.symbol ?? info?.symbol ?? "",
        logoURI: REGISTRY[mint]?.logoURI ?? info?.logoURI ?? "",
        decimals: REGISTRY[mint]?.decimals ?? info?.decimals ?? 0,
        amount: 0,
        priceUsd: parseFloat(priceUsd.toFixed(6)),
        usdValue: 0,
        liquidity: parseFloat(liquidity.toFixed(2)),
        marketCap: parseFloat(marketCap.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
        holders: info?.holders ?? 0,
      };

      // console.log("✅ Default token generated:", tokenData);
      result.push(tokenData);
    } catch (err: any) {
      console.warn(`⚠️ gagal ambil info token ${mint}:`, err.message);
    }
  }

  return result;
}

async function logAccountOwner(connection: Connection, label: string, pubkey: PublicKey) {
  try {
    const info = await connection.getParsedAccountInfo(pubkey);
    if (!info.value) {
      // ⚙️ Deteksi apakah ini WSOL ATA (So111...12)
      const mintHint = label.toLowerCase().includes("wsol") || label.toLowerCase().includes("sol");
      const msg = mintHint
        ? `ℹ️ ${label}: ${pubkey.toBase58()} (WSOL ATA belum aktif - akan dibuat otomatis)`
        : `❌ ${label}: ${pubkey.toBase58()} (account not found)`;
      console.log(msg);
      return;
    }

    const acc = info.value;
    console.log(`🔎 ${label}: ${pubkey.toBase58()}`);
    console.log("   Lamports:", acc.lamports);
    console.log("   Program Owner:", acc.owner.toBase58());

    if ("parsed" in acc.data) {
      const parsed = acc.data as ParsedAccountData;
      console.log("   Parsed type:", parsed.program);
      console.log("   Token owner:", parsed.parsed?.info?.owner);
      console.log("   Mint:", parsed.parsed?.info?.mint);
    }
  } catch (err) {
    console.error(`⚠️ Gagal cek owner untuk ${label}: ${pubkey.toBase58()}`, err);
  }
}

/**
 * Ensure WSOL ATA exists and has enough lamports for swap input.
 *
 * @param connection - Solana connection
 * @param payer - user's publicKey or Keypair
 * @param amountLamports - lamports to wrap as WSOL (e.g. 1 SOL = 1_000_000_000)
 * @returns {Promise<PublicKey>} Associated token account for WSOL
 */
export async function wrapSOLIfNeeded(
  connection: Connection,
  payer: any, // PublicKey or Keypair
  amountLamports: number
): Promise<PublicKey> {
  const owner = payer.publicKey ?? payer;
  const userWsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner);

  let needCreate = false;
  let needTopUp = false;

  try {
    const acc = await getAccount(connection, userWsolAta);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(165);

    if (Number(acc.amount) < BigInt(amountLamports)) {
      needTopUp = true;
      console.log("💰 WSOL ATA exists but insufficient balance. Will top-up.");
    } else {
      console.log("✅ WSOL ATA already exists and sufficient balance.");
      return userWsolAta;
    }
  } catch (err) {
    console.log("🪙 WSOL ATA not found, will create new one.");
    needCreate = true;
  }

  const tx = new Transaction();

  if (needCreate) {
    tx.add(
      createAssociatedTokenAccountInstruction(owner, userWsolAta, owner, NATIVE_MINT)
    );
  }

  // Transfer lamports to the WSOL ATA
  tx.add(
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: userWsolAta,
      lamports: amountLamports,
    })
  );

  // SyncNative ensures lamports = token balance
  tx.add(createSyncNativeInstruction(userWsolAta));

  console.log(
    needCreate
      ? "⚙️ Creating + funding WSOL ATA..."
      : "⚙️ Top-up WSOL ATA with additional lamports..."
  );

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    payer.secretKey ? [payer] : [], // if Keypair
    { commitment: "confirmed" }
  );

  console.log("✅ WSOL prepared at:", userWsolAta.toBase58());
  console.log("🔗 TX:", sig);

  return userWsolAta;
}

async function ensureWSOLReady(connection: Connection, wallet: Keypair, amountLamports: number) {
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  const ata = await getAssociatedTokenAddress(SOL_MINT, wallet.publicKey);
  const info = await connection.getAccountInfo(ata);

  if (!info) {
    const createIx = createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, SOL_MINT);
    const tx = new Transaction().add(createIx);
    await sendAndConfirmTransaction(connection, tx, [wallet]);
  }

  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: amountLamports })
  );
  await sendAndConfirmTransaction(connection, fundTx, [wallet]);

  const syncTx = new Transaction().add(createSyncNativeInstruction(ata));
  await sendAndConfirmTransaction(connection, syncTx, [wallet]);

  return ata;
}

// 🔹 Definisikan tipe tokenMap lengkap (termasuk address)
interface TokenInfo {
  symbol: string;
  image: string;
  address: string;
}

// 🔹 Daftar token dikenal (bisa diperluas)
const tokenMap: Record<string, TokenInfo> = {
  "So11111111111111111111111111111111111111112": {
    symbol: "SOL",
    image:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    address: "So11111111111111111111111111111111111111112",
  },
  "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk": {
    symbol: "UOG",
    image:
      "https://api.universeofgamers.io/uploads/app-logo.jpeg",
    address: "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk",
  },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D": {
    symbol: "BONK",
    image:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D/logo.png",
    address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D",
  },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    symbol: "USDC",
    image:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};

//
// GET /wallet/balance/:address
//
router.get("/balance/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const now = Date.now();
    const dbCache = await WalletBalance.findOne({ address }).lean();

    // 🧠 Cek apakah masih valid (kurang dari 5 menit)
    if (dbCache && now - new Date(dbCache.lastUpdated).getTime() < MAX_CACHE_AGE) {
      console.log(`✅ Returning cached balance for ${address}`);
      return res.json({ ...dbCache, source: "db-cache" });
    }

    // 🌐 Fetch dari chain (Anchor)
    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const walletPubkey = new PublicKey(address);

    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });
    const idl = require("../../public/idl/universe_of_gamers.json");
    const programId = new PublicKey(process.env.PROGRAM_ID as string);
    const program = new anchor.Program(idl, programId, provider);

    // === Ambil balance SOL ===
    const lamports = await connection.getBalance(walletPubkey);
    const solBalance = lamports / LAMPORTS_PER_SOL;

    // === Ambil harga SOL dari Coingecko ===
    const coingeckoResp: any = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    ).then((r) => r.json());
    const solPriceUsd = coingeckoResp?.solana?.usd || 0;
    const usdValue = solBalance * solPriceUsd;

    // === Ambil SPL Token Balance (UOG) ===
    let uogBalance = 0;
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
        programId: TOKEN_PROGRAM_ID,
      });

      for (const acc of tokenAccounts.value) {
        const mint = acc.account.data.parsed.info.mint;
        if (mint === process.env.UOG_MINT) {
          const amount = acc.account.data.parsed.info.tokenAmount.uiAmount;
          uogBalance = amount;
        }
      }
    } catch (err) {
      console.warn("⚠️ Failed to fetch SPL tokens:", (err as any).message);
    }

    // === Dummy trend sementara ===
    const percentChange = 0;
    const trend = 0;

    // === Simpan ke DB sebagai cache baru ===
    const updated = await WalletBalance.findOneAndUpdate(
      { address },
      {
        address,
        solBalance,
        solPriceUsd,
        usdValue,
        uogBalance,
        percentChange,
        trend,
        lastUpdated: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log(`✅ Cached balance updated for ${address}`);

    res.json({
      ...updated.toObject(),
      source: "onchain",
    });
  } catch (err: any) {
    console.error("❌ Error fetching balance:", err);

    // ⚠️ Jika RPC gagal → fallback ke cache lama
    const { address } = req.params;
    const dbCache = await WalletBalance.findOne({ address }).lean();
    if (dbCache) {
      console.warn(`⚡ Returning expired cache for ${address}`);
      return res.json({ ...dbCache, source: "db-expired" });
    }

    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/tokens/:address
//

router.get("/tokens/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const now = Date.now();
    const redisKey = `tokens:${address}`;

    // 1️⃣ Cek cache Redis
    const cached = await redis.get(redisKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const age = now - new Date(parsed.timestamp).getTime();
      if (age < MAX_CACHE_AGE) {
        console.log(`⚡ [Redis] Returning cached tokens for ${address}`);
        return res.json({ ...parsed.data, source: "redis-cache" });
      }
    }

    // 2️⃣ Cek MongoDB cache
    const dbTokens = await WalletToken.find({ address }).lean();
    const hasDb = dbTokens.length > 0;
    const allFresh = hasDb && dbTokens.every(
      (t: any) => now - new Date(t.lastUpdated).getTime() < MAX_CACHE_AGE
    );

    if (allFresh) {
      console.log(`✅ [MongoDB] Returning cached tokens for ${address}`);
      const response = {
        address,
        tokens: dbTokens,
        total: dbTokens.reduce((s: any, t: any) => s + (t.usdValue ?? 0), 0),
        totalSol: dbTokens.find((t: any) => t.mint === SOL_MINT)?.amount ?? 0,
        source: "db-cache",
      };
      await redis.set(
        redisKey,
        JSON.stringify({ timestamp: new Date().toISOString(), data: response }),
        "EX",
        MAX_CACHE_AGE / 1000
      );
      return res.json(response);
    }

    // 3️⃣ Ambil dari Solana Tracker
    let wallet: any = null;
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries && !wallet) {
      try {
        wallet = await solanaTracker.getWallet(address);
      } catch (err: any) {
        attempt++;
        console.warn(`⚠️ getWallet attempt ${attempt} failed: ${err.message}`);
        if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    // 4️⃣ Jika gagal total, fallback ke cache lama
    if (!wallet) {
      if (hasDb) {
        console.warn(`⚡ Using expired cache for ${address}`);
        return res.json({
          address,
          tokens: dbTokens,
          total: dbTokens.reduce((s, t) => s + (t.usdValue ?? 0), 0),
          totalSol: dbTokens.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
          source: "db-expired",
        });
      }
      return res.status(404).json({ error: "Wallet not found" });
    }

    // 5️⃣ Map hasil wallet.tokens
    const apiTokens = wallet.tokens.map((t: any) => {
      const mint =
        t.token.mint === "So11111111111111111111111111111111111111112"
          ? SOL_MINT
          : t.token.mint;
      const priceUsd = t.pools?.[0]?.price?.usd ?? 0;
      const liquidity = t.pools?.[0]?.liquidity?.usd ?? 0;
      const marketCap = t.pools?.[0]?.marketCap?.usd ?? 0;
      const percentChange = t.events?.["24h"]?.priceChangePercentage ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      return {
        mint,
        name: mint === SOL_MINT ? "Solana" : t.token.name,
        symbol: mint === SOL_MINT ? "SOL" : t.token.symbol,
        logoURI:
          mint === SOL_MINT
            ? "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png"
            : t.token.image,
        decimals: t.token.decimals,
        amount: t.balance,
        priceUsd: parseFloat(priceUsd.toFixed(6)),
        usdValue: parseFloat(t.value?.toFixed(2) ?? "0"),
        liquidity: parseFloat(liquidity.toFixed(2)),
        marketCap: parseFloat(marketCap.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
        holders: t.holders ?? 0,
        lastUpdated: new Date(),
      };
    });

    // 6️⃣ Simpan ke MongoDB
    await Promise.all(
      apiTokens.map((t: any) =>
        WalletToken.findOneAndUpdate(
          { address, mint: t.mint },
          { ...t, address, lastUpdated: new Date() },
          { upsert: true }
        )
      )
    );

    // 7️⃣ Simpan ke Redis
    const response = {
      address,
      tokens: apiTokens,
      total: apiTokens.reduce((s: any, t: any) => s + (t.usdValue ?? 0), 0),
      totalSol: apiTokens.find((t: any) => t.mint === SOL_MINT)?.amount ?? 0,
      source: "onchain",
    };

    await redis.set(
      redisKey,
      JSON.stringify({ timestamp: new Date().toISOString(), data: response }),
      "EX",
      MAX_CACHE_AGE / 1000
    );

    console.log(`✅ [Onchain] Cached ${apiTokens.length} tokens for ${address}`);
    return res.json(response);
  } catch (err: any) {
    console.error("❌ Error fetching wallet tokens:", err);
    return res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/tokens/add
//
router.post("/tokens/add", async (req: Request, res: Response) => {
  try {
    const { address, token } = req.body;
    if (!address || !token?.mint) {
      return res.status(400).json({ error: "Missing address or token data" });
    }

    const existing = await WalletToken.findOne({ address, mint: token.mint });
    if (existing) {
      console.log(`⚙️ Token ${token.symbol} already exists for ${address}`);
      return res.json({ updated: false, token: existing });
    }

    const newToken = await WalletToken.create({
      address,
      owner: address,
      mint: token.mint,
      name: token.name ?? "Unknown Token",
      symbol: token.symbol ?? "???",
      logoURI: token.logoURI ?? null,
      decimals: token.decimals ?? 9,
      amount: 0,
      priceUsd: token.usdValue ?? 0,
      usdValue: 0,
      percentChange: token.percentChange ?? 0,
      trend: token.trend ?? 0,
      lastUpdated: new Date(),
    });

    console.log(`✅ Token ${token.symbol} added for ${address}`);
    res.json({ success: true, token: newToken });
  } catch (err: any) {
    console.error("❌ Error adding token:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/trending
//
router.get("/trending", async (req: Request, res: Response) => {
  try {
    // ✅ langsung ambil trending tokens (interval 1h)
    const trendingTokens = await solanaTracker.getTrendingTokens("1h");

    // mapping hasil biar konsisten dengan schema lama
    const tokens = trendingTokens.map((t: any) => {
      const pool = t.pools?.[0] || {};
      const priceUsd = pool.price?.usd ?? 0;
      const liquidity = pool.liquidity?.usd ?? 0;
      const marketCap = pool.marketCap?.usd ?? 0;
      const percentChange = t.events?.["1h"]?.priceChangePercentage ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      return {
        mint: t.token.mint,
        name: t.token.name,
        symbol: t.token.symbol,
        logoURI: t.token.image,
        decimals: t.token.decimals,
        amount: 0, // trending token tidak punya balance wallet
        priceUsd: parseFloat(priceUsd.toFixed(6)),
        usdValue: 0,
        liquidity: parseFloat(liquidity.toFixed(2)),
        marketCap: parseFloat(marketCap.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
        holders: t.holders ?? 0,
      };
    });

    // opsional: simpan ke DB
    await Promise.all(
      tokens.map(async (t) => {
        await TrendingToken.findOneAndUpdate(
          { mint: t.mint },
          { ...t, lastUpdated: new Date() },
          { upsert: true, new: true }
        );
      })
    );

    // ✅ tampilkan hanya 10 token teratas
    const limitedTokens = tokens.slice(0, 10);

    res.json({
      tokens: limitedTokens,
      total: limitedTokens.length,
      totalSol: 0,
    });
  } catch (err: any) {
    console.error("❌ Error fetching trending tokens:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/nft/:address
//
router.get("/nfts/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const nfts = await Nft.find({ "metadata.owner": address });

    // convert lamports → SOL sebelum kirim ke frontend
    const formatted = nfts.map(nft => ({
      ...nft.toObject(),
      price: nft.price ? nft.price / LAMPORTS_PER_SOL : 0
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

//
// GET /wallet/nft/:id
//
router.get("/nfts/id/:id", async (req, res) => {
  try {
    const nft = await Nft.findById(req.params.id);
    if (!nft) return res.status(404).json({ error: "NFT not found" });

    // konversi lamports → SOL
    const formatted = {
      ...nft.toObject(),
      price: nft.price ? nft.price / LAMPORTS_PER_SOL : 0,
    };

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFT" });
  }
});

//
// POST /wallet/send/build
//
router.post("/send/build", async (req: Request, res: Response) => {
  try {
    const { from, to, amount, mint } = req.body;
    if (!from || !to || !amount || !mint) {
      return res.status(400).json({ error: "from, to, amount, mint are required" });
    }

    console.log("📩 [BUILD TX] Request received (via program)");
    console.log("   🔑 From :", from);
    console.log("   🎯 To   :", to);
    console.log("   💰 Amount (UI):", amount);
    console.log("   🪙 Mint :", mint);

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const fromPubkey = new PublicKey(from);
    const toPubkey = new PublicKey(to);
    const mintPubkey = new PublicKey(mint);

    // === Setup provider & program ===
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });
    const idl = require("../../public/idl/universe_of_gamers.json");
    const programId = new PublicKey(process.env.PROGRAM_ID as string);
    const program = new anchor.Program(idl, programId, provider);

    // === Derive PDA ===
    const [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    console.log("   📂 MarketConfig PDA:", marketConfigPda.toBase58());

    // === Parse & normalisasi amount ===
    const amountNum = typeof amount === "string" ? parseFloat(amount) : amount;
    if (isNaN(amountNum) || amountNum <= 0) throw new Error(`Invalid amount value: ${amount}`);

    // === Dapatkan decimals token ===
    let decimals = 9;
    try {
      const mintInfo = await getMint(connection, mintPubkey);
      decimals = mintInfo.decimals;
    } catch (e: any) {
      console.warn("⚠️ Mint info unavailable, fallback decimals 9");
    }

    const lamports = BigInt(Math.round(amountNum * 10 ** decimals));
    console.log("   🔢 Token decimals:", decimals);
    console.log("   💰 Raw amount (lamports):", lamports.toString());

    // === Ambil trade fee dari MarketConfig ===
    const marketConfig: any = await program.account.marketConfig.fetch(marketConfigPda);
    const tradeFeeBps: number = marketConfig.tradeFeeBps ?? marketConfig.trade_fee_bps ?? 0;
    const tradeFee = (lamports * BigInt(tradeFeeBps)) / BigInt(10_000);
    console.log("💸 Trade fee (bps):", tradeFeeBps, "=>", tradeFee.toString());

    // === Buat transaksi ===
    const tx = new Transaction();

    // === Native SOL Case ===
    if (mint === "So11111111111111111111111111111111111111111") {
      console.log("⚡ Detected Native SOL transfer");

      const transferToRecipient = SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: Number(lamports),
      });

      const transferToTreasury = SystemProgram.transfer({
        fromPubkey,
        toPubkey: treasuryPda,
        lamports: Number(tradeFee),
      });

      tx.add(transferToRecipient, transferToTreasury);
    }

    // === SPL Token Case ===
    else {
      console.log("💠 Detected SPL Token transaction");

      // --- Import dependencies ---
      const {
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        getAssociatedTokenAddress,
        createAssociatedTokenAccountInstruction,
      } = await import("@solana/spl-token");

      // === Sender ATA ===
      const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
      // === Recipient ATA ===
      const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, toPubkey);
      // === Treasury ATA ===
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        treasuryPda,
        true
      );

      // === Buat preInstructions ATA kalau belum ada ===
      const preInstructions: TransactionInstruction[] = [];
      const ataInfos = [
        { ata: recipientTokenAccount, owner: toPubkey },
        { ata: treasuryTokenAccount, owner: treasuryPda },
      ];

      for (const { ata, owner } of ataInfos) {
        const info = await connection.getAccountInfo(ata);
        if (!info) {
          console.log(`⚠️ Creating missing ATA for ${owner.toBase58()}`);
          preInstructions.push(
            createAssociatedTokenAccountInstruction(
              fromPubkey,
              ata,
              owner,
              mintPubkey,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }
      }

      console.log("   📦 Sender:", senderTokenAccount.toBase58());
      console.log("   📦 Recipient:", recipientTokenAccount.toBase58());
      console.log("   📦 Treasury:", treasuryTokenAccount.toBase58());

      // === Buat instruksi lewat program ===
      const sendIx = await program.methods
        .sendToken(new anchor.BN(lamports.toString()))
        .accounts({
          sender: fromPubkey,
          recipient: toPubkey,
          treasuryPda,
          mint: mintPubkey,
          senderTokenAccount,
          recipientTokenAccount,
          treasuryTokenAccount,
          marketConfig: marketConfigPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();

      tx.add(...preInstructions, sendIx);
    }

    // === Finalisasi TX ===
    tx.feePayer = fromPubkey;
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    console.log("✅ Transaction built via program");
    console.log("   FeePayer:", tx.feePayer.toBase58());
    console.log("   Blockhash:", blockhash);
    console.log("   LastValidBlockHeight:", lastValidBlockHeight);

    const serialized = tx.serialize({ requireAllSignatures: false });
    res.json({
      tx: serialized.toString("base64"),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (err: any) {
    console.error("❌ build sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/send/status/:txId
//
router.get("/send/status/:txId", authenticateJWT, async (req, res) => {
  try {
    const txDoc = await PendingTx.findById(req.params.txId);
    if (!txDoc) return res.status(404).json({ error: "Not found" });

    res.json({
      status: txDoc.status,
      signedTx: txDoc.signedTx ?? null,
      signature: txDoc.signature ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/send/sign
//
router.post("/send/sign", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user!;
    const { tx, wallet } = req.body;

    // 🔍 Validasi awal
    if (!tx || !wallet) {
      console.warn("⚠️ Missing tx or wallet in /send/sign:", { tx: !!tx, wallet: !!wallet });
      return res.status(400).json({ error: "tx and wallet required" });
    }

    // 🔍 Ambil user dari DB
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    // 🔍 Log debug custodial wallets
    // console.log("🔍 Custodial wallets for user:", JSON.stringify(authUser.custodialWallets, null, 2));
    console.log("🔍 Searching wallet:", wallet);

    // 🔎 Cari wallet secara case-insensitive dan normalisasi provider
    const walletEntry = authUser.custodialWallets.find(
      (w: any) =>
        (w.provider?.toLowerCase?.() ?? "") === "solana" &&
        w.address?.toLowerCase?.() === wallet.toLowerCase()
    );

    if (!walletEntry) {
      console.warn("❌ No matching custodial wallet found for:", wallet);
      console.log(
        "📜 Available wallets:",
        authUser.custodialWallets.map((w: any) => ({
          provider: w.provider,
          address: w.address,
        }))
      );
      return res.status(400).json({ error: "No matching custodial wallet found" });
    }

    // 🧾 Simpan transaksi pending
    const pendingTx = await PendingTx.create({
      userId,
      wallet,
      txBase64: tx,
      status: "pending",
      createdAt: new Date(),
    });

    console.log("=== 📨 REQUEST SIGN TRANSACTION ===");
    console.log("👤 User:", userId);
    console.log("💼 Wallet:", wallet);
    console.log("📦 TX length:", tx.length);
    console.log("📬 Saved pending transaction:", pendingTx._id);
    console.log("📅 Created at:", pendingTx.createdAt);

    // ✅ Kembalikan txId ke frontend
    res.json({
      message: "Transaction waiting for manual sign",
      txId: pendingTx._id.toString(),
      status: "pending",
    });

  } catch (err: any) {
    console.error("❌ /send/sign error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/send/manual-sign
//
router.post("/send/manual-sign", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user!;
    const { txId } = req.body;

    console.log("=== 🖋️ MANUAL SIGN REQUEST RECEIVED ===");
    console.log("👤 User:", userId);
    console.log("📦 TX ID:", txId);

    // 1️⃣ Validasi TX
    const txDoc = await PendingTx.findById(txId);
    if (!txDoc) return res.status(404).json({ error: "Pending transaction not found" });
    if (!txDoc.txBase64)
      return res.status(400).json({ error: "Missing txBase64 in pending transaction" });

    // 2️⃣ Validasi User & Wallet
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const walletEntry = authUser.custodialWallets.find(
      (w: any) => w.provider === "solana" && w.address === txDoc.wallet
    );
    if (!walletEntry)
      return res.status(400).json({ error: "No matching custodial wallet found" });

    // 3️⃣ Dekripsi private key & buat signer
    const decrypted = decrypt(walletEntry.privateKey);
    if (!decrypted) return res.status(400).json({ error: "Invalid private key decryption" });

    const signer = Keypair.fromSecretKey(bs58.decode(decrypted));
    console.log("🔑 Signer loaded for wallet:", txDoc.wallet);

    // 4️⃣ Deserialize transaction & tanda tangan
    const txBuffer = Buffer.from(txDoc.txBase64, "base64");
    const tx = anchor.web3.Transaction.from(txBuffer);
    console.log("🧱 Transaction decoded. Instruction count:", tx.instructions.length);

    console.log("🧾 Fee payer:", tx.feePayer?.toBase58());
    console.log("🔏 Signer pubkey:", signer.publicKey.toBase58());
    console.log("Before sign:", tx.signatures.map(s => ({
      pubkey: s.publicKey.toBase58(),
      hasSig: !!s.signature
    })));

    tx.partialSign(signer);

    console.log("After sign:", tx.signatures.map(s => ({
      pubkey: s.publicKey.toBase58(),
      hasSig: !!s.signature
    })));

    if (!tx.verifySignatures()) {
      throw new Error("❌ Signature verification failed — probably wrong feePayer or corrupt TX");
    }

    const signedTx = tx.serialize().toString("base64");

    // 5️⃣ Update database
    txDoc.status = "signed";
    txDoc.signedTx = signedTx;
    txDoc.signedAt = new Date();
    await txDoc.save();

    console.log("✅ Manual sign completed:", txDoc._id);

    res.json({
      message: "Transaction signed manually ✅",
      signedTx,
      txId: txDoc._id,
      status: txDoc.status,
    });
  } catch (err: any) {
    console.error("❌ manual-sign error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

//
// POST /wallet/send/submit
//
router.post("/send/submit", async (req: Request, res: Response) => {
  // bikin connection global di scope function
  const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

  try {
    const { signedTx, blockhash, lastValidBlockHeight } = req.body;
    if (!signedTx) {
      return res.status(400).json({ error: "signedTx is required" });
    }

    // ✅ Cek apakah blockhash masih valid
    if (blockhash && lastValidBlockHeight) {
      const stillValid = await connection.isBlockhashValid(blockhash, lastValidBlockHeight);
      if (!stillValid) {
        console.warn("⚠️ Blockhash expired before submit");
        const { blockhash: newHash, lastValidBlockHeight: newHeight } =
          await connection.getLatestBlockhash("confirmed");
        return res.status(409).json({
          error: "Blockhash expired, please rebuild transaction",
          blockhash: newHash,
          lastValidBlockHeight: newHeight,
        });
      }
    }

    const txBuffer = Buffer.from(signedTx, "base64");

    // ✅ Kirim + auto confirm TX
    const signature = await sendAndConfirmRawTransaction(
      connection,
      txBuffer,
      {
        skipPreflight: false,
        commitment: "confirmed",
        maxRetries: 3,
      }
    );
    console.log("✅ Sent + Confirmed:", signature);

    // ✅ Extra confirm pakai getSignatureStatuses
    let status = null;
    for (let i = 0; i < 15; i++) {
      const st = await connection.getSignatureStatuses([signature]);
      status = st.value[0];
      if (status && status.confirmationStatus === "confirmed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!status) {
      throw new Error("Transaction not confirmed within retries");
    }

    console.log("✅ Confirmed transaction:", signature);
    res.json({ signature });
  } catch (err: any) {
    if (err.message?.includes("Blockhash not found")) {
      const { blockhash: newHash, lastValidBlockHeight: newHeight } =
        await connection.getLatestBlockhash("finalized");
      return res.status(409).json({
        error: "Blockhash expired, please rebuild transaction",
        blockhash: newHash,
        lastValidBlockHeight: newHeight,
      });
    }

    console.error("❌ submit sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/quote
//
router.post("/swap/quote", async (req: Request, res: Response) => {
  try {
    let { from, fromMint, toMint, amount } = req.body;
    console.log(chalk.cyan("\n📩 [SWAP QUOTE] Request received ========================"));
    console.log(chalk.gray(JSON.stringify(req.body, null, 2)));

    if (!from || !fromMint || !toMint || !amount)
      return res.status(400).json({ error: "from, fromMint, toMint, amount required" });

    const normalizeMint = (mint: string) => (mint === DUMMY_SOL_MINT ? SOL_MINT : mint);
    fromMint = normalizeMint(fromMint);
    toMint = normalizeMint(toMint);

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    console.log(chalk.blue("🔗 RPC Endpoint:"), process.env.SOLANA_CLUSTER);

    // decimals input/output
    const mintInfoIn = fromMint !== SOL_MINT ? await getMint(connection, new PublicKey(fromMint)) : { decimals: 9 };
    const mintInfoOut = toMint !== SOL_MINT ? await getMint(connection, new PublicKey(toMint)) : { decimals: 9 };
    console.log(chalk.yellow("🧮 Decimals:"), "in:", mintInfoIn.decimals, "out:", mintInfoOut.decimals);

    const rawAmount = BigInt(Math.floor(amount * 10 ** mintInfoIn.decimals));
    console.log(chalk.yellow("💰 UI Amount:"), amount, chalk.yellow("→ Raw (lamports):"), rawAmount.toString());

    // DFLOW Quote
    const { data: quote } = await axios.get("https://quote-api.dflow.net/intent", {
      params: {
        userPublicKey: from,
        inputMint: fromMint,
        outputMint: toMint,
        amount: rawAmount.toString(),
        slippageBps: 50,
        wrapAndUnwrapSol: true,
      },
    });

    if (!quote?.openTransaction) throw new Error("❌ Missing openTransaction from DFLOW");

    console.log(chalk.green("✅ Quote received from DFLOW"));
    console.table({
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOutAmount: quote.minOutAmount,
    });
    console.log(chalk.gray("openTransaction (first 100 chars):"), quote.openTransaction.slice(0, 100));

    res.json({
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOutAmount: quote.minOutAmount,
      openTransaction: quote.openTransaction,
    });
  } catch (err: any) {
    console.error(chalk.red("❌ swap/quote error:"), err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/build
//
router.post("/swap/build", authenticateJWT, async (req: AuthRequest, res) => {
  // ⬇️ Definisikan variabel global untuk bisa diakses di catch
  let connection: Connection | null = null;
  let buyerKp: Keypair | null = null;
  let fromMint: string | null = null;

  try {
    console.log(chalk.cyan("\n📩 [SWAP BUILD] AuthRequest received ========================"));
    console.log(chalk.gray(JSON.stringify(req.body, null, 2)));

    const { from, openTransaction, toMint, outAmount, fromMint: fromMintBody, inAmount } = req.body;
    fromMint = fromMintBody;
    if (!from || !openTransaction || !fromMint || !inAmount)
      return res.status(400).json({ error: "from, openTransaction, fromMint, inAmount required" });

    connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

    // 🧩 Ambil keypair user dari database (custodial)
    const { id: userId } = req.user;
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const buyerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!buyerCustodian) return res.status(400).json({ error: "No buyer wallet" });

    buyerKp = Keypair.fromSecretKey(bs58.decode(decrypt(buyerCustodian.privateKey)));
    console.log(chalk.green("🔑 Loaded buyer keypair:"), buyerKp.publicKey.toBase58());

    const fromPubkey = new PublicKey(from);
    const fromMintPublicKey = new PublicKey(fromMint);
    const outputMint = new PublicKey(toMint);
    console.log(chalk.blue("🔗 Connected to:"), process.env.SOLANA_CLUSTER);

    await validateUserBalances(connection, fromPubkey, fromMintPublicKey, inAmount, outputMint);

    const { programUog, aggIx, metas: baseMetas, ixData } =
      await loadProgramAndParseTransaction(connection, openTransaction, fromPubkey);
    console.log(chalk.yellow("📦 Parsed aggregator instruction:"));
    console.table({
      programId: aggIx.programId.toBase58(),
      dataLen: ixData.length,
      metasCount: baseMetas.length,
    });

    const [marketConfigPda, treasuryPda] = await getProgramDerivedAddresses(programUog);
    console.log(chalk.yellow("🏦 PDAs:"));
    console.log("marketConfigPda:", marketConfigPda.toBase58());
    console.log("treasuryPda    :", treasuryPda.toBase58());

    let {
      userInTokenAccount,
      userOutTokenAccount,
      treasuryTokenAccount,
      preInstructions,
      extraPostInstructions,
    } = await prepareTokenAccountsAndInstructions(
      connection,
      fromPubkey,
      fromMintPublicKey,
      inAmount,
      outputMint,
      treasuryPda,
      programUog,
      marketConfigPda,
      outAmount
    );

    console.log(chalk.yellow("💳 Token accounts prepared:"));
    console.table({
      userInTokenAccount,
      userOutTokenAccount,
      treasuryTokenAccount,
    });

    // 🧩 Helper: Cek dan buat ATA jika belum ada
    async function ensureAtaExists(connection: Connection, owner: PublicKey, mint: PublicKey) {
      const WSOL_MINT = "So11111111111111111111111111111111111111112";
      const ata = await getAssociatedTokenAddress(mint, owner);

      // ============================================================
      // CASE: WSOL
      // ============================================================
      if (mint.toBase58() === WSOL_MINT) {
        console.log(chalk.cyan(`🔍 [ensureAtaExists] Checking WSOL ATA for ${owner.toBase58()}`));

        const info = await connection.getAccountInfo(ata);
        if (!info) {
          console.log(chalk.yellow(`⚙️ WSOL ATA not found → creating new ATA`));
          const createAtaIx = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
          return { ata, ix: createAtaIx };
        }

        try {
          const parsed = await connection.getParsedAccountInfo(ata);
          const data = parsed.value?.data as any;
          const ownerOnChain = data?.parsed?.info?.owner;
          const state = data?.parsed?.info?.state;
          const amount = data?.parsed?.info?.tokenAmount?.uiAmount;

          console.log(
            chalk.gray(
              `   WSOL ATA exists → owner: ${ownerOnChain}, state: ${state}, balance: ${amount}`
            )
          );

          // 🧩 Jika belum initialized atau balance 0 → recreate ATA
          if (ownerOnChain !== owner.toBase58() || state !== "initialized") {
            console.log(chalk.yellow(`⚙️ Recreating WSOL ATA (invalid owner/state)`));
            const createAtaIx = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
            return { ata, ix: createAtaIx };
          }

          return { ata, ix: null };
        } catch (e) {
          console.log(chalk.red(`❌ Failed to parse WSOL ATA, recreating: ${e}`));
          const createAtaIx = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
          return { ata, ix: createAtaIx };
        }
      }

      // ============================================================
      // CASE: SPL biasa
      // ============================================================
      const info = await connection.getAccountInfo(ata);
      if (!info) {
        console.log(chalk.yellow(`⚙️ Creating ATA for ${mint.toBase58()}`));
        const createAtaIx = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
        return { ata, ix: createAtaIx };
      }

      console.log(chalk.green(`✅ ATA exists for ${mint.toBase58()}: ${ata.toBase58()}`));
      return { ata, ix: null };
    }

    // 🧱 Pastikan ATA user output selalu ada
    const ensureOut = await ensureAtaExists(connection, fromPubkey, outputMint);
    if (ensureOut.ix) {
      console.log(chalk.yellow(`📥 Adding ATA creation instruction for ${outputMint.toBase58()}`));
      preInstructions.push(ensureOut.ix);
    }
    const ensuredUserOutAccount = ensureOut.ata;

    // ⚡ 1️⃣ Auto-wrap SOL jika input adalah native SOL
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    let effectiveUserInAccount = userInTokenAccount;

    if (fromMint === SOL_MINT) {
      console.log(chalk.yellow("⚡ Detected native SOL input — preparing WSOL ATA"));

      const solBalance = await connection.getBalance(buyerKp.publicKey);
      const requiredLamports = Number(inAmount);
      if (solBalance < requiredLamports + 0.01 * LAMPORTS_PER_SOL) {
        throw new Error("❌ Insufficient SOL balance (need fee buffer).");
      }

      const wsolMint = new PublicKey(SOL_MINT);
      const wsolAta = await getAssociatedTokenAddress(wsolMint, buyerKp.publicKey, false);
      let ataInfo = await connection.getAccountInfo(wsolAta);

      if (!ataInfo) {
        console.log(chalk.yellow("⚙️ WSOL ATA not found, creating..."));
        const createIx = createAssociatedTokenAccountInstruction(
          buyerKp.publicKey, wsolAta, buyerKp.publicKey, wsolMint
        );
        const tx = new Transaction().add(createIx);
        await sendAndConfirmTransaction(connection, tx, [buyerKp]);
        console.log(chalk.green(`✅ WSOL ATA created: ${wsolAta.toBase58()}`));
      }

      // 💸 Fund WSOL ATA
      const lamportsToAdd = requiredLamports + 10_000;
      console.log(chalk.gray(`💰 Funding ${(lamportsToAdd / 1e9).toFixed(9)} SOL → WSOL ATA`));
      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: buyerKp.publicKey,
          toPubkey: wsolAta,
          lamports: lamportsToAdd,
        })
      );
      await sendAndConfirmTransaction(connection, fundTx, [buyerKp]);

      // 🔄 Sync WSOL
      const syncIx = createSyncNativeInstruction(wsolAta);
      const sig = await sendAndConfirmTransaction(connection, new Transaction().add(syncIx), [buyerKp], {
        commitment: "confirmed",
      });
      await connection.confirmTransaction(sig, "confirmed");

      // 🕐 Tambahkan sedikit delay biar node RPC nge-sync state ke cluster
      await new Promise((r) => setTimeout(r, 2000));

      console.log(chalk.green(`🔄 WSOL ATA synced & confirmed: ${wsolAta.toBase58()}`));

      // 🧾 Double-check parsed state
      const parsedInfo = await connection.getParsedAccountInfo(wsolAta);
      let state = "unknown";

      if (parsedInfo.value && "parsed" in parsedInfo.value.data) {
        state = (parsedInfo.value.data as ParsedAccountData).parsed.info.state;
      }

      console.log(chalk.gray(`🧩 WSOL state after sync: ${state}`));

      // 🕐 Short delay (ensure state visible)
      await new Promise((r) => setTimeout(r, 1200));

      // ⚙️ Ganti input token account Raydium agar pakai WSOL ATA yang benar
      console.log(chalk.yellow("🔧 Overriding userInTokenAccount → WSOL ATA for Raydium input"));
      userInTokenAccount = wsolAta;
      effectiveUserInAccount = wsolAta;
    }

    const info = await connection.getParsedAccountInfo(effectiveUserInAccount);
    console.log("🧾 WSOL Account state:", JSON.stringify(info.value?.data, null, 2));

    const metas = [
      ...baseMetas,
      { pubkey: fromPubkey, isSigner: true, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: false },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];

    console.log(chalk.gray("🔎 Remaining metas:"));
    metas.forEach((m, i) => console.log(`  [${i}] ${m.pubkey.toBase58()} ${m.isWritable ? "W" : ""}`));

    const dflowSwap2Ix = await buildDFlowSwap2Instruction(
      fromPubkey,               // userAuthority
      fromMintPublicKey,        // fromMint
      outputMint,               // toMint
      BigInt(inAmount),         // inAmount
      BigInt(outAmount),        // outAmount
      baseMetas                 // baseMetas dari aggregator
    );

    const poolData = await getDynamicPool(fromMint, toMint);
    if (!poolData) throw new Error(`Pool not found for ${fromMint} ↔ ${toMint}`);

    const raydiumIx = await buildRaydiumCpmmswapInstruction({
      userAuthority: fromPubkey,
      poolId: new PublicKey(poolData.poolId),
      ammConfig: new PublicKey("B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2"),
      inputMint: new PublicKey(fromMintPublicKey),
      outputMint: new PublicKey(outputMint),
      amountIn: BigInt(inAmount),
      minOut: BigInt(0),
    });

    // 🩹 Fix untuk SOL → Token
    if (fromMintPublicKey.toBase58() === "So11111111111111111111111111111111111111112") {
      const userWSOLATA = getAssociatedTokenAddressSync(
        new PublicKey("So11111111111111111111111111111111111111112"),
        fromPubkey
      );

      console.log(chalk.yellow("🩹 Post-DFLOW fix: Force override CPMM input_token_account → WSOL ATA"));
      console.log("   WSOL ATA:", userWSOLATA.toBase58());
      raydiumIx.keys[4].pubkey = userWSOLATA;
    }

    preInstructions.push(dflowSwap2Ix, raydiumIx);

    console.log("🧾 CPMM keys:");
    raydiumIx.keys.forEach((k, i) =>
      console.log(`#${i}`, k.pubkey.toBase58(), k.isWritable ? "W" : "", k.isSigner ? "S" : "")
    );

    async function getDynamicPool(fromMint: string, toMint: string) {
      try {
        const SOL_MINT = "So11111111111111111111111111111111111111112";

        // 🔍 Tentukan mint mana yang akan di-query ke Coinscan
        // SPL→SOL → query pakai fromMint
        // SOL→SPL → query pakai toMint
        const queryMint = fromMint === SOL_MINT ? toMint : fromMint;

        console.log(chalk.cyan(`🔍 Fetching pool info for query mint: ${queryMint}`));

        const resp = await fetch("https://api.coinscan.com/v2/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: queryMint }),
        });

        const data = await resp.json();

        if (data.success && data.data?.length > 0) {
          const found = data.data[0];
          console.log(chalk.blue("🔍 Coinscan found pair:"));
          console.table({
            dex: found.dexName,
            pairHash: found.pairHash,
            baseSymbol: found.baseSymbol,
            quoteSymbol: found.quoteSymbol,
            price: found.price,
          });

          return {
            source: "coinscan",
            poolId: found.pairHash,
            dex: found.dexName,
            baseSymbol: found.baseSymbol,
            quoteSymbol: found.quoteSymbol,
          };
        }
      } catch (e) {
        console.error("❌ Coinscan fetch error:", e);
      }

      console.error("🚫 No pool found for", fromMint, "↔", toMint);
      return null;
    }

    console.log(chalk.yellow("⚙️ DFlow::swap2 raw instruction built"));
    console.log("   Data (hex):", dflowSwap2Ix.data.toString("hex"));
    console.log("   Accounts :", dflowSwap2Ix.keys.map(k => k.pubkey.toBase58()));

    const ix = (await buildSwapInstruction(
      programUog,
      ixData,
      fromPubkey,
      aggIx.programId,
      marketConfigPda,
      treasuryPda,
      outputMint,
      treasuryTokenAccount,
      ensuredUserOutAccount,
      metas,
      inAmount
    ))!; // ✅ pakai non-null assertion

    console.log(chalk.green("✅ Swap instruction built successfully"));
    console.log(chalk.cyan("\n📏 Instruction Sizes ========================="));

    const allIxs = [
      ...preInstructions,
      raydiumIx,
      dflowSwap2Ix,
      ix,
      ...extraPostInstructions,
    ];

    // hitung ukuran setiap instruction
    allIxs.forEach((ix, idx) => {
      const serialized = ix.data ? ix.data.length : 0;
      console.log(
        `#${idx.toString().padStart(2, "0")} ${chalk.gray(ix.programId.toBase58())}`,
        chalk.yellow(`→ ${serialized} bytes`),
        chalk.gray(`| keys: ${ix.keys.length}`)
      );
    });

    // Urutan aman - buang preInstructions kalau SOL (sudah di-handle di wrapSOLIfNeeded)
    const safePreIxs = fromMint === SOL_MINT ? [] : preInstructions;

    // ============================================================
    // 💰 Tambahan transfer hasil Raydium ke Treasury ATA
    // ============================================================
    if (toMint && userOutTokenAccount && treasuryTokenAccount) {
      const transferIx = createTransferInstruction(
        userOutTokenAccount,       // sumber UOG hasil swap Raydium
        treasuryTokenAccount,      // tujuan: treasury kamu
        fromPubkey,                // signer (wallet user)
        Number(outAmount)          // jumlah hasil swap (atau trade_fee)
      );
      preInstructions.push(transferIx);
      console.log(chalk.yellow(`⚙️ Added SPL Transfer → move UOG from userOutTokenAccount → treasuryTokenAccount`));
    }

    const txOut = await buildFinalTransaction(
      connection,
      fromPubkey,
      [
        ...safePreIxs,       // ✅ kosongkan jika input SOL
        raydiumIx,
        dflowSwap2Ix,
      ],
      ix,
      extraPostInstructions,
      effectiveUserInAccount,
      ensuredUserOutAccount,
      treasuryTokenAccount,
      treasuryPda
    );

    // 🪙 Refund WSOL jika masih ada setelah build
    // if (fromMint === SOL_MINT) {
    //   try {
    //     const wsolBalance = await connection.getTokenAccountBalance(effectiveUserInAccount);
    //     const balanceLamports = Number(wsolBalance.value.amount);

    //     console.log(chalk.gray(`🔍 Checking WSOL refund balance: ${balanceLamports / 1e9} SOL`));

    //     if (balanceLamports > 0) {
    //       console.log(chalk.yellow("💸 Refunding unused WSOL → SOL..."));

    //       const refundIx = createCloseAccountInstruction(
    //         effectiveUserInAccount, // WSOL ATA
    //         fromPubkey,             // destination wallet
    //         fromPubkey              // authority
    //       );

    //       const refundTx = new Transaction().add(refundIx);
    //       await sendAndConfirmTransaction(connection, refundTx, [buyerKp]);
    //       console.log(chalk.green(`✅ WSOL refunded back to SOL wallet: ${fromPubkey.toBase58()}`));
    //     } else {
    //       console.log(chalk.gray("⏭️ No WSOL left to refund."));
    //     }
    //   } catch (err: any) {
    //     console.error(chalk.red("⚠️ Refund WSOL failed:"), err.message);
    //   }
    // }

    const serialized = txOut.serialize({ requireAllSignatures: false });
    console.log(chalk.green("✅ Final transaction ready"));
    console.log(chalk.gray("Tx length:"), serialized.length, "bytes");

    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error(chalk.red("❌ swap/build error:"), err.message);
    console.error(chalk.gray(err.stack));

    // 🪙 Pastikan WSOL direfund jika transaksi gagal
    try {
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      if (fromMint === SOL_MINT && buyerKp && connection) {
        const wsolAta = await getAssociatedTokenAddress(new PublicKey(SOL_MINT), buyerKp.publicKey);
        const bal = await connection!.getTokenAccountBalance(wsolAta);
        const lamports = Number(bal.value.amount);

        console.log(chalk.gray(`🔍 Checking WSOL refund (catch): ${lamports / 1e9} SOL`));

        if (lamports > 0) {
          console.log(chalk.yellow("💸 Refunding WSOL → SOL (from catch)..."));

          const refundIx = createCloseAccountInstruction(
            wsolAta,
            buyerKp.publicKey, // refund ke wallet user
            buyerKp.publicKey  // authority
          );
          const refundTx = new Transaction().add(refundIx);
          await sendAndConfirmTransaction(connection!, refundTx, [buyerKp]);
          console.log(chalk.green(`✅ WSOL refunded after error → ${buyerKp.publicKey.toBase58()}`));
        } else {
          console.log(chalk.gray("⏭️ No WSOL to refund in catch."));
        }
      }
    } catch (refundErr: any) {
      console.error(chalk.red("⚠️ Refund WSOL in catch failed:"), refundErr.message);
    }

    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/submit
//
router.post("/swap/submit", async (req: Request, res: Response) => {
  try {
    console.log(chalk.cyan("\n📩 [SWAP SUBMIT] Request received ========================"));
    console.log(chalk.gray(JSON.stringify(req.body, null, 2)));

    const { signedTx, inAmount, fromMint, toMint } = req.body;
    const fundLamports = parseInt(inAmount) + 5000; // buffer
    console.log(`💰 Funding WSOL ATA with ${fundLamports / 1e9} SOL for ${fromMint}→${toMint}`);

    if (!signedTx) return res.status(400).json({ error: "signedTx required" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");
    console.log(chalk.blue("🔗 Network:"), process.env.SOLANA_CLUSTER);
    console.log(chalk.gray("Tx buffer length:"), txBuffer.length, "bytes");

    // ============================================================
    // 🧩 Decode Transaction (Legacy atau Versioned)
    // ============================================================
    let isVersioned = false;
    try {
      const vtx = VersionedTransaction.deserialize(txBuffer);
      isVersioned = true;
      console.log(chalk.yellow("🧩 Versioned TX Keys:"));
      vtx.message.staticAccountKeys.forEach((key: PublicKey, i: number) =>
        console.log(`  [${i}] ${key.toBase58()}`)
      );
      console.log("Instruction count:", vtx.message.compiledInstructions.length);
    } catch {
      const tx = Transaction.from(txBuffer);
      console.log(chalk.yellow("🧩 Legacy TX Keys:"));
      (tx as any).message.accountKeys.forEach((key: PublicKey, i: number) =>
        console.log(`  [${i}] ${key.toBase58()}`)
      );
      console.log("Instruction count:", tx.instructions.length);
    }

    // ============================================================
    // 🩹 Sanity Check: Pastikan WSOL ATA sudah aktif
    // ============================================================
    try {
      const user = new PublicKey("7GeP2NXT6DzX3Sw973G5mvFacG7AiyUe25XjvKDpQDGZ"); // bisa diganti dinamis nanti
      const WSOL_ATA = getAssociatedTokenAddressSync(
        new PublicKey("So11111111111111111111111111111111111111112"),
        user
      );
      const info = await connection.getAccountInfo(WSOL_ATA);

      if (!info) {
        console.warn(chalk.red(`⚠️ WSOL ATA belum ditemukan (${WSOL_ATA.toBase58()}) — coba buat ulang di node ini...`));

        try {
          const createIx = createAssociatedTokenAccountInstruction(
            user,
            WSOL_ATA,
            user,
            new PublicKey("So11111111111111111111111111111111111111112")
          );

          const tx = new Transaction().add(createIx);
          const sigCreate = await sendAndConfirmTransaction(connection, tx, [Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/msi/.config/solana/seftzzz.json", "utf8"))))]);
          console.log(chalk.green(`✅ WSOL ATA recreated successfully: ${WSOL_ATA.toBase58()} (${sigCreate})`));

          // 🧩 Fund WSOL ATA jika kosong
          const balInfo = await connection.getTokenAccountBalance(WSOL_ATA).catch(() => null);
          const balance = balInfo?.value?.uiAmount || 0;

          if (balance <= 0) {
            console.log(chalk.yellow(`💸 Funding WSOL ATA with SOL since balance is 0...`));

            const totalFund = fundLamports * LAMPORTS_PER_SOL; // sesuaikan dengan inAmount sebenarnya
            const fundTx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: user,
                toPubkey: WSOL_ATA,
                lamports: totalFund,
              }),
              createSyncNativeInstruction(WSOL_ATA)
            );

            const payer = Keypair.fromSecretKey(
              Uint8Array.from(
                JSON.parse(fs.readFileSync("/home/msi/.config/solana/seftzzz.json", "utf8"))
              )
            );

            const sigFund = await sendAndConfirmTransaction(connection, fundTx, [payer]);
            console.log(chalk.green(`✅ WSOL ATA funded: ${totalFund / 1e9} SOL (${sigFund})`));
          }

          // tambahkan sync delay agar cluster aware
          await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
          console.error(chalk.red(`❌ Failed to recreate WSOL ATA: ${(e as Error).message}`));
        }
      } else {
        const parsed = await connection.getParsedAccountInfo(WSOL_ATA);
        const state = (parsed.value as any)?.data?.parsed?.info?.state;
        const balance = (parsed.value as any)?.data?.parsed?.info?.tokenAmount?.uiAmount;
        console.log(chalk.green(`✅ WSOL ATA exists: ${WSOL_ATA.toBase58()} [state=${state}, balance=${balance}]`));
      }
    } catch (e) {
      console.warn(chalk.red("⚠️ WSOL ATA check failed:"), (e as Error).message);
    }

    // ============================================================
    // 🚀 Kirim transaksi
    // ============================================================
    let sig: string;
    try {
      if (isVersioned) {
        const vtx = VersionedTransaction.deserialize(txBuffer);
        console.log(chalk.green("🔄 Sending VersionedTransaction..."));
        sig = await connection.sendTransaction(vtx, {
          skipPreflight: false,
          maxRetries: 5,
        });
      } else {
        console.log(chalk.green("🔄 Sending Legacy Transaction..."));
        sig = await sendAndConfirmRawTransaction(connection, txBuffer, {
          skipPreflight: false,
          maxRetries: 5,
        });
      }
    } catch (sendErr: any) {
      console.error(chalk.red("❌ sendTransaction failed:"), sendErr.message);
      throw sendErr;
    }

    console.log(chalk.green("✅ TX sent to cluster, signature:"), sig);
    console.log("🔍 Explorer:", `https://solscan.io/tx/${sig}?cluster=mainnet`);

    // ============================================================
    // 🧾 Konfirmasi transaksi di jaringan
    // ============================================================
    for (let i = 0; i < 5; i++) {
      const confirmation = await connection.confirmTransaction(sig, "confirmed");
      if (confirmation.value.err == null) {
        console.log(chalk.green("✅ Confirmed on-chain"));
        res.json({ signature: sig, explorer: `https://solscan.io/tx/${sig}?cluster=mainnet` });
        return;
      }
      console.warn(chalk.yellow(`⚠️ Retry confirm [${i + 1}]...`));
      await new Promise(r => setTimeout(r, 5000));
    }

    res.json({ signature: sig, explorer: `https://solscan.io/tx/${sig}?cluster=mainnet` });

  } catch (err: any) {
    console.error(chalk.red("❌ swap/submit error:"), err.message);
    if (err.logs) console.error(chalk.gray("On-chain logs:"), err.logs.join("\n"));

    // 🧠 Analisis otomatis untuk error umum
    if (err.message?.includes("custom program error: 0xbc4")) {
      console.error(chalk.redBright("💥 Detected AnchorError: AccountNotInitialized — CPMM gagal baca ATA WSOL sebelum sync."));
    }

    res.status(500).json({ error: err.message });
  }
});

// GET /wallet/:address?mint=<mintAddress>
router.get("/trades/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const { mint } = req.query;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    console.log(chalk.blue("🔗 RPC Endpoint:"), process.env.SOLANA_CLUSTER);

    const walletPk = new PublicKey(address);
    const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 100 });

    const limit = pLimit(5);
    const trades: any[] = [];

    const allowedEvents = ["SwapToken", "SendToken", "BuyNft", "MintAndList", "RelistNft"];
    const programLabelMap: Record<string, string> = {
      SwapToken: "Swap Token",
      SendToken: "Send Token",
      BuyNft: "Buy NFT",
      MintAndList: "Gatcha",
      RelistNft: "Relist NFT",
    };

    await Promise.all(
      sigs.map((sig) =>
        limit(async () => {
          try {
            const tx = await connection.getTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta?.logMessages) return;

            const logs = tx.meta.logMessages;
            const instructionLogs = logs.filter((l) => l.includes("Instruction:"));
            const instructionTypes = instructionLogs.map((l) =>
              l.split("Instruction:")[1].trim()
            );
            const uniqueInstructions = [...new Set(instructionTypes)];

            const mainEvent = allowedEvents.find((evt) =>
              uniqueInstructions.some((i) => i.toLowerCase().includes(evt.toLowerCase()))
            );
            if (!mainEvent) return;

            const accountKeys = tx.transaction.message
              .getAccountKeys()
              .staticAccountKeys.map((k) => k.toBase58());

            // 🎯 Filter by mint if specified
            if (mint && !accountKeys.includes(mint as string)) return;

            // === 💰 Perubahan SOL balance
            const walletIndex = accountKeys.indexOf(address);
            let amount_from = null;
            let amount_to = null;

            if (walletIndex >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
              const diffLamports =
                tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex];
              const diff = diffLamports / anchor.web3.LAMPORTS_PER_SOL;
              if (diff < 0) amount_from = Math.abs(diff);
              if (diff > 0) amount_to = diff;
            }

            // === 💎 Perubahan token SPL balance (selain SOL)
            let tokenAmountFrom: number | null = null;
            let tokenAmountTo: number | null = null;
            let fromTokenInfo =
              tokenMap["So11111111111111111111111111111111111111112"];
            let toTokenInfo =
              tokenMap["So11111111111111111111111111111111111111112"];

            const preTokens = tx.meta?.preTokenBalances || [];
            const postTokens = tx.meta?.postTokenBalances || [];

            for (const pre of preTokens) {
              if (!pre.owner || pre.owner !== address) continue;
              const post = postTokens.find(
                (p) => p.owner === address && p.mint === pre.mint
              );
              if (!post) continue;

              const decimals = pre.uiTokenAmount?.decimals ?? 0;
              const preRaw = Number(pre.uiTokenAmount?.amount || 0);
              const postRaw = Number(post.uiTokenAmount?.amount || 0);
              const preAmount = preRaw / 10 ** decimals;
              const postAmount = postRaw / 10 ** decimals;
              const diff = postAmount - preAmount;

              if (diff < 0) {
                tokenAmountFrom = Math.abs(diff);
                fromTokenInfo = tokenMap[pre.mint] || {
                  symbol: "Unknown",
                  image: "https://api.universeofgamers.io/uploads/token-placeholder.png",
                  address: pre.mint,
                };
              } else if (diff > 0) {
                tokenAmountTo = diff;
                toTokenInfo = tokenMap[pre.mint] || {
                  symbol: "Unknown",
                  image: "https://api.universeofgamers.io/uploads/token-placeholder.png",
                  address: pre.mint,
                };
              }
            }

            if (tokenAmountFrom) amount_from = tokenAmountFrom;
            if (tokenAmountTo) amount_to = tokenAmountTo;

            // === 🎯 Pair untuk SwapToken (fix arah input/output + fallback smart)
            if (mainEvent === "SwapToken") {
              let detectedFrom: string | null = null;
              let detectedTo: string | null = null;

              const preTokens = tx.meta?.preTokenBalances || [];
              const postTokens = tx.meta?.postTokenBalances || [];

              for (const pre of preTokens) {
                if (!pre.owner || pre.owner !== address) continue;

                const post = postTokens.find(
                  (p) => p.owner === address && p.mint === pre.mint
                );
                if (!post) continue;

                const decimals = pre.uiTokenAmount?.decimals ?? 0;
                const preRaw = Number(pre.uiTokenAmount?.amount || 0);
                const postRaw = Number(post.uiTokenAmount?.amount || 0);
                const preAmount = preRaw / 10 ** decimals;
                const postAmount = postRaw / 10 ** decimals;
                const diff = postAmount - preAmount;

                if (diff < 0) detectedFrom = pre.mint;
                if (diff > 0) detectedTo = pre.mint;
              }

              if (detectedFrom && !detectedTo) {
                const possibleTargets = accountKeys.filter(
                  (k) => tokenMap[k] && k !== detectedFrom
                );
                if (possibleTargets.length > 0) detectedTo = possibleTargets[0];
              }

              if (!detectedFrom && detectedTo) {
                const possibleSources = accountKeys.filter(
                  (k) => tokenMap[k] && k !== detectedTo
                );
                if (possibleSources.length > 0) detectedFrom = possibleSources[0];
              }

              fromTokenInfo =
                (detectedFrom && tokenMap[detectedFrom]) ||
                tokenMap["So11111111111111111111111111111111111111112"];
              toTokenInfo =
                (detectedTo && tokenMap[detectedTo]) ||
                tokenMap["So11111111111111111111111111111111111111112"];

              console.log(
                `💱 Swap detected: ${fromTokenInfo.symbol} → ${toTokenInfo.symbol}`
              );
            } else {
              const detectedMint = accountKeys.find((k) => tokenMap[k]);
              if (detectedMint) fromTokenInfo = toTokenInfo = tokenMap[detectedMint];
            }

            // === 🧩 Format JSON Response
            const trade = {
              tx: sig.signature,
              program: programLabelMap[mainEvent] || mainEvent,
              time: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
              from: amount_from
                ? { amount: amount_from, token: fromTokenInfo }
                : null,
              to: amount_to
                ? { amount: amount_to, token: toTokenInfo }
                : null,
              pairToken:
                mainEvent === "SwapToken"
                  ? {
                      from: fromTokenInfo,
                      to: toTokenInfo,
                      label: `${fromTokenInfo.symbol}/${toTokenInfo.symbol}`,
                      icons: [fromTokenInfo.image, toTokenInfo.image],
                    }
                  : null,
              price: { usd: 0 },
              volume: { usd: 0 },
            };

            trades.push(trade);
          } catch (err: any) {
            console.warn(`⚠️ Skip TX ${sig.signature}: ${err.message}`);
          }
        })
      )
    );

    // 🔁 Urutkan dari terbaru ke lama
    trades.sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0));

    console.log(
      chalk.green(
        `✅ Finalized ${trades.length} parsed trades for ${address}${mint ? ` (mint ${mint})` : ""}`
      )
    );

    res.json({ status: true, total: trades.length, wallet: address, trades });
  } catch (err: any) {
    console.error("❌ Error fetching wallet trades:", err);
    res.status(500).json({ status: false, error: err.message });
  }
});

router.get("/trades", async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    console.log(chalk.blue("🔗 RPC Endpoint:"), process.env.SOLANA_CLUSTER);

    const walletPk = new PublicKey(wallet as string);
    const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 100 });

    const limit = pLimit(5);
    const trades: any[] = [];

    const allowedEvents = ["SwapToken", "SendToken", "BuyNft", "MintAndList", "RelistNft"];
    const programLabelMap: Record<string, string> = {
      SwapToken: "Swap Token",
      SendToken: "Send Token",
      BuyNft: "Buy NFT",
      MintAndList: "Gatcha",
      RelistNft: "Relist NFT",
    };

    await Promise.all(
      sigs.map((sig) =>
        limit(async () => {
          try {
            const tx = await connection.getTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta?.logMessages) return;

            const logs = tx.meta.logMessages;
            const instructionLogs = logs.filter((l) => l.includes("Instruction:"));
            const instructionTypes = instructionLogs.map((l) =>
              l.split("Instruction:")[1].trim()
            );
            const uniqueInstructions = [...new Set(instructionTypes)];

            const mainEvent = allowedEvents.find((evt) =>
              uniqueInstructions.some((i) => i.toLowerCase().includes(evt.toLowerCase()))
            );
            if (!mainEvent) return;

            const accountKeys = tx.transaction.message
              .getAccountKeys()
              .staticAccountKeys.map((k) => k.toBase58());

            // === 💰 Perubahan SOL balance
            const walletIndex = accountKeys.indexOf(wallet as string);
            let amount_from = null;
            let amount_to = null;

            if (walletIndex >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
              const diffLamports =
                tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex];
              const diff = diffLamports / anchor.web3.LAMPORTS_PER_SOL;
              if (diff < 0) amount_from = Math.abs(diff);
              if (diff > 0) amount_to = diff;
            }

            // === 💎 Perubahan token SPL balance (selain SOL)
            let tokenAmountFrom: number | null = null;
            let tokenAmountTo: number | null = null;
            let fromTokenInfo =
              tokenMap["So11111111111111111111111111111111111111112"];
            let toTokenInfo =
              tokenMap["So11111111111111111111111111111111111111112"];

            const preTokens = tx.meta?.preTokenBalances || [];
            const postTokens = tx.meta?.postTokenBalances || [];

            for (const pre of preTokens) {
              if (!pre.owner || pre.owner !== wallet) continue;
              const post = postTokens.find(
                (p) => p.owner === wallet && p.mint === pre.mint
              );
              if (!post) continue;

              // 🔹 Pastikan decimals selalu ada
              const decimals = pre.uiTokenAmount?.decimals ?? 0;

              const preRaw = Number(pre.uiTokenAmount?.amount || 0);
              const postRaw = Number(post.uiTokenAmount?.amount || 0);

              const preAmount = preRaw / 10 ** decimals;
              const postAmount = postRaw / 10 ** decimals;
              const diff = postAmount - preAmount;

              if (diff < 0) {
                tokenAmountFrom = Math.abs(diff);
                fromTokenInfo = tokenMap[pre.mint] || {
                  symbol: "Unknown",
                  image: "https://api.universeofgamers.io/uploads/token-placeholder.png",
                  address: pre.mint,
                };
              } else if (diff > 0) {
                tokenAmountTo = diff;
                toTokenInfo = tokenMap[pre.mint] || {
                  symbol: "Unknown",
                  image: "https://api.universeofgamers.io/uploads/token-placeholder.png",
                  address: pre.mint,
                };
              }
            }

            // === Jika token amount ditemukan, override SOL
            if (tokenAmountFrom) amount_from = tokenAmountFrom;
            if (tokenAmountTo) amount_to = tokenAmountTo;

            // === 🎯 Pair untuk SwapToken (fix arah input/output + fallback smart)
            if (mainEvent === "SwapToken") {
              let detectedFrom: string | null = null;
              let detectedTo: string | null = null;

              const preTokens = tx.meta?.preTokenBalances || [];
              const postTokens = tx.meta?.postTokenBalances || [];

              for (const pre of preTokens) {
                if (!pre.owner || pre.owner !== wallet) continue;

                const post = postTokens.find(
                  (p) => p.owner === wallet && p.mint === pre.mint
                );
                if (!post) continue;

                const decimals = pre.uiTokenAmount?.decimals ?? 0;
                const preRaw = Number(pre.uiTokenAmount?.amount || 0);
                const postRaw = Number(post.uiTokenAmount?.amount || 0);
                const preAmount = preRaw / 10 ** decimals;
                const postAmount = postRaw / 10 ** decimals;
                const diff = postAmount - preAmount;

                // token berkurang = FROM, token bertambah = TO
                if (diff < 0) detectedFrom = pre.mint;
                if (diff > 0) detectedTo = pre.mint;
              }

              // 🧩 Fallback pintar kalau cuma FROM ditemukan
              if (detectedFrom && !detectedTo) {
                const possibleTargets = accountKeys.filter(
                  (k) => tokenMap[k] && k !== detectedFrom
                );
                if (possibleTargets.length > 0) {
                  detectedTo = possibleTargets[0]; // ambil token berbeda pertama di accountKeys
                }
              }

              // 🧩 Fallback sebaliknya: kalau TO ada tapi FROM tidak
              if (!detectedFrom && detectedTo) {
                const possibleSources = accountKeys.filter(
                  (k) => tokenMap[k] && k !== detectedTo
                );
                if (possibleSources.length > 0) {
                  detectedFrom = possibleSources[0];
                }
              }

              // Tetapkan info token final
              fromTokenInfo =
                (detectedFrom && tokenMap[detectedFrom]) ||
                tokenMap["So11111111111111111111111111111111111111112"];
              toTokenInfo =
                (detectedTo && tokenMap[detectedTo]) ||
                tokenMap["So11111111111111111111111111111111111111112"];

              console.log(
                `💱 Swap detected: ${fromTokenInfo.symbol} → ${toTokenInfo.symbol}`
              );
            } else {
              const detectedMint = accountKeys.find((k) => tokenMap[k]);
              if (detectedMint) fromTokenInfo = toTokenInfo = tokenMap[detectedMint];
            }

            // === 🧩 Format JSON Response
            const trade = {
              tx: sig.signature,
              program: programLabelMap[mainEvent] || mainEvent,
              time: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
              from: amount_from
                ? { amount: amount_from, token: fromTokenInfo }
                : null,
              to: amount_to
                ? { amount: amount_to, token: toTokenInfo }
                : null,
              pairToken:
                mainEvent === "SwapToken"
                  ? {
                      from: fromTokenInfo,
                      to: toTokenInfo,
                      label: `${fromTokenInfo.symbol}/${toTokenInfo.symbol}`,
                      icons: [fromTokenInfo.image, toTokenInfo.image],
                    }
                  : null,
              price: { usd: 0 },
              volume: { usd: 0 },
            };

            trades.push(trade);
          } catch (err: any) {
            console.warn(`⚠️ Skip TX ${sig.signature}: ${err.message}`);
          }
        })
      )
    );

    // 🔁 Urutkan dari terbaru ke lama
    trades.sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0));

    console.log(`✅ Finalized ${trades.length} parsed trades for ${wallet}`);
    res.json({ status: true, total: trades.length, wallet, trades });
  } catch (err: any) {
    console.error("❌ Error fetching wallet trades:", err);
    res.status(500).json({ status: false, error: err.message });
  }
});

export default router;
