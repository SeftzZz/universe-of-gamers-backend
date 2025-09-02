import axios from "axios";

const BITQUERY_URL = "https://streaming.bitquery.io/eap";
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY as string;
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY as string;

/**
 * Hitung percentChange dari Bitquery (harga sekarang vs 24h lalu)
 */
async function getPercentChangeFromBitquery(mint: string): Promise<number | null> {
  try {
    const query = `
      query TokenOHLC($mint: String!) {
        Solana {
          now: DEXTradeByTokens(
            where: { Trade: { Currency: { MintAddress: { is: $mint } } } }
            orderBy: { descending: Block_Time }
            limit: { count: 1 }
          ) {
            Trade { PriceInUSD }
          }
          past: DEXTradeByTokens(
            where: { Trade: { Currency: { MintAddress: { is: $mint } } } }
            orderBy: { descending: Block_Time }
            limit: { count: 1 }
            time: { till: "${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}" }
          ) {
            Trade { PriceInUSD }
          }
        }
      }
    `;

    const resp = await axios.post(
      BITQUERY_URL,
      { query, variables: { mint } },
      { headers: { "Authorization": `Bearer ${process.env.BITQUERY_API_KEY}` } }
    );

    const now = resp.data?.data?.Solana?.now?.[0]?.Trade?.PriceInUSD;
    const past = resp.data?.data?.Solana?.past?.[0]?.Trade?.PriceInUSD;

    if (typeof now !== "number" || typeof past !== "number" || past <= 0) return null;

    const percentChange = ((now - past) / past) * 100;
    return parseFloat(percentChange.toFixed(4));
  } catch (err) {
    console.error("❌ Bitquery percentChange error:", err.message);
    return null;
  }
}

/**
 * Ambil percentChange dari Solscan API
 */
async function getPercentChangeFromSolscan(mint: string): Promise<number | null> {
  try {
    const resp = await axios.get(`https://pro-api.solscan.io/v2.0/token/meta?address=${mint}`, {
      headers: { token: process.env.SOLSCAN_API_KEY || "" }
    });

    const change24h = resp.data?.data?.priceChange24hPercent;
    return typeof change24h === "number" ? parseFloat(change24h.toFixed(4)) : null;
  } catch (err) {
    console.error("❌ Solscan percentChange error:", err.message);
    return null;
  }
}

/**
 * Main function → coba Bitquery dulu, lalu fallback Birdeye, lalu Solscan
 */
export async function getPercentChange(mint: string): Promise<number | null> {
  let percentChange = await getPercentChangeFromBitquery(mint);
  if (percentChange !== null) return percentChange;

  return null; // kalau semua gagal
}
