import express from "express";
import { Battle } from "../models/Battle";

const router = express.Router();

/**
 * CREATE new battle
 * Body: { players: [{user, team}], mode: "pvp"|"pve"|"raid" }
 */
router.post("/battle", async (req, res) => {
  try {
    const { players, mode } = req.body;

    if (!players || players.length < 2) {
      return res.status(400).json({ error: "At least 2 players required" });
    }

    const battle = new Battle({ players, mode, result: "pending", log: [] });
    await battle.save();

    res.status(201).json(battle);
  } catch (err: any) {
    console.error("❌ Error creating battle:", err.message);
    res.status(500).json({ error: "Failed to create battle" });
  }
});

/**
 * GET all battles
 * Optional query: ?user=WalletAddress&mode=pvp
 */
router.get("/battle", async (req, res) => {
  try {
    const filter: any = {};
    if (req.query.user) {
      filter["players.user"] = req.query.user;
    }
    if (req.query.mode) {
      filter.mode = req.query.mode;
    }

    const battles = await Battle.find(filter).populate("players.team");
    res.json(battles);
  } catch (err: any) {
    console.error("❌ Error fetching battles:", err.message);
    res.status(500).json({ error: "Failed to fetch battles" });
  }
});

/**
 * GET battle by ID
 */
router.get("/battle/:id", async (req, res) => {
  try {
    const battle = await Battle.findById(req.params.id).populate("players.team");
    if (!battle) return res.status(404).json({ error: "Battle not found" });
    res.json(battle);
  } catch (err: any) {
    console.error("❌ Error fetching battle:", err.message);
    res.status(500).json({ error: "Failed to fetch battle" });
  }
});

/**
 * UPDATE battle (status, result, winner)
 * Body: { result?, players? (update isWinner) }
 */
router.put("/battle/:id", async (req, res) => {
  try {
    const { result, players } = req.body;

    const updateData: any = {};
    if (result) updateData.result = result;
    if (players) updateData.players = players;

    const battle = await Battle.findByIdAndUpdate(req.params.id, updateData, {
      new: true
    }).populate("players.team");

    if (!battle) return res.status(404).json({ error: "Battle not found" });
    res.json(battle);
  } catch (err: any) {
    console.error("❌ Error updating battle:", err.message);
    res.status(500).json({ error: "Failed to update battle" });
  }
});

/**
 * DELETE battle
 */
router.delete("/battle/:id", async (req, res) => {
  try {
    const battle = await Battle.findByIdAndDelete(req.params.id);
    if (!battle) return res.status(404).json({ error: "Battle not found" });
    res.json({ message: "Battle deleted successfully" });
  } catch (err: any) {
    console.error("❌ Error deleting battle:", err.message);
    res.status(500).json({ error: "Failed to delete battle" });
  }
});

/**
 * APPEND log turn
 * Body: { turn, attacker, defender, skill, damage, remainingHp }
 */
router.post("/battle/:id/log", async (req, res) => {
  try {
    const { turn, attacker, defender, skill, damage, isCrit, remainingHp } = req.body;

    const battle = await Battle.findById(req.params.id);
    if (!battle) return res.status(404).json({ error: "Battle not found" });

    const newLog = {
      turn,
      attacker,
      defender,
      skill,
      damage,
      isCrit,
      remainingHp,
      timestamp: new Date()
    };

    battle.log.push(newLog);
    await battle.save();

    res.status(201).json({ message: "Log appended", log: newLog });
  } catch (err: any) {
    console.error("❌ Error appending log:", err.message);
    res.status(500).json({ error: "Failed to append log" });
  }
});

/**
 * GET battle logs only
 * GET /battle/:id/log
 */
router.get("/battle/:id/log", async (req, res) => {
  try {
    const battle = await Battle.findById(req.params.id, { log: 1, _id: 0 });

    if (!battle) {
      return res.status(404).json({ error: "Battle not found" });
    }

    res.status(200).json(battle.log);
  } catch (err: any) {
    console.error("❌ Error fetching battle logs:", err.message);
    res.status(500).json({ error: "Failed to fetch battle logs" });
  }
});

export default router;
