import { Router, Request, Response } from "express";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const router = Router();

router.get("/balance/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const pubkey = new PublicKey(address);
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // 🔍 Ambil harga SOL dari CoinGecko (lengkap dengan 24h change)
    const cgResp = await axios.get(
      "https://api.coingecko.com/api/v3/coins/solana",
      {
        params: {
          localization: "false",
          tickers: "false",
          market_data: "true"
        }
      }
    );

    const solPriceUsd = cgResp.data.market_data.current_price.usd as number;
    const percentChange = cgResp.data.market_data.price_change_percentage_24h as number;

    const usdValue = sol * solPriceUsd;
    const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

    res.json({
      address,
      lamports,
      sol,
      solPriceUsd,
      usdValue,
      trend,         // -1 turun, 0 stabil, 1 naik
      percentChange, // % perubahan 24 jam terakhir dari market CoinGecko
    });
  } catch (err: any) {
    console.error("❌ Error fetching balance:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
