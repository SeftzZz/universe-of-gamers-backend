import fetch from "node-fetch";

import { broadcast } from "../index";
import WalletToken from "../models/WalletToken";
import prizePoolRoutes from "../routes/prizepool";
import Redis from "ioredis";
import { Client } from "@solana-tracker/data-api";
import { Connection, PublicKey } from "@solana/web3.js";

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// === Konfigurasi ===
const POLL_INTERVAL = 1 * 60 * 1000; // 1 menit
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_KEY}`;
const solanaTracker = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY as string });
const connection = new Connection(HELIUS_RPC, "confirmed");

// 🔹 Struktur token hasil RPC
interface TokenBalance {
  mint: string;
  amount: number;
  decimals: number;
  name?: string;
  symbol?: string;
  logoURI?: string;
  usdValue?: number;
}

interface TokenInfo {
  symbol: string;
  name: string;
  image: string;
  address: string;
}

const tokenMap: Record<string, TokenInfo> = {
  "So11111111111111111111111111111111111111112": {
    symbol: "WSOL",
    name: "Wrap SOL",
    image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    address: "So11111111111111111111111111111111111111112",
  },
  "So11111111111111111111111111111111111111111": {
    symbol: "SOL",
    name: "Native SOL",
    image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    address: "So11111111111111111111111111111111111111111",
  },
  "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk": {
    symbol: "UOG",
    name: "Universe Of Gamers",
    image: "https://api.universeofgamers.io/uploads/app-logo.jpeg",
    address: "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk",
  },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D": {
    symbol: "BONK",
    name: "BONK",
    image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D/logo.png",
    address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xqvd8Y3bDbxYx7D",
  },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    symbol: "USDC",
    name: "USDC",
    image: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
};

// Fungsi bantu untuk hapus cache wallet
async function invalidateWalletCache(address: string) {
  try {
    const keys = [
      `tokens:${address}`,
      `balance:${address}`,
      `wallet:${address}`,
    ];
    await Promise.all(keys.map((k) => redis.del(k)));
    console.log(`🧹 [Cache] Invalidated for wallet ${address}`);
  } catch (err: any) {
    console.error(`❌ [Cache] Failed to invalidate ${address}:`, err.message);
  }
}

// === Ambil saldo SOL + token SPL untuk 1 wallet ===
async function getWalletBalance(address: string): Promise<{
  address: string;
  sol: number;
  tokens: TokenBalance[];
}> {
  try {
    // --- RPC 1: Balance SOL ---
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [address],
    };

    // --- RPC 2: Token SPL accounts ---
    const tokenReq = {
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" },
      ],
    };

    // Parallel fetch agar cepat
    const [solRes, tokenRes] = await Promise.all([
      fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      fetch(HELIUS_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tokenReq),
      }),
    ]);

    const solJson = await solRes.json();
    const tokenJson = await tokenRes.json();

    const sol = (solJson.result?.value ?? 0) / 1e9;
    const tokens: TokenBalance[] = [];

    // Tambahkan SOL pseudo-token
    tokens.push({
      mint: "So11111111111111111111111111111111111111112",
      amount: sol,
      decimals: 9,
      symbol: "SOL",
      name: "Solana",
      logoURI: "",
      usdValue: 0,
    });

    if (tokenJson.result?.value?.length) {
      for (const acc of tokenJson.result.value) {
        const info = acc.account.data.parsed.info;
        const amount =
          Number(info.tokenAmount.amount) / 10 ** info.tokenAmount.decimals;
        tokens.push({
          mint: info.mint,
          amount,
          decimals: info.tokenAmount.decimals,
          symbol: info.tokenAmount.symbol || "???",
          name: info.tokenAmount.name || "Unknown Token",
          logoURI: "",
          usdValue: 0,
        });
      }
    }

    // Pastikan SOL selalu ada
    await WalletToken.updateOne(
      { address, mint: "So11111111111111111111111111111111111111112" },
      {
        $set: {
          amount: sol,
          decimals: 9,
          name: "Solana",
          symbol: "SOL",
          lastUpdated: new Date(),
        },
      },
      { upsert: true }
    );

    // === LOGIC PERUBAHAN SALDO ===
    const oldRecords = await WalletToken.find({ address }).lean();
    const tolerance = 0.000001;

    // 🧮 Counter summary per wallet
    let addedCount = 0;
    let updatedCount = 0;
    let removedCount = 0;

    for (const t of tokens) {
      const existing = oldRecords.find((r) => r.mint === t.mint);

      // ⛔️ Skip saldo 0 (tidak log)
      if (t.amount === 0) {
        await WalletToken.updateOne(
          { address, mint: t.mint },
          { $set: { amount: 0, lastUpdated: new Date() } },
          { upsert: true }
        );
        continue;
      }

      if (!existing) {
        console.log(`🆕 [${address}] New token: ${t.symbol || t.mint} (${t.amount})`);
        addedCount++;
        await WalletToken.updateOne(
          { address, mint: t.mint },
          {
            $set: {
              amount: t.amount,
              decimals: t.decimals,
              name: t.name,
              symbol: t.symbol,
              lastUpdated: new Date(),
            },
          },
          { upsert: true }
        );
        continue;
      }

      const diff = Math.abs(existing.amount - t.amount);
      if (diff > tolerance) {
        const direction = t.amount > existing.amount ? "⬆️ increased" : "⬇️ decreased";
        console.log(
          `🔄 [${address}] ${t.symbol || t.mint}: ${existing.amount} → ${t.amount} (${direction} ${diff.toFixed(6)})`
        );
        updatedCount++;
        await WalletToken.updateOne(
          { address, mint: t.mint },
          { $set: { amount: t.amount, lastUpdated: new Date() } }
        );
      }
    }

    // 🔍 Token yang hilang
    for (const old of oldRecords) {
      if (
        old.symbol === "SOL" ||
        old.name === "Solana" ||
        old.mint === "So11111111111111111111111111111111111111112"
      )
        continue;

      if (old.amount === 0) continue;

      const stillExists = tokens.find((t) => t.mint === old.mint);
      if (!stillExists) {
        console.log(`❌ [${address}] Token removed: ${old.symbol || old.mint}`);
        removedCount++;
        await WalletToken.updateOne(
          { address, mint: old.mint },
          { $set: { amount: 0, lastUpdated: new Date() } }
        );
      }
    }

    // 📊 Summary per wallet
    if (addedCount > 0 || updatedCount > 0 || removedCount > 0) {
      console.log(
        `📊 [${address}] ${updatedCount} updated, ${addedCount} added, ${removedCount} removed`
      );
    }

    return { address, sol, tokens };
  } catch (err: any) {
    console.error(`❌ Error fetching balance for ${address}:`, err.message);
    return { address, sol: 0, tokens: [] };
  }
}

// Segera rebuild cache setelah invalidation
async function refreshWalletCache(address: string) {
  if (!address) return;
  try {
    console.log(`🔁 [Cache] Refreshing wallet cache for ${address}...`);
    await invalidateWalletCache(address);

    // 🕒 Tunggu 3 detik dulu supaya indexer SolanaTracker sempat sync
    await new Promise((r) => setTimeout(r, 3000));

    let wallet: any = null;
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries && (!wallet || !wallet.tokens || wallet.tokens.length <= 1)) {
      try {
        wallet = await solanaTracker.getWallet(address);
        if (wallet?.tokens?.length > 1) break;
      } catch (err: any) {
        console.warn(`⚠️ getWallet attempt ${attempt + 1} failed: ${err.message}`);
      }
      attempt++;
      if (attempt < maxRetries) {
        console.log(`⏳ Retry fetch #${attempt + 1} for ${address} in ${attempt * 2}s...`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }

    if (!wallet) {
      console.warn(`⚠️ [Cache] getWallet() returned null for ${address}`);
      return;
    }

    const apiTokens = (wallet.tokens || []).map((t: any) => {
      const mint =
        t.token.mint === "So11111111111111111111111111111111111111112"
          ? "So11111111111111111111111111111111111111111"
          : t.token.mint;
      const priceUsd = t.pools?.[0]?.price?.usd ?? 0;
      const percentChange = t.events?.["24h"]?.priceChangePercentage ?? 0;
      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      return {
        address,
        owner: address,
        mint,
        name: t.token.name ?? "Unknown Token",
        symbol: t.token.symbol ?? "???",
        logoURI: t.token.image ?? null,
        decimals: t.token.decimals ?? 9,
        amount: t.balance ?? 0,
        priceUsd: parseFloat(priceUsd.toFixed(6)),
        usdValue: parseFloat(t.value?.toFixed(2) ?? "0"),
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
        lastUpdated: new Date(),
      };
    });

    if (!apiTokens.length) {
      console.warn(`⚠️ [Cache] No tokens found after retries for ${address}, skipping cache rebuild.`);
      return;
    }

    // 🧠 Simpan ke MongoDB
    await Promise.all(
      apiTokens.map((t: any) =>
        WalletToken.findOneAndUpdate(
          { address, mint: t.mint },
          { ...t, lastUpdated: new Date() },
          { upsert: true }
        )
      )
    );

    // 🧠 Simpan ke Redis
    const response = {
      address,
      tokens: apiTokens,
      total: apiTokens.reduce((s: any, t: any) => s + (t.usdValue ?? 0), 0),
      totalSol: apiTokens.find((t: any) => t.symbol === "SOL")?.amount ?? 0,
      source: "onchain-refresh",
    };

    await redis.set(
      `tokens:${address}`,
      JSON.stringify({ timestamp: new Date().toISOString(), data: response }),
      "EX",
      60 * 5
    );

    console.log(`✅ [Cache] Rebuilt Redis for ${address} (${apiTokens.length} tokens)`);
  } catch (err: any) {
    console.error(`❌ [Cache] Failed to refresh cache for ${address}:`, err.message);
  }
}

