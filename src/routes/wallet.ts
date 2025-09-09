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
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getTokenInfo } from "../services/priceService";
import { getMint } from "@solana/spl-token";

import WalletBalance from "../models/WalletBalance";
import WalletToken from "../models/WalletToken";
import TrendingToken from "../models/TrendingToken";
import { Nft } from "../models/Nft";
const fs = require("fs");
import { Client } from "@solana-tracker/data-api";

dotenv.config();
const router = Router();

const solanaTracker = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY as string });

const SOL_MINT = "So11111111111111111111111111111111111111112";
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
    decimals: 9,
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
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const DUMMY = "11111111111111111111111111111111";

const makeAcc = (pubkey: string | null, isSigner = false, isWritable = false) =>
  pubkey
    ? { pubkey, isSigner, isWritable }
    : { pubkey: DUMMY, isSigner: false, isWritable: false };

export async function buildOrderedAccounts(
  connection: Connection,
  user: PublicKey,
  fromMint: PublicKey,
  toMint: PublicKey,
) {
  const userPk = new PublicKey(user);

  // ✅ resolve ATA WSOL & UOG
  const wsolATA = await getAssociatedTokenAddress(new PublicKey(fromMint), userPk, false, TOKEN_PROGRAM_ID);
  const uogATA  = await getAssociatedTokenAddress(new PublicKey(toMint), userPk, false, TOKEN_PROGRAM_ID);

  // Cari PDA programAuthority Jupiter
  const [programAuthority] = await PublicKey.findProgramAddress(
    [Buffer.from("authority")],
    new PublicKey(JUPITER_PROGRAM)
  );
  console.log("🔑 Jupiter programAuthority PDA:", programAuthority.toBase58());

  // Resolve ATA untuk WSOL dan UOG (punya programAuthority)
  const wsolATA_program = await getAssociatedTokenAddress(
    new PublicKey("So11111111111111111111111111111111111111112"),
    programAuthority,
    true,
    TOKEN_PROGRAM_ID
  );

  const uogATA_program = await getAssociatedTokenAddress(
    new PublicKey("B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk"),
    programAuthority,
    true,
    TOKEN_PROGRAM_ID
  );

  console.log("🔎 ProgramAuthority WSOL ATA:", wsolATA_program.toBase58());
  console.log("🔎 ProgramAuthority UOG  ATA:", uogATA_program.toBase58());

  // convert ke string
  const wsolATAstr = wsolATA.toBase58();
  const uogATAstr = uogATA.toBase58();

  const ordered = [
    makeAcc(TOKEN_PROGRAM_ID.toBase58()),       // [0] token_program
    makeAcc(JUPITER_PROGRAM),                   // [1] program_authority
    makeAcc(user.toBase58(), true, true),       // [2] user_transfer_authority
    makeAcc(wsolATA.toBase58(), false, true),   // [3] source_token_account
    makeAcc(wsolATA_program.toBase58(), false, true),   // [4] program_source_token_account
    makeAcc(uogATA_program.toBase58(), false, true),    // [5] program_destination_token_account
    makeAcc(uogATA.toBase58(), false, true),    // [6] destination_token_account
    makeAcc(fromMint.toBase58()),               // [7] source_mint
    makeAcc(toMint.toBase58()),                 // [8] destination_mint
    makeAcc(null, false, true),                 // [9] platform_fee_account
    makeAcc(null),                              // [10] token_2022_program
    makeAcc(EVENT_AUTHORITY),                   // [11] event_authority
    makeAcc(JUPITER_PROGRAM),                   // [12] program
  ];

  // 🔍 Debug output
  const labels = [
    "token_program",
    "program_authority",
    "user_transfer_authority",
    "source_token_account",
    "program_source_token_account",
    "program_destination_token_account",
    "destination_token_account",
    "source_mint",
    "destination_mint",
    "platform_fee_account",
    "token_2022_program",
    "event_authority",
    "program",
  ];

  console.log("🔎 OrderedAccounts (auto resolved ATA):");
  ordered.forEach((acc, i) => {
    console.log(
      `[${i}] ${labels[i]} ${acc.pubkey} (signer=${acc.isSigner}, writable=${acc.isWritable})`
    );
  });

  return ordered;
}

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

      result.push({
        mint,
        name: REGISTRY[mint]?.name ?? info?.name ?? "",
        symbol: REGISTRY[mint]?.symbol ?? info?.symbol ?? "",
        logoURI: REGISTRY[mint]?.logoURI ?? info?.logoURI ?? "",
        decimals: REGISTRY[mint]?.decimals ?? info?.decimals ?? 0,
        amount: 0, // wallet kosong
        priceUsd: parseFloat(priceUsd.toFixed(6)),
        usdValue: 0,
        liquidity: parseFloat(liquidity.toFixed(2)),
        marketCap: parseFloat(marketCap.toFixed(2)),
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
        holders: info?.holders ?? 0,
      });
    } catch (err: any) {
      console.warn(`⚠️ gagal ambil info token ${mint}:`, err.message);
    }
  }

  return result;
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
          await new Promise((r) => setTimeout(r, 1000 * attempt)); // backoff
        }
      }
    }

    if (!wallet?.tokens?.length) {
      const defaultTokens = await getDefaultTokens();

      if (defaultTokens.length) {
        await Promise.all(
          defaultTokens.map((t) =>
            WalletToken.findOneAndUpdate(
              { address, mint: t.mint },
              { ...t, address, lastUpdated: new Date() },
              { upsert: true, new: true }
            )
          )
        );
      }

      return res.json({
        address,
        tokens: defaultTokens,
        total: defaultTokens.reduce((sum, t) => sum + t.usdValue, 0),
        totalSol:
          defaultTokens.find((t) => t.mint === SOL_MINT)?.amount ?? 0,
      });
    }

    const tokens = wallet.tokens.map((t: any) => {
      const priceUsd = t.pools?.[0]?.price?.usd ?? 0;
      const liquidity = t.pools?.[0]?.liquidity?.usd ?? 0;
      const marketCap = t.pools?.[0]?.marketCap?.usd ?? 0;
      const percentChange = t.events?.["24h"]?.priceChangePercentage ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      return {
        mint:
          t.token.symbol === "SOL"
            ? "So11111111111111111111111111111111111111112"
            : t.token.mint,
        name: t.token.name,
        symbol: t.token.symbol,
        logoURI: t.token.image,
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

    await Promise.all(
      tokens.map(async (t: any) => {
        await WalletToken.findOneAndUpdate(
          { address, mint: t.mint },
          { ...t, address, lastUpdated: new Date() },
          { upsert: true, new: true }
        );
      })
    );

    res.json({
      address,
      tokens,
      total: wallet.total ?? 0,
      totalSol: wallet.totalSol ?? 0,
    });
  } catch (err: any) {
    console.error("❌ Error fetching wallet:", err);
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

    res.json({
      tokens,
      total: tokens.length,
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
      return res.status(400).json({ error: "from, to, amount, and mint are required" });
    }

    console.log("📩 [BUILD TX] Request received");
    console.log("   🔑 From :", from);
    console.log("   🎯 To   :", to);
    console.log("   💰 Amount (UI):", amount);
    console.log("   🪙 Mint :", mint);

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const fromPubkey = new PublicKey(from);
    const toPubkey = new PublicKey(to);

    let ix;
    if (mint === "So11111111111111111111111111111111111111112") {
      // === Native SOL transfer ===
      console.log("⚡ Native SOL transfer detected");
      const lamports = Math.floor(amount * 1e9);
      console.log("   💰 Amount raw (lamports):", lamports);

      ix = SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports,
      });
    } else {
      // === SPL Token transfer ===
      console.log("🔄 SPL Token transfer detected");

      const mintPubkey = new PublicKey(mint);

      // Ambil info mint → decimals
      const mintInfo = await getMint(connection, mintPubkey);
      console.log("   🔢 Decimals for mint:", mintInfo.decimals);

      // Hitung raw amount
      const rawAmount = BigInt(Math.floor(amount * 10 ** mintInfo.decimals));
      console.log("   💰 Amount raw (with decimals):", rawAmount.toString());

      // Resolve ATA
      const fromTokenAccount = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
      const toTokenAccount   = await getAssociatedTokenAddress(mintPubkey, toPubkey);

      console.log("   📦 FromTokenAccount:", fromTokenAccount.toBase58());
      console.log("   📦 ToTokenAccount  :", toTokenAccount.toBase58());

      // Cek ATA penerima
      const toAccountInfo = await connection.getAccountInfo(toTokenAccount);
      console.log("   🗂️ To ATA exists? :", !!toAccountInfo);

      // Cek balance sender & receiver
      const fromBalance = await connection.getTokenAccountBalance(fromTokenAccount).catch(() => null);
      const toBalance = await connection.getTokenAccountBalance(toTokenAccount).catch(() => null);
      console.log("   📊 Sender balance before:", fromBalance?.value.uiAmountString ?? "N/A");
      console.log("   📊 Recipient balance before:", toBalance?.value.uiAmountString ?? "0");

      const instructions = [];

      if (!toAccountInfo) {
        console.log("   ➕ Creating ATA for recipient");
        instructions.push(
          createAssociatedTokenAccountInstruction(
            fromPubkey,
            toTokenAccount,
            toPubkey,
            mintPubkey
          )
        );
      }

      instructions.push(
        createTransferInstruction(
          fromTokenAccount,
          toTokenAccount,
          fromPubkey,
          rawAmount
        )
      );

      ix = instructions;
    }

    const tx = new Transaction().add(...(Array.isArray(ix) ? ix : [ix]));
    tx.feePayer = fromPubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log("✅ Transaction built successfully");
    console.log("   FeePayer:", tx.feePayer.toBase58());
    console.log("   Instructions count:", tx.instructions.length);

    // Balikin unsigned tx
    const serialized = tx.serialize({ requireAllSignatures: false });
    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error("❌ build sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/send/submit
//
router.post("/send/submit", async (req: Request, res: Response) => {
  try {
    const { signedTx } = req.body;
    if (!signedTx) {
      return res.status(400).json({ error: "signedTx is required" });
    }

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");
    const signature = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(signature, "confirmed");
    res.json({ signature });
  } catch (err: any) {
    console.error("❌ submit sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/quote
//
router.post("/swap/quote", async (req: Request, res: Response) => {
  try {
    const { from, fromMint, toMint, amount } = req.body;
    if (!from || !fromMint || !toMint || !amount) {
      return res.status(400).json({ error: "from, fromMint, toMint, amount required" });
    }

    console.log("📩 [SWAP QUOTE] Request received");
    console.log("   🔑 From    :", from);
    console.log("   🪙 FromMint:", fromMint);
    console.log("   🪙 ToMint  :", toMint);
    console.log("   💰 Amount (UI):", amount);

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

    // === cek decimals dari mint ===
    let decimals = 9; // default SOL
    if (fromMint !== SOL_MINT) {
      const mintInfo = await getMint(connection, new PublicKey(fromMint));
      decimals = mintInfo.decimals;
    }
    console.log("   🔢 Decimals for input mint:", decimals);

    // konversi ke raw integer (lamports/token units)
    const rawAmount = BigInt(Math.floor(amount * 10 ** decimals));
    console.log("   💰 Amount raw:", rawAmount.toString());

    // request quote ke DFLOW
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

    console.log("✅ Quote received");
    console.log("   InAmount   :", quote.inAmount);
    console.log("   OutAmount  :", quote.outAmount);
    console.log("   MinOutAmt  :", quote.minOutAmount);

    res.json({
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOutAmount: quote.minOutAmount,
      openTransaction: quote.openTransaction,
    });
  } catch (err: any) {
    console.error("❌ swap/quote error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/build
//
router.post("/swap/build", async (req: Request, res: Response) => {
  try {
    const { from, openTransaction } = req.body;
    if (!from || !openTransaction) {
      return res.status(400).json({ error: "from, openTransaction required" });
    }

    console.log("📩 [SWAP BUILD] Request received");
    console.log("   🔑 From:", from);

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const fromPubkey = new PublicKey(from);
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });

    // load UOG marketplace IDL
    const idlUog = require("../../public/idl/uog_marketplace.json");
    const programUog = new anchor.Program(
      idlUog,
      new PublicKey(process.env.PROGRAM_ID as string),
      provider
    );

    // parse DFLOW tx
    const tx = Transaction.from(Buffer.from(openTransaction, "base64"));

    // cari instruksi DFLOW
    const ixIndex = tx.instructions.findIndex(
      (ix) => ix.programId.toBase58().startsWith("DF1o") // fleksibel
    );
    if (ixIndex < 0) throw new Error("❌ DFLOW instruction not found in tx");

    const aggIx = tx.instructions[ixIndex];
    const metas = aggIx.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));
    const ixData = aggIx.data;

    console.log("   🔗 Aggregator program:", aggIx.programId.toBase58());
    console.log("   📦 Remaining accounts:", metas.length);

    // derive PDA untuk UOG
    const [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      programUog.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      programUog.programId
    );

    // build ix untuk UOG program
    const ix = await programUog.methods
      .swapToken(ixData, new anchor.BN(0)) // amount opsional
      .accounts({
        user: fromPubkey,
        dexProgram: aggIx.programId,
        marketConfig: marketConfigPda,
        treasuryPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(metas)
      .instruction();

    // compute budget + priority fee
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

    const txOut = new Transaction().add(modifyComputeUnits, addPriorityFee, ix);
    txOut.feePayer = fromPubkey;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    txOut.recentBlockhash = blockhash;

    console.log("✅ Swap TX built");
    console.log("   FeePayer:", txOut.feePayer.toBase58());
    console.log("   Blockhash:", blockhash, " valid until height:", lastValidBlockHeight);
    console.log("   Instructions count:", txOut.instructions.length);

    const serialized = txOut.serialize({ requireAllSignatures: false });
    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error("❌ swap/build error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/submit
//
router.post("/swap/submit", async (req: Request, res: Response) => {
  try {
    const { signedTx } = req.body;
    if (!signedTx) return res.status(400).json({ error: "signedTx required" });

    console.log("📩 [SWAP SUBMIT] Request received");

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");

    const sig = await connection.sendRawTransaction(txBuffer, {
      skipPreflight: false,
      maxRetries: 5,
    });

    console.log("⏳ Waiting for confirmation...");
    const confirmation = await connection.confirmTransaction(sig, "confirmed");

    console.log("✅ Swap TX confirmed:", sig);

    res.json({
      signature: sig,
      confirmation,
      explorer: `https://solscan.io/tx/${sig}?cluster=mainnet`,
    });
  } catch (err: any) {
    console.error("❌ swap/submit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /wallet/:address?mint=<mintAddress>
router.get('/trades/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const { mint } = req.query;

    if (!address) return res.status(400).json({ error: "Missing wallet address" });
    if (!mint) return res.status(400).json({ error: "Missing token mint" });

    // ✅ ambil semua trades wallet
    const walletTrades = await solanaTracker.getWalletTrades(address, undefined, true, true, false);

    if (!walletTrades || !walletTrades.trades) {
      return res.json({ trades: [] });
    }

    // ✅ filter trades yang ada mint sesuai request
    const filtered = walletTrades.trades.filter((t: any) =>
      t.from.address === mint || t.to.address === mint
    );

    res.json({
      trades: filtered,
      total: filtered.length,
      mint,
      wallet: address
    });
  } catch (err: any) {
    console.error('❌ Error fetching wallet trades:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
