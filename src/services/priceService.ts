import axios from "axios";

export interface PriceInfo {
  priceUsd: number | null;
  percentChange: number | null;
}

/**
 * Ambil harga + 24h change dari CoinGecko
 */
export async function getPriceInfo(id: string): Promise<PriceInfo> {
  try {
    const resp = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}`, {
      params: {
        localization: "false",
        tickers: "false",
        market_data: "true",
      },
    });

    return {
      priceUsd: resp.data.market_data.current_price.usd,
      percentChange: resp.data.market_data.price_change_percentage_24h,
    };
  } catch (err) {
    console.error(`❌ Failed to fetch price for ${id}`, err);
    return { priceUsd: null, percentChange: null };
  }
}