import EventEmitter from "events";
export const walletEvents = new EventEmitter();

// ---------------------------------------------------------
// 🏆 PRIZEPOOL FETCHER
// ---------------------------------------------------------
async function getPrizePoolStatus() {
  const cacheKey = "prizepool:status";
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  try {
    const treasuryPubkey = new PublicKey(process.env.TREASURY_PDA!);

    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const UOG_MINT = process.env.UOG_MINT;

    // 1️⃣ Balance
    const lamports = await connection.getBalance(treasuryPubkey);
    const balanceSOL = lamports / 1e9;

    // 2️⃣ Tx history
    const sigs = await connection.getSignaturesForAddress(
      treasuryPubkey,
      { limit: 1000 }
    );

    // 3️⃣ Prices
    const priceKeySol = `price:${SOL_MINT}`;
    const priceKeyUog = `price:${UOG_MINT}`;

    let solUsd = Number(await redis.get(priceKeySol));
    let uogUsd = Number(await redis.get(priceKeyUog));

    // if price unavailable, force refresh
    if (!solUsd || solUsd === 0) solUsd = 0;
    if (!uogUsd || uogUsd === 0) uogUsd = 0;

    const uogPerSol = solUsd && uogUsd ? solUsd / uogUsd : 0;
    const valueUsd = balanceSOL * solUsd;

    const result = {
      prizepool_address: treasuryPubkey,
      balance_SOL: balanceSOL,
      balance_lamports: lamports,
      value_usd: valueUsd,
      sol_usd: solUsd,
      uog_usd: uogUsd,
      uog_per_sol: uogPerSol,
      total_transactions: sigs.length,
      timestamp: new Date().toISOString(),
    };

    // cache 1 menit
    await redis.set(cacheKey, JSON.stringify(result), "EX", 60);

    return result;
  } catch (err: any) {
    console.error("❌ PrizePool Error:", err.message);
    return null;
  }
}

