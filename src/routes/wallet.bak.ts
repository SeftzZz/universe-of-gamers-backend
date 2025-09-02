import { Router, Request, Response } from "express";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import dotenv from "dotenv";
import { getTokenPriceFromBitquery } from "../services/bitqueryService";
import { getPercentChange } from "../services/percentChangeService";
import { getPriceInfo } from "../services/priceService";

dotenv.config();
const router = Router();

// Mint addresses
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UOG_MINT = "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk";
const CUSTOM_TOKENS: Record<string, { id: string, symbol: string, name: string, logoURI: string }> = {
  "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk": {
    id: "universe-of-gamers",
    symbol: "UOG",
    name: "Universe Of Gamers",
    logoURI: "https://assets.coingecko.com/coins/images/xxxxx/large/uog.png" // link resmi coingecko
  }
};

//
// GET /wallet/balance/:address
//
router.get("/balance/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const pubkey = new PublicKey(address);
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // 🔥 Ambil harga SOL dari Bitquery
    let solInfo = await getTokenPriceFromBitquery(SOL_MINT);

    // fallback ke CoinGecko kalau Bitquery gagal
    if (!solInfo.priceUsd || solInfo.priceUsd === 0) {
      const cg = await getPriceInfo("solana");
      solInfo = {
        priceUsd: cg.priceUsd,
        name: "Wrapped Solana",
        symbol: "SOL",
        percentChange: cg.percentChange,
        lastUpdated: cg.priceUsd ? new Date().toISOString() : null,
      };
    }

    // pastikan symbol/name konsisten
    const symbol = "SOL";
    const name = "Wrapped Solana";

    const usdValue = solInfo.priceUsd ? sol * solInfo.priceUsd : null;

    res.json({
      address,
      lamports,
      sol,
      solPriceUsd: solInfo.priceUsd,
      usdValue,
      name,
      symbol,
      percentChange: solInfo.percentChange,
      lastUpdated: solInfo.lastUpdated,
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
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const pubkey = new PublicKey(address);

    // ambil SPL token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });

    const tokens = tokenAccounts.value.map((acc) => {
      const info: any = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        owner: info.owner,
        amount: info.tokenAmount.uiAmount,
        decimals: info.tokenAmount.decimals,
      };
    });

    // ambil native SOL balance
    const lamports = await connection.getBalance(pubkey);
    const solBalance = lamports / LAMPORTS_PER_SOL;

    // ambil metadata token list
    const tokenListProvider = new TokenListProvider();
    const tokenList = await tokenListProvider.resolve();
    const list = tokenList.filterByChainId(ChainId.MainnetBeta).getList();

    // enrich SPL tokens
    const enriched = tokens.map((t) => {
      const meta = list.find((tk) => tk.address === t.mint);
      return {
        ...t,
        name: meta?.name || null,
        symbol: meta?.symbol || "Unknown Token",
        logoURI: meta?.logoURI || null,
      };
    });

    // tambahkan default tokens (SOL, USDC, UOG)
    const defaults = [
      { mint: SOL_MINT, amount: solBalance, decimals: 9 },
      { mint: USDC_MINT, amount: 0, decimals: 6 },
      { mint: UOG_MINT, amount: 0, decimals: 9 },
    ];

    const withDefaults = defaults.map((d) => {
      const exist = enriched.find((e) => e.mint === d.mint);
      if (exist) return exist;
      const meta = list.find((tk) => tk.address === d.mint);
      return {
        mint: d.mint,
        owner: address,
        amount: d.amount,
        decimals: d.decimals,
        name: meta?.name || null,
        symbol: meta?.symbol || "Unknown Token",
        logoURI: meta?.logoURI || null,
      };
    });

    const allTokens = [
      ...withDefaults,
      ...enriched.filter((e) => ![SOL_MINT, USDC_MINT, UOG_MINT].includes(e.mint)),
    ];

    // 🔥 Ambil harga semua token dari Bitquery
    const final = await Promise.all(
      allTokens.map(async (t) => {
        const priceInfo = await getTokenPriceFromBitquery(t.mint);
        const percentChange = await getPercentChange(t.mint);

        const trend = percentChange !== null
          ? percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0
          : 0;

        return {
          ...t,
          priceUsd: priceInfo.priceUsd,
          usdValue: priceInfo.priceUsd ? t.amount * priceInfo.priceUsd : null,
          percentChange,
          trend,
          lastUpdated: priceInfo.lastUpdated,
        };
      })
    );

    res.json({
      address,
      tokens: final,
    });
  } catch (err: any) {
    console.error("❌ Error fetching tokens:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
