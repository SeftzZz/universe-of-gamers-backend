import express, { Request, Response } from 'express';
import { Client } from '@solana-tracker/data-api';
import fetch from 'node-fetch';

const router = express.Router();
const client = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY as string });

type Candle = {
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  timestamp: number;
};

/** =============================
 *  GET /token/search
 *  ============================= */
router.get('/token/search', async (req: Request, res: Response) => {
  try {
    const { q, page = '1', limit = '20', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Missing query parameter q' });
    }

    console.log(`🔍 Searching tokens on Solana Tracker for: "${q}"`);

    // Panggil API bawaan dari SDK Solana Tracker
    const response = await client.searchTokens({
      query: q,
      page: Number(page),
      limit: Number(limit),
      sortBy: String(sortBy),
      sortOrder: String(sortOrder),
      showAllPools: false,
    });

    // SDK sudah mengembalikan objek { status, data }
    if (!response || !response.data) {
      return res.json({ status: 'success', data: [] });
    }

    // Map agar tetap seragam (beberapa field bisa beda tergantung versi API)
    const tokens = response.data.map((t: any) => ({
      name: t.name,
      symbol: t.symbol,
      mint: t.mint || t.address,
      decimals: t.decimals ?? 9,
      image: t.image || t.logoURI || null,
      holders: t.holders ?? 0,
      verified: !!t.verified,
      jupiter: !!t.jupiter,
      liquidityUsd: t.liquidityUsd ?? 0,
      marketCapUsd: t.marketCapUsd ?? 0,
      priceUsd: t.priceUsd ?? 0,
      volume_24h: t.volume_24h ?? t.volume24h ?? 0,
      poolAddress: t.poolAddress ?? null,
      tokenDetails: t.tokenDetails || null,
    }));

    res.json({ status: 'success', count: tokens.length, data: tokens });
  } catch (err) {
    const e = err as Error;
    console.error('❌ Error while searching tokens from Solana Tracker:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** =============================
 *  GET /token/ohlcv
 *  ============================= */
router.get('/token/ohlcv', async (req: Request, res: Response) => {
  try {
    const { type, mint } = req.query;
    if (!mint) {
      return res.status(400).json({ error: 'Missing token mint' });
    }

    const now = Math.floor(Date.now() / 1000);
    let intervalSec = 3600;

    switch (type) {
      case '1m': intervalSec = 60; break;
      case '5m': intervalSec = 300; break;
      case '15m': intervalSec = 900; break;
      case '30m': intervalSec = 1800; break;
      case '1h': intervalSec = 3600; break;
      case '1d': intervalSec = 86400; break;
    }

    const timeTo = now;
    const timeFrom = now - intervalSec * 20;

    const chartData = await client.getChartData({
      tokenAddress: String(mint),
      type: String(type),
      timeFrom,
      timeTo,
      marketCap: false,
      removeOutliers: true,
      dynamicPools: true,
      fastCache: true,
    });

    const rawCandles: any[] = (chartData as any).oclhv || (chartData as any).ohlcv || [];
    const candles: Candle[] = rawCandles.map((c: any) => ({
      open: c.open,
      close: c.close,
      high: c.high,
      low: c.low,
      volume: c.volume,
      timestamp: c.timestamp ?? Math.floor(Date.now() / 1000),
    }));

    if (!candles.length) {
      return res.json({ lastClose: null });
    }

    const closes = candles.map(c => c.close);
    const lastClose = closes[closes.length - 1];
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const athToday = highs.length ? Math.max(...highs) : 0;
    const floorPrice = lows.length ? Math.min(...lows) : 0;

    res.json({ candles, athToday, floorPrice, lastClose });
  } catch (err) {
    const e = err as Error;
    console.error('❌ Error fetch token data:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** =============================
 *  GET /token/info
 *  ============================= */
router.get('/token/info', async (req: Request, res: Response) => {
  try {
    const { mint } = req.query;
    if (!mint) {
      return res.status(400).json({ error: 'Missing token mint' });
    }

    const tokenInfo = await client.getTokenInfo(String(mint));
    res.json(tokenInfo);
  } catch (err) {
    const e = err as Error;
    console.error('❌ Error fetch token info:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
