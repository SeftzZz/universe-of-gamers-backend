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
  createApproveInstruction
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getTokenInfo } from "../services/priceService";
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

dotenv.config();
const router = Router();
const limit = pLimit(5);

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

//
// GET /wallet/balance/:address
//
router.get("/balance/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    let wallet: any = null;
    let attempt = 0;
    const maxRetries = 3;
    let lastError: any = null;

    while (attempt < maxRetries && !wallet) {
      try {
        wallet = await solanaTracker.getWallet(address);
      } catch (err) {
        lastError = err;
        attempt++;
        console.warn(`⚠️ getWallet attempt ${attempt} failed:`, (err as any).message);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff 1s, 2s, ...
        }
      }
    }

    if (!wallet) {
      return res.status(500).json({ error: "Failed to fetch wallet", details: lastError?.message });
    }

    const solToken = wallet.tokens.find(
      (t: any) =>
        t.token.symbol === "SOL" ||
        t.token.mint === "So11111111111111111111111111111111111111112"
    );

    const solBalance = solToken?.balance ?? 0;
    const solTotal = wallet.totalSol ?? 0;
    const solPriceUsd = solToken?.pools?.[0]?.price?.usd ?? 0;
    const usdValue = solPriceUsd ? solBalance * solPriceUsd : null;

    const percentChange = solToken?.events?.["24h"]?.priceChangePercentage ?? 0;
    const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

    await WalletBalance.findOneAndUpdate(
      { address },
      {
        address,
        solBalance,
        solTotal,
        solPriceUsd,
        usdValue,
        percentChange,
        trend,
        lastUpdated: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({
      address,
      solBalance,
      solTotal,
      solPriceUsd,
      usdValue,
      percentChange,
      trend,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("❌ Error fetching balance:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/tokens/:address
//
router.get("/tokens/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) {
      return res.status(400).json({ error: "Missing wallet address" });
    }

    const MAX_CACHE_AGE = 5 * 60 * 1000; // 5 menit
    const now = Date.now();

    // 1️⃣ Cek token dari database
    let dbTokens = await WalletToken.find({ address }).lean();
    const hasDb = dbTokens.length > 0;

    if (hasDb) {
      const allFresh = dbTokens.every(
        (t) => now - new Date(t.lastUpdated).getTime() < MAX_CACHE_AGE
      );
      if (allFresh) {
        console.log(`✅ Returning cached tokens for ${address}`);
        return res.json({
          address,
          tokens: dbTokens,
          total: dbTokens.reduce((sum, t) => sum + (t.usdValue ?? 0), 0),
          totalSol: dbTokens.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
          source: "db-cache",
        });
      }
    }

    // 2️⃣ Ambil data wallet dari Solana Tracker
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

    // 3️⃣ Jika API gagal total, gunakan DB lama
    if (!wallet) {
      console.warn(`⚠️ Wallet ${address} not found after ${maxRetries} attempts`);
      if (hasDb) {
        console.log(`⚡ Returning expired cache for ${address}`);
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

    // 4️⃣ Jika wallet tidak punya token → ambil dari DB + default
    if (!wallet?.tokens?.length) {
      console.warn(`⚠️ Wallet ${address} has no tokens on-chain, merging DB + defaults...`);
      const defaults = await getDefaultTokens();
      const merged = [
        ...defaults,
        ...dbTokens.filter((d) => !defaults.find((x) => x.mint === d.mint)),
      ];

      return res.json({
        address,
        tokens: merged,
        total: merged.reduce((sum, t) => sum + (t.usdValue ?? 0), 0),
        totalSol: merged.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
        source: "db+defaults",
      });
    }

    // 5️⃣ Map token hasil dari API
    const apiTokens = wallet.tokens.map((t: any) => {
      const priceUsd = t.pools?.[0]?.price?.usd ?? 0;
      const liquidity = t.pools?.[0]?.liquidity?.usd ?? 0;
      const marketCap = t.pools?.[0]?.marketCap?.usd ?? 0;
      const percentChange = t.events?.["24h"]?.priceChangePercentage ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      // ✅ Ganti mint WSOL → native SOL agar disatukan
      const mint =
        t.token.mint === "So11111111111111111111111111111111111111112"
          ? "So11111111111111111111111111111111111111111"
          : t.token.mint;

      return {
        mint,
        name: mint === "So11111111111111111111111111111111111111111" ? "Solana" : t.token.name,
        symbol: mint === "So11111111111111111111111111111111111111111" ? "SOL" : t.token.symbol,
        logoURI:
          mint === "So11111111111111111111111111111111111111111"
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
      };
    });

    // 6️⃣ Merge token hasil API + DB + Default
    const defaults = await getDefaultTokens();
    let mergedTokens = [
      ...apiTokens,
      ...dbTokens.filter((d: any) => !apiTokens.find((x: any) => x.mint === d.mint)),
      ...defaults.filter(
        (d: any) =>
          !apiTokens.find((x: any) => x.mint === d.mint) &&
          !dbTokens.find((x: any) => x.mint === d.mint)
      ),
    ];

    // ✅ Gabungkan native SOL & Wrapped SOL jika keduanya ada
    const SOL_MINT = "So11111111111111111111111111111111111111111";
    const solVariants = mergedTokens.filter((t) =>
      ["So11111111111111111111111111111111111111111", "So11111111111111111111111111111111111111112"].includes(t.mint)
    );

    if (solVariants.length > 1) {
      const totalAmount = solVariants.reduce((sum, t) => sum + (t.amount ?? 0), 0);
      const totalUsdValue = solVariants.reduce((sum, t) => sum + (t.usdValue ?? 0), 0);
      const base = solVariants.find((t) => t.mint === SOL_MINT) ?? solVariants[0];

      const unifiedSol = {
        ...base,
        amount: parseFloat(totalAmount.toFixed(6)),
        usdValue: parseFloat(totalUsdValue.toFixed(2)),
        mint: SOL_MINT,
        name: "Solana",
        symbol: "SOL",
      };

      if (!base.priceUsd || base.priceUsd === 0) {
        try {
          const coingecko = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
          const solPrice = (await coingecko.json()).solana.usd;
          unifiedSol.priceUsd = solPrice;
          unifiedSol.usdValue = parseFloat((totalAmount * solPrice).toFixed(2));
        } catch (e: any) {
          console.warn("⚠️ Failed to fetch SOL price fallback:", e.message);
        }
      }

      // Hapus WSOL & SOL lama → tambahkan hasil gabungan
      mergedTokens = mergedTokens.filter(
        (t) =>
          !["So11111111111111111111111111111111111111111", "So11111111111111111111111111111111111111112"].includes(
            t.mint
          )
      );
      mergedTokens.unshift(unifiedSol);
    }

    console.log(`✅ Returning ${mergedTokens.length} tokens for ${address}`);

    broadcast({
      type: "tokens-update",
      address,
      tokens: mergedTokens,
      total: mergedTokens.reduce((s, t) => s + (t.usdValue ?? 0), 0),
      totalSol: mergedTokens.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
      source: "api+db",
      timestamp: new Date().toISOString(),
    });

    res.json({
      address,
      tokens: mergedTokens,
      total: mergedTokens.reduce((s, t) => s + (t.usdValue ?? 0), 0),
      totalSol: mergedTokens.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
      source: "api+db",
    });

  } catch (err: any) {
    console.error("❌ Error fetching wallet:", err);
    res.status(500).json({ error: err.message });
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

    tx.partialSign(signer);
    const signedTx = tx.serialize().toString("base64");

    // 5️⃣ Update database
    txDoc.status = "signed";
    txDoc.signedTx = signedTx;
    txDoc.signedAt = new Date();
    await txDoc.save();

    console.log("✅ Manual sign completed:", txDoc._id);

    // 6️⃣ (Opsional) Kirim langsung ke Solana untuk broadcast otomatis
    // const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
    // const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    // await connection.confirmTransaction(signature, "confirmed");
    // console.log("✅ Sent + Confirmed:", signature);
    // txDoc.status = "confirmed";
    // txDoc.confirmedAt = new Date();
    // txDoc.txSig = signature;
    // await txDoc.save();

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
  try {
    console.log(chalk.cyan("\n📩 [SWAP BUILD] AuthRequest received ========================"));
    console.log(chalk.gray(JSON.stringify(req.body, null, 2)));

    const { from, openTransaction, toMint, outAmount, fromMint, inAmount } = req.body;
    if (!from || !openTransaction || !fromMint || !inAmount)
      return res.status(400).json({ error: "from, openTransaction, fromMint, inAmount required" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

    // 🧩 Ambil keypair user dari database (custodial)
    const { id: userId } = req.user;
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const buyerCustodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!buyerCustodian) return res.status(400).json({ error: "No buyer wallet" });

    const buyerKp = Keypair.fromSecretKey(bs58.decode(decrypt(buyerCustodian.privateKey)));
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

    const {
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

      // 🚫 Abaikan auto-create ATA untuk WSOL karena sudah ditangani manual
      if (mint.toBase58() === WSOL_MINT) {
        console.log(chalk.gray(`⏭️ Skipping ensureAtaExists for WSOL mint (${mint.toBase58()})`));
        return { ata: await getAssociatedTokenAddress(mint, owner), ix: null };
      }

      const ata = await getAssociatedTokenAddress(mint, owner);
      try {
        const info = await connection.getAccountInfo(ata);
        if (info) {
          console.log(chalk.green(`✅ ATA exists for ${mint.toBase58()}: ${ata.toBase58()}`));
          return { ata, ix: null };
        } else {
          throw new Error("not found");
        }
      } catch (err) {
        console.log(chalk.yellow(`⚙️ Creating ATA for ${mint.toBase58()}`));
        const createAtaIx = createAssociatedTokenAccountInstruction(owner, ata, owner, mint);
        return { ata, ix: createAtaIx };
      }
    }

    // 🧱 Pastikan ATA user output selalu ada
    const ensureOut = await ensureAtaExists(connection, fromPubkey, outputMint);
    if (ensureOut.ix) {
      console.log(chalk.yellow(`📥 Adding ATA creation instruction for ${outputMint.toBase58()}`));
      preInstructions.push(ensureOut.ix);
    }
    const ensuredUserOutAccount = ensureOut.ata;

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

    async function getDynamicPool(fromMint: string, toMint: string) {
      try {
        const resp = await fetch("https://api.coinscan.com/v2/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: toMint }),
        });
        const data = await resp.json();

        if (data.success && data.data?.length > 0) {
          const found = data.data[0];
          console.log(chalk.blue("🔍 Coinscan found pair:"));
          console.table({
            dex: found.dexName,
            pairHash: found.pairHash,
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

      // ❌ 3️⃣ Jika semua gagal
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

    let fundWSOLIx: TransactionInstruction | null = null;
    let syncWSOLIx: TransactionInstruction | null = null;

    if (fromMint === SOL_MINT) {
      console.log("⚡ Wrapping SOL → WSOL ATA");
      fundWSOLIx = SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: userInTokenAccount, // WSOL ATA
        lamports: Number(inAmount),
      });
      syncWSOLIx = createSyncNativeInstruction(userInTokenAccount);
    } else {
      console.log("⏭️ Skipping SyncNative (not WSOL)");
    }

    const allIxs = [
      ...preInstructions,
      ...(fundWSOLIx ? [fundWSOLIx] : []),
      ...(syncWSOLIx ? [syncWSOLIx] : []),
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

    // Urutan aman
    const txOut = await buildFinalTransaction(
      connection,
      fromPubkey,
      [
        ...preInstructions,
        ...(fundWSOLIx ? [fundWSOLIx] : []),
        ...(syncWSOLIx ? [syncWSOLIx] : []),
        raydiumIx,
        dflowSwap2Ix,
      ],
      ix,
      extraPostInstructions,
      userInTokenAccount,
      ensuredUserOutAccount,
      treasuryTokenAccount,
      treasuryPda
    );

    const serialized = txOut.serialize({ requireAllSignatures: false });
    console.log(chalk.green("✅ Final transaction ready"));
    console.log(chalk.gray("Tx length:"), serialized.length, "bytes");

    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error(chalk.red("❌ swap/build error:"), err.message);
    console.error(chalk.gray(err.stack));
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

    const { signedTx } = req.body;
    if (!signedTx) return res.status(400).json({ error: "signedTx required" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");
    console.log(chalk.blue("🔗 Network:"), process.env.SOLANA_CLUSTER);
    console.log(chalk.gray("Tx buffer length:"), txBuffer.length, "bytes");

    try {
      try {
        const vtx = VersionedTransaction.deserialize(txBuffer);
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
    } catch (decodeErr: unknown) {
      console.warn(chalk.red("⚠️ Failed to decode TX for debug:"), (decodeErr as Error).message);
    }

    const sig = await sendAndConfirmRawTransaction(connection, txBuffer, {
      skipPreflight: false,
      maxRetries: 5,
    });

    console.log(chalk.green("✅ TX sent to cluster, signature:"), sig);
    console.log("🔍 Explorer:", `https://solscan.io/tx/${sig}?cluster=mainnet`);

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
    if (err.logs) console.error(chalk.gray("On-chain logs:"), err.logs);
    res.status(500).json({ error: err.message });
  }
});

// ==================== SEPARATE FUNCTIONS ====================

/**
 * Validate user has sufficient balances for the swap
 */
async function validateUserBalances(
  connection: Connection,
  fromPubkey: PublicKey,
  fromMintPublicKey: PublicKey,
  inAmount: string,
  outputMint: PublicKey
): Promise<void> {
  console.log("💰 Validating user balances...");

  // === 1. Input check ===
  if (fromMintPublicKey.equals(NATIVE_MINT)) {
    // Input = SOL → check lamports
    const solBalance = await connection.getBalance(fromPubkey);
    console.log(`   SOL balance: ${solBalance}, Required: ${inAmount}`);
    if (solBalance < Number(inAmount)) {
      throw new Error(
        `Insufficient SOL balance. Required: ${inAmount}, Available: ${solBalance}`
      );
    }
  } else {
    // Input = SPL token
    const userInputATA = await getAssociatedTokenAddress(fromMintPublicKey, fromPubkey);
    try {
      const tokenAccountInfo = await getAccount(connection, userInputATA);
      const userTokenBalance = Number(tokenAccountInfo.amount);
      console.log(`   Input token balance: ${userTokenBalance}, Required: ${inAmount}`);

      if (userTokenBalance < Number(inAmount)) {
        throw new Error(
          `Insufficient token balance. Required: ${inAmount}, Available: ${userTokenBalance}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Account does not exist")) {
        throw new Error(
          `User does not have token account for input mint: ${fromMintPublicKey.toBase58()}`
        );
      }
      throw error;
    }
  }

  // === 2. Check SOL for fees ===
  const solBalance = await connection.getBalance(fromPubkey);
  const estimatedFee = 100000; // ~0.0001 SOL
  console.log(
    `   SOL balance for fees: ${solBalance / LAMPORTS_PER_SOL} SOL, Required ~${estimatedFee / LAMPORTS_PER_SOL} SOL`
  );

  if (solBalance < estimatedFee) {
    throw new Error(
      `Insufficient SOL for fees. Required: ~${estimatedFee} lamports, Available: ${solBalance}`
    );
  }
}

/**
 * Load UOG program and parse DFLOW transaction
 */
async function loadProgramAndParseTransaction(
  connection: Connection,
  openTransaction: string,
  fromPubkey: PublicKey
): Promise<{ programUog: anchor.Program; aggIx: TransactionInstruction; metas: any[]; ixData: Buffer }> {
  const provider = new anchor.AnchorProvider(connection, {} as any, {
    preflightCommitment: "confirmed",
  });

  // Load UOG marketplace IDL
  const idlUog = require("../../public/idl/universe_of_gamers.json");
  const programUog = new anchor.Program(
    idlUog,
    new PublicKey(process.env.PROGRAM_ID as string),
    provider
  );

  // Parse DFLOW transaction
  const tx = Transaction.from(Buffer.from(openTransaction, "base64"));

  // Find DFLOW instruction
  const ixIndex = tx.instructions.findIndex(
    (ix) => ix.programId.toBase58().startsWith("DF1o")
  );
  if (ixIndex < 0) throw new Error("❌ DFLOW instruction not found in tx");

  const aggIx = tx.instructions[ixIndex];
  const metas = [
    ...aggIx.keys,   // aggregator accounts
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const ixData = aggIx.data;

  return { programUog, aggIx, metas, ixData };
}

/**
 * Get program derived addresses
 */
async function getProgramDerivedAddresses(
  programUog: anchor.Program
): Promise<[PublicKey, PublicKey]> {
  const [marketConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_config")],
    programUog.programId
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    programUog.programId
  );

  return [marketConfigPda, treasuryPda];
}

/**
 * Prepare token accounts and instructions for the swap
 */
async function prepareTokenAccountsAndInstructions(
  connection: Connection,
  fromPubkey: PublicKey,
  fromMint: PublicKey,
  inAmount: string,
  outputMint: PublicKey,
  treasuryPda: PublicKey,
  programUog: anchor.Program,
  marketConfigPda: PublicKey,
  outAmount: string
): Promise<{
  userInTokenAccount: PublicKey;
  userOutTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  preInstructions: TransactionInstruction[];
  extraPostInstructions: TransactionInstruction[];
}> {
  let userInTokenAccount: PublicKey;
  let userOutTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;
  const preInstructions: TransactionInstruction[] = [];
  const extraPostInstructions: TransactionInstruction[] = [];

  // === Input handling ===
  if (fromMint.equals(NATIVE_MINT)) {
    // Input = SOL → wrap ke WSOL ATA
    userInTokenAccount = await prepareWSOLInputAccount(
      connection,
      fromPubkey,
      inAmount,
      preInstructions
    );
  } else {
    // Input = SPL token
    userInTokenAccount = await getAssociatedTokenAddress(fromMint, fromPubkey);
  }

  // === Output handling ===
  if (outputMint.equals(NATIVE_MINT)) {
    // ✅ Output = native SOL → userOut pakai WSOL ATA
    userOutTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, treasuryPda, true);

    console.log("⚡ Output is native SOL (handled via WSOL ATA)");
    console.log("   User WSOL ATA     :", userOutTokenAccount.toBase58());
    console.log("   Treasury WSOL ATA :", treasuryTokenAccount.toBase58());

    // === Create ATA kalau belum ada ===
    const userOutInfo = await connection.getAccountInfo(userOutTokenAccount);
    if (!userOutInfo) {
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          userOutTokenAccount,
          fromPubkey,
          WSOL_MINT
        )
      );
      preInstructions.push(createSyncNativeInstruction(userOutTokenAccount));
    }

    const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
    if (!treasuryInfo) {
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          treasuryTokenAccount,
          treasuryPda,
          WSOL_MINT
        )
      );
      preInstructions.push(createSyncNativeInstruction(treasuryTokenAccount));
    }

    // === Hitung fee + approve untuk SOL case ===
    const marketConfig: any = await programUog.account.marketConfig.fetch(marketConfigPda);
    const tradeFeeBps: number = marketConfig.tradeFeeBps ?? marketConfig.trade_fee_bps;
    const outAmountRaw = BigInt(outAmount);
    const trade_fee = (outAmountRaw * BigInt(tradeFeeBps)) / BigInt(10_000);

    console.log("💸 Approving delegate for trade_fee (SOL):", trade_fee.toString());

    preInstructions.push(
      createApproveInstruction(
        userOutTokenAccount,  // source ATA (WSOL user)
        treasuryPda,          // delegate = treasury PDA
        fromPubkey,           // owner = user wallet
        Number(trade_fee)     // jumlah fee
      )
    );

    console.log("✅ Approve instruction pushed (SOL case)");
    console.log("   userOutTokenAccount (source):", userOutTokenAccount.toBase58());
    console.log("   treasuryTokenAccount (destination):", treasuryTokenAccount.toBase58());
    console.log("   delegate (treasuryPda):", treasuryPda.toBase58());
    console.log("   owner (fromPubkey):", fromPubkey.toBase58());
    console.log("   trade_fee (lamports):", trade_fee.toString());

    // === Setelah swap selesai → unwrap WSOL kembali ke SOL ===
    extraPostInstructions.push(
      createCloseAccountInstruction(
        userOutTokenAccount,
        fromPubkey, // SOL kembali ke wallet user
        fromPubkey
      )
    );
  } else {
    // ✅ Output = SPL biasa
    const result = await prepareSPLOutputAccounts(
      connection,
      fromPubkey,
      outputMint,
      treasuryPda,
      preInstructions
    );

    userOutTokenAccount = result.userOutTokenAccount;
    treasuryTokenAccount = result.treasuryTokenAccount;
    preInstructions.push(...result.preInstructions);

    // Hitung fee SPL
    const marketConfig: any = await programUog.account.marketConfig.fetch(marketConfigPda);
    const tradeFeeBps: number = marketConfig.tradeFeeBps ?? marketConfig.trade_fee_bps;
    const outAmountRaw = BigInt(outAmount);
    const trade_fee = (outAmountRaw * BigInt(tradeFeeBps)) / BigInt(10_000);

    console.log("   Estimated trade fee (SPL):", trade_fee.toString());

    preInstructions.push(
      createApproveInstruction(
        userOutTokenAccount,  // source ATA (SPL user)
        treasuryPda,          // delegate = treasury PDA
        fromPubkey,           // owner = user wallet
        Number(trade_fee)     // jumlah fee
      )
    );

    console.log("✅ Approve instruction pushed (SPL case)");
    console.log("   userOutTokenAccount (source):", userOutTokenAccount.toBase58());
    console.log("   treasuryTokenAccount (destination):", treasuryTokenAccount.toBase58());
    console.log("   delegate (treasuryPda):", treasuryPda.toBase58());
    console.log("   owner (fromPubkey):", fromPubkey.toBase58());
    console.log("   trade_fee (lamports):", trade_fee.toString());
  }

  return { userInTokenAccount, userOutTokenAccount, treasuryTokenAccount, preInstructions, extraPostInstructions };
}


/**
 * Prepare accounts for SOL output (WSOL handling)
 */
async function prepareSOLOutputAccounts(
  connection: Connection,
  fromPubkey: PublicKey,
  treasuryPda: PublicKey,
  preInstructions: TransactionInstruction[],
  extraPostInstructions: TransactionInstruction[]
): Promise<{
  userOutTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  preInstructions: TransactionInstruction[];
  extraPostInstructions: TransactionInstruction[];
}> {
  // Output is SOL → treat as WSOL (wrapped SOL)
  const userOutTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);
  const treasuryTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, treasuryPda, true);

  console.log("⚡ Output is SOL → pakai WSOL ATA");
  console.log("   User WSOL ATA     :", userOutTokenAccount.toBase58());
  console.log("   Treasury WSOL ATA :", treasuryTokenAccount.toBase58());

  // Create ATA kalau belum ada
  const userOutInfo = await connection.getAccountInfo(userOutTokenAccount);
  if (!userOutInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        userOutTokenAccount,
        fromPubkey,
        WSOL_MINT
      )
    );
    preInstructions.push(createSyncNativeInstruction(userOutTokenAccount));
  }

  const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        treasuryTokenAccount,
        treasuryPda,
        WSOL_MINT
      )
    );
    preInstructions.push(createSyncNativeInstruction(treasuryTokenAccount));
  }

  // ✅ Setelah swap selesai → unwrap WSOL jadi native SOL ke wallet
  extraPostInstructions.push(
    createCloseAccountInstruction(
      userOutTokenAccount,
      fromPubkey,      // SOL kembali ke wallet
      fromPubkey
    )
  );

  return { userOutTokenAccount, treasuryTokenAccount, preInstructions, extraPostInstructions };
}


/**
 * Prepare accounts for SPL token output
 */
async function prepareSPLOutputAccounts(
  connection: Connection,
  fromPubkey: PublicKey,
  outputMint: PublicKey,
  treasuryPda: PublicKey,
  preInstructions: TransactionInstruction[]
): Promise<{
  userOutTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  preInstructions: TransactionInstruction[];
}> {
  let userOutTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  if (outputMint.equals(WSOL_MINT)) {
    // ✅ Kalau output = SOL → userOut harus ATA WSOL, bukan pubkey langsung
    userOutTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, treasuryPda, true);

    console.log("⚡ Output is SOL → pakai WSOL ATA");
    console.log("   User WSOL ATA :", userOutTokenAccount.toBase58());
    console.log("   Treasury WSOL ATA:", treasuryTokenAccount.toBase58());
  } else {
    // ✅ Output = SPL biasa
    userOutTokenAccount = await getAssociatedTokenAddress(outputMint, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(outputMint, treasuryPda, true);

    console.log("⚡ Output is SPL → pakai Treasury ATA SPL");
    console.log("   SPL mint      :", outputMint.toBase58());
    console.log("   Treasury ATA  :", treasuryTokenAccount.toBase58());
  }

  // === Create ATA kalau belum ada ===
  const userOutInfo = await connection.getAccountInfo(userOutTokenAccount);
  if (!userOutInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        userOutTokenAccount,
        fromPubkey,
        outputMint
      )
    );
    if (outputMint.equals(WSOL_MINT)) {
      preInstructions.push(createSyncNativeInstruction(userOutTokenAccount));
    }
  }

  const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        treasuryTokenAccount,
        treasuryPda,
        outputMint
      )
    );
    if (outputMint.equals(WSOL_MINT)) {
      preInstructions.push(createSyncNativeInstruction(treasuryTokenAccount));
    }
  }

  return { userOutTokenAccount, treasuryTokenAccount, preInstructions };
}

async function prepareWSOLInputAccount(
  connection: Connection,
  fromPubkey: PublicKey,
  inAmount: string,
  preInstructions: TransactionInstruction[]
): Promise<PublicKey> {
  const userWSOLATA = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);

  const ataInfo = await connection.getAccountInfo(userWSOLATA);
  if (!ataInfo) {
    // Buat ATA WSOL
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        userWSOLATA,
        fromPubkey,
        WSOL_MINT
      )
    );
  }

  // Hitung rent-exempt minimum
  const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(165); // size token account
  const solBalance = await connection.getBalance(fromPubkey);

  const required = Number(inAmount) + rentExemptLamports + 100000; // +fee buffer
  if (solBalance < required) {
    throw new Error(
      `Not enough SOL. Required ${required}, available ${solBalance}`
    );
  }

  // Transfer hanya inAmount (bukan +rentExempt, karena rentExempt sudah otomatis di ATA saat dibuat)
  preInstructions.push(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: userWSOLATA,
      lamports: Number(inAmount),
    })
  );

  preInstructions.push(createSyncNativeInstruction(userWSOLATA));

  console.log("⚡ Input is SOL → wrap jadi WSOL ATA:", userWSOLATA.toBase58());
  return userWSOLATA;
}

/**
 * Build the main swap instruction
 */
async function buildSwapInstruction(
  programUog: anchor.Program,
  ixData: Buffer,
  fromPubkey: PublicKey,
  dexProgram: PublicKey,
  marketConfigPda: PublicKey,
  treasuryPda: PublicKey,
  outputMint: PublicKey,
  treasuryTokenAccount: PublicKey,
  userOutTokenAccount: PublicKey,
  metas: any[],
  inAmount: string
): Promise<TransactionInstruction> {
  const compactMetas = metas.filter(
    m => ![
      TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
      fromPubkey.toBase58()
    ].includes(m.pubkey.toBase58())
  );

  return await programUog.methods
    .swapToken(ixData, new anchor.BN(inAmount))
    .accounts({
      user: fromPubkey,
      dexProgram,
      marketConfig: marketConfigPda,
      treasuryPda,
      outputMint,
      treasuryTokenAccount,   // kalau SOL → treasuryPda
      userOutTokenAccount,    // kalau SOL → fromPubkey
    })
    .remainingAccounts(compactMetas)
    .instruction();
}

/**
 * Build and finalize the transaction
 */
async function buildFinalTransaction(
  connection: Connection,
  fromPubkey: PublicKey,
  preInstructions: TransactionInstruction[],
  ix: TransactionInstruction,
  extraPostInstructions: TransactionInstruction[],
  userInTokenAccount: PublicKey,
  userOutTokenAccount: PublicKey,
  treasuryTokenAccount: PublicKey,
  treasuryPda: PublicKey
): Promise<Transaction> {
  // Compute budget + priority fee
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

  // Debug account ownership
  await logAccountOwner(connection, "UserInTokenAccount", userInTokenAccount);
  await logAccountOwner(connection, "User ATA", userOutTokenAccount);
  await logAccountOwner(connection, "Treasury ATA", treasuryTokenAccount);
  await logAccountOwner(connection, "Treasury PDA", treasuryPda);
  await logAccountOwner(connection, "From wallet", fromPubkey);

  // Build final transaction
  const txOut = new Transaction().add(
    modifyComputeUnits,
    addPriorityFee,
    ...preInstructions,
    ix,
    ...extraPostInstructions
  );

  txOut.feePayer = fromPubkey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.log("   Blockhash:", blockhash, "LastValidBlockHeight:", lastValidBlockHeight);
  txOut.recentBlockhash = blockhash;

  return txOut;
}

const DFLOW_PROGRAM_ID = new PublicKey("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
const EVENT_AUTHORITY = new PublicKey("8xeaWCsJYxRoudEZGJWURdfrtFhLYZz9b4iHJnW5tb3d");
const SWAP2_DISCRIMINATOR = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);

export async function buildDFlowSwap2Instruction(
  userAuthority: PublicKey,
  fromMint: PublicKey,
  toMint: PublicKey,
  inAmount: bigint,
  outAmount: bigint,
  baseMetas: AccountMeta[]
) {
  /**
   * Encoding sesuai IDL:
   * actions: Vec<Action> → kosong (u32 length = 0)
   * quoted_out_amount: u64 → dari outAmount
   * slippage_bps: u16 → misal 50
   * platform_fee_bps: u16 → misal 0
   * positive_slippage_fee_limit_pct: u8 → misal 1
   */
  const slippage_bps = 300;
  const platform_fee_bps = 0;
  const positive_slippage_fee_limit_pct = 1;

  const data = Buffer.concat([
    Buffer.from(SWAP2_DISCRIMINATOR), // 8 bytes
    Buffer.from(new Uint32Array([0]).buffer), // Vec<Action> kosong
    Buffer.from(new BN(outAmount).toArray("le", 8)), // quoted_out_amount
    Buffer.from(new Uint16Array([slippage_bps]).buffer),
    Buffer.from(new Uint16Array([platform_fee_bps]).buffer),
    Buffer.from(new Uint8Array([positive_slippage_fee_limit_pct])),
  ]);

  const keys: AccountMeta[] = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: userAuthority, isSigner: true, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: DFLOW_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: DFLOW_PROGRAM_ID,
    keys,
    data,
  });
}

export async function buildRaydiumCpmmswapInstruction({
  userAuthority,
  poolId,           // ✅ sudah konsisten
  ammConfig,
  inputMint,
  outputMint,
  amountIn,
  minOut,
}: {
  userAuthority: PublicKey;
  poolId: PublicKey; // ✅ sesuai
  ammConfig: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  minOut: bigint;
}): Promise<TransactionInstruction> {
  const RAYDIUM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

  // === discriminator from IDL ===
  const SWAP_BASE_INPUT_DISCRIMINATOR = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

  // === encode args ===
  const data = Buffer.concat([
    SWAP_BASE_INPUT_DISCRIMINATOR,
    Buffer.from(new BN(amountIn).toArray("le", 8)),
    Buffer.from(new BN(minOut).toArray("le", 8)),
  ]);

  // === derive required PDAs ===
  const [inputATA] = await PublicKey.findProgramAddress(
    [userAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), inputMint.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );
  const [outputATA] = await PublicKey.findProgramAddress(
    [userAuthority.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), outputMint.toBuffer()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
  );
  const [inputVault] = await PublicKey.findProgramAddress(
    [Buffer.from("pool_vault"), poolId.toBuffer(), inputMint.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );
  const [outputVault] = await PublicKey.findProgramAddress(
    [Buffer.from("pool_vault"), poolId.toBuffer(), outputMint.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );
  const [authority] = await PublicKey.findProgramAddress(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    RAYDIUM_PROGRAM_ID
  );
  const [observationState] = await PublicKey.findProgramAddress(
    [Buffer.from("observation"), poolId.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );

  // === accounts layout from IDL ===
  const keys: AccountMeta[] = [
    { pubkey: userAuthority, isSigner: true, isWritable: true }, // payer
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: inputATA, isSigner: false, isWritable: true },
    { pubkey: outputATA, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // input_token_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // output_token_program
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: observationState, isSigner: false, isWritable: true },
  ];

  return new TransactionInstruction({
    programId: RAYDIUM_PROGRAM_ID,
    keys,
    data,
  });
}

// GET /wallet/:address?mint=<mintAddress>
router.get("/trades/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const { mint } = req.query;

    if (!address) return res.status(400).json({ error: "Missing wallet address" });
    if (!mint) return res.status(400).json({ error: "Missing token mint" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    console.log(chalk.blue("🔗 RPC Endpoint:"), process.env.SOLANA_CLUSTER);

    const walletPk = new PublicKey(address);
    const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 100 });

    const limit = pLimit(5);
    const trades: any[] = [];

    await Promise.all(
      sigs.map((sig) =>
        limit(async () => {
          try {
            const tx = await connection.getTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta?.logMessages) return;

            const accountKeys = tx.transaction.message
              .getAccountKeys()
              .staticAccountKeys.map((k) => k.toBase58());

            // hanya ambil transaksi yang melibatkan mint
            if (!accountKeys.includes(mint as string)) return;

            const walletIndex = accountKeys.indexOf(address);
            let amount_from = null;
            let amount_to = null;
            if (walletIndex >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
              const diff =
                (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) /
                anchor.web3.LAMPORTS_PER_SOL;
              if (diff < 0) amount_from = Math.abs(diff);
              if (diff > 0) amount_to = diff;
            }

            const logs = tx.meta.logMessages;
            const hasMintAndList = logs.some((l) => l.includes("Instruction: MintAndList"));
            const hasBuyNft = logs.some((l) => l.includes("Instruction: BuyNft"));
            const eventType = hasMintAndList ? "MintAndList" : hasBuyNft ? "BuyNft" : "Unknown";

            // === 🎯 Format ulang sesuai template Angular ===
            trades.push({
              signature: sig.signature,
              slot: sig.slot,
              blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
              eventType,
              program: "UOG Smart Contract",
              from: amount_from
                ? {
                    amount: amount_from,
                    token: {
                      symbol: "SOL",
                      image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
                      address: "So11111111111111111111111111111111111111112",
                    },
                  }
                : null,
              to: amount_to
                ? {
                    amount: amount_to,
                    token: {
                      symbol: "SOL",
                      image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
                      address: "So11111111111111111111111111111111111111112",
                    },
                  }
                : null,
            });
          } catch (err: any) {
            console.warn(`⚠️ Skip TX ${sig.signature}: ${err.message}`);
          }
        })
      )
    );

    console.log(`✅ Filtered ${trades.length} trades for mint ${mint}`);

    res.json({
      trades,
      total: trades.length,
      wallet: address,
      mint,
    });
  } catch (err: any) {
    console.error("❌ Error fetching wallet trades:", err);
    res.status(500).json({ error: err.message });
  }
});

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
