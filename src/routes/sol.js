import express from 'express';
import { Client } from '@solana-tracker/data-api';

const router = express.Router();
const client = new Client({ apiKey: process.env.SOLANATRACKER_API_KEY });

// Endpoint untuk ambil OHLC SOL dengan query param interval & limit
router.get('/sol/ohlcv', async (req, res) => {
  try {
    // baca query param, default type = 1h, limit = 24
    const { type = '1h', limit = 24 } = req.query;

    const chartData = await client.getChartData({
      tokenAddress: 'So11111111111111111111111111111111111111112', // SOL
      type,              // misal '5m', '1h', '1d'
      limit: Number(limit), // jumlah candle
      removeOutliers: true,
      dynamicPools: true,
      timezone: 'current',
      fastCache: true,
    });

    res.json(chartData.oclhv); // ✅ kirim array OHLCV saja
  } catch (err) {
    console.error('❌ Error fetch SOL data:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