// === Service utama ===
async function startWalletStream() {
  console.log("💰 Starting Wallet Stream Service (polling hybrid, from WalletToken)...");

  setInterval(async () => {
    try {
      // 1️⃣ Ambil semua wallet unik dari WalletToken
      const wallets = await WalletToken.distinct("address");
      if (!wallets.length) {
        console.log("⚠️ No wallets found in WalletToken collection.");
        return;
      }

      console.log(`🔍 Checking balances for ${wallets.length} wallets...`);

      // 2️⃣ Parallel fetch semua saldo
      const balancePromises = wallets.map((address) => getWalletBalance(address));
      const allBalances = await Promise.all(balancePromises);

      const prizepool = await getPrizePoolStatus();

      // 3️⃣ Kirim broadcast ke semua client
      broadcast({
        type: "wallet_balance_update",
        timestamp: new Date().toISOString(),
        data: allBalances,
        prizepool: prizepool,
      });

      // 4️⃣ Update data di WalletToken collection
      for (const b of allBalances) {
        for (const t of b.tokens as TokenBalance[]) {
          await WalletToken.updateOne(
            { address: b.address, mint: t.mint },
            {
              $set: {
                amount: t.amount ?? 0,
                decimals: t.decimals ?? 9,
                name: t.name ?? "Unknown Token",
                symbol: t.symbol ?? "???",
                logoURI: t.logoURI ?? null,
                priceUsd: t.usdValue ?? 0,
                usdValue: (t.amount ?? 0) * (t.usdValue ?? 0),
                lastUpdated: new Date(),
              },
            },
            { upsert: false }
          );
        }
      }

      console.log("✅ WalletToken balances updated & broadcasted.");
    } catch (err: any) {
      console.error("❌ Error in wallet stream loop:", err.message);
    }
  }, POLL_INTERVAL);
}

export {
  invalidateWalletCache,
  getWalletBalance,
  startWalletStream,
  refreshWalletCache
};
