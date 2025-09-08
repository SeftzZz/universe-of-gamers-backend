import express from 'express';
import { Client } from '@solana-tracker/data-api';

const router = express.Router();
const client = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY });

router.get('/token/ohlcv', async (req, res) => {
  try {
    const { type, mint } = req.query;
    if (!mint) return res.status(400).json({ error: "Missing token mint" });

    const now = Math.floor(Date.now() / 1000);
    let intervalSec = 3600;

    if (type === '1m') intervalSec = 60;
    else if (type === '5m') intervalSec = 300;
    else if (type === '15m') intervalSec = 900;
    else if (type === '30m') intervalSec = 1800;
    else if (type === '1h') intervalSec = 3600;
    else if (type === '1d') intervalSec = 86400;

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

    const candles = chartData.oclhv || [];
    const closes = candles.map(c => c.close);

    if (!closes.length) {
      return res.json({ lastClose: null });
    }

    const lastClose = closes[closes.length - 1];
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const athToday = highs.length ? Math.max(...highs) : 0;
    const floorPrice = lows.length ? Math.min(...lows) : 0;

    res.json({ candles, athToday, floorPrice, lastClose });
  } catch (err) {
    console.error('❌ Error fetch token data:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/token/info', async (req, res) => {
  try {
    const { mint } = req.query;
    if (!mint) return res.status(400).json({ error: "Missing token mint" });

    const tokenInfo = await client.getTokenInfo(String(mint));
    res.json(tokenInfo);
  } catch (err) {
    console.error('❌ Error fetch token info:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
