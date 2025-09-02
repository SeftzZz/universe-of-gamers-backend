import axios from "axios";

const BITQUERY_URL = "https://streaming.bitquery.io/eap";
const BITQUERY_API_KEY = process.env.BITQUERY_API_KEY as string;

export interface TokenPriceInfo {
  priceUsd: number | null;
  name?: string | null;
  symbol?: string | null;
  percentChange?: number | null;
  lastUpdated?: string | null;
}

/**
 * Ambil harga terakhir dari Bitquery berdasarkan mint address
 */
export async function getTokenPriceFromBitquery(mint: string): Promise<TokenPriceInfo> {
  const query = `
    query LatestTrades {
      Solana {
        DEXTradeByTokens(
          orderBy: {descending: Block_Time}
          limit: {count: 1}
          where: {Trade: {Currency: {MintAddress: {is: "${mint}"}}}}
        ) {
          Block { Time }
          Trade {
            PriceInUSD
            Currency { Name }
            Side {
              Currency { Symbol MintAddress Name }
            }
          }
        }
      }
    }`;

  try {
    const resp = await axios.post(
      BITQUERY_URL,
      { query },
      { headers: { "Authorization": `Bearer ${process.env.BITQUERY_API_KEY}` } }
    );

    const trade = resp.data.data?.Solana?.DEXTradeByTokens?.[0];
    if (!trade) return { priceUsd: null, name: null, symbol: null };

    return {
      priceUsd: trade.Trade?.PriceInUSD ?? null,
      name: trade.Trade?.Currency?.Name ?? null,
      symbol: trade.Trade?.Side?.Currency?.Symbol ?? null,
      percentChange: null,
      lastUpdated: trade.Block?.Time ?? null,
    };
  } catch (err) {
    console.error(`❌ Bitquery price fetch error for ${mint}`, err);
    return { priceUsd: null, name: null, symbol: null, lastUpdated: null };
  }
}
