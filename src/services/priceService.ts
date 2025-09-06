import { Client } from "@solana-tracker/data-api";

export interface PriceInfo {
  priceUsd: number | null;
  percentChange: number | null;
}

const solanaTracker = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY });

// ✅ cache in-memory dengan TTL 1 menit
const priceCache: Map<string, { data: PriceInfo; ts: number }> = new Map();
const CACHE_TTL = 60 * 1000; // 1 menit

// ✅ harga terakhir untuk manual percentChange (simulasi, bisa pakai DB/Redis)
const lastPrices: Record<string, number> = {};

export async function getTokenInfo(mint: string): Promise<PriceInfo> {
  const now = Date.now();

  // cek cache dulu
  const cached = priceCache.get(mint);
  if (cached && now - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const searchResults = await solanaTracker.searchTokens({ query: mint });
    const tokens = searchResults?.data || [];

    if (!tokens.length) {
      console.log("❌ Token not found:", mint);
      const data = { priceUsd: null, percentChange: null };
      priceCache.set(mint, { data, ts: now });
      return data;
    }

    const token = tokens[0];
    const currentPrice = token.priceUsd ?? null;

    let percentChange: number | null = null;
    if (currentPrice !== null) {
      const lastPrice = lastPrices[mint];
      if (lastPrice) {
        percentChange = ((currentPrice - lastPrice) / lastPrice) * 100;
      }
      lastPrices[mint] = currentPrice; // update harga terakhir
    }

    const data: PriceInfo = { priceUsd: currentPrice, percentChange };

    // simpan ke cache
    priceCache.set(mint, { data, ts: now });

    console.log(`✅ ${token.name} (${token.symbol}) $${currentPrice?.toFixed(2)} | Δ ${percentChange ?? "N/A"}%`);

    return data;
  } catch (err) {
    console.error("❌ Error getTokenInfo:", err);
    const data = { priceUsd: null, percentChange: null };
    priceCache.set(mint, { data, ts: now });
    return data;
  }
}
