import express, { Request, Response } from 'express';
import { Client } from '@solana-tracker/data-api';

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

    // handle fallback oclhv / ohlcv dan pastikan semua field ada
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
