import express from "express";
import { GatchaPack } from "../models/GatchaPack";
import { doGatchaRoll } from "../services/gatchaService";
import { buildMintTransaction } from "../services/mintService";

const router = express.Router();

/**
 * CREATE Gatcha Pack
 */
router.post("/", async (req, res) => {
  try {
    const pack = new GatchaPack(req.body);
    await pack.save();
    res.status(201).json(pack);
  } catch (err: any) {
    console.error("❌ Error creating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to create gatcha pack" });
  }
});

/**
 * GET all Gatcha Packs
 */
router.get("/", async (_req, res) => {
  try {
    const packs = await GatchaPack.find();
    res.json(packs);
  } catch (err: any) {
    console.error("❌ Error fetching gatcha packs:", err.message);
    res.status(500).json({ error: "Failed to fetch gatcha packs" });
  }
});

/**
 * GET Gatcha Pack by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error fetching gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to fetch gatcha pack" });
  }
});

/**
 * UPDATE Gatcha Pack
 */
router.put("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error updating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to update gatcha pack" });
  }
});

/**
 * DELETE Gatcha Pack
 */
router.delete("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndDelete(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json({ message: "Gatcha pack deleted successfully" });
  } catch (err: any) {
    console.error("❌ Error deleting gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to delete gatcha pack" });
  }
});

/**
 * POST /pull
 * Generate NFT + metadata JSON
 */
router.post("/pull", async (req, res) => {
  try {
    const { packId, user, pulls = 1 } = req.body;
    if (!packId || !user) {
      return res.status(400).json({ error: "packId and user required" });
    }

    const pack = await GatchaPack.findById(packId).lean();
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    const results = [];
    for (let i = 0; i < pulls; i++) {
      const result = await doGatchaRoll(pack, user);
      results.push(result);
    }

    res.status(201).json({
      message: "Gatcha successful",
      pack: pack.name,
      pulls,
      results,
    });
  } catch (err: any) {
    console.error("❌ Error in gatcha pull:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:id/pull
 * Build raw mint transaction for frontend signing
 */
router.post("/:id/pull", async (req, res) => {
  try {
    const { user } = req.body;
    const pack = await GatchaPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    const { nft, blueprint, rewardInfo, metadata } = await doGatchaRoll(pack, user);

    const metadataUri = `${process.env.METADATA_URI}/${nft._id}.json`;

    const txResp = await buildMintTransaction(user, {
      name: nft.name,
      symbol: "UOGNFT",
      uri: metadataUri,
      price: 0,
      royalty: 0,
    });

    res.json({
      message: "🎲 Gatcha success!",
      rewardInfo,
      blueprint,
      nft,
      metadata,
      tx: txResp.tx,
      debug: txResp.debug,
    });
  } catch (err: any) {
    console.error("❌ Gatcha tx build error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
