import express from "express";
import { Types } from "mongoose";
import { Battle } from "../models/Battle";
import { DailyEarning } from "../models/DailyEarning";
import { MatchEarning } from "../models/MatchEarning";
import { RankConfig } from "../models/RankConfig";
import { HeroConfig } from "../models/HeroConfig";
import { Team } from "../models/Team";
import { Player } from "../models/Player";
import { PlayerHero } from "../models/PlayerHero"; // ✅ wajib
import { startOfDay, endOfDay } from "date-fns";

const router = express.Router();

interface IDailyEarningPayload {
  rank: string;
  winStreak: number;
  totalFragment: number;
  totalDaily: number;
  heroes: { rarity: string; level: number }[];
}

// ✅ Helper: cari rank modifier dari DB
async function getRankModifier(rank: string): Promise<number> {
  const rankDoc = await RankConfig.findOne({ rank: rank.toLowerCase() });
  return rankDoc ? rankDoc.modifier : 0;
}

// Hitung total economic fragment berdasarkan rarity & level anggota tim
export async function calculateEconomicFragment(
  teamId: Types.ObjectId | string
): Promise<number> {
  const team = await Team.findById(teamId).populate("members");
  if (!team || !team.members || team.members.length === 0) return 0;

  const MAX_NORMALIZED = 37500 * 3;
  let totalValue = 0;
  let lowestRarity: "common" | "rare" | "epic" | "legendary" = "legendary";

  const rarityOrder = ["common", "rare", "epic", "legendary"];

  for (const h of team.members as any[]) {
    // Pastikan tiap NFT punya rarity & level
    const rarity = h.rarity ?? "common";
    const level = h.level ?? 1;

    const config = await HeroConfig.findOne({ rarity });
    if (config) {
      totalValue += (config.teamValue as Record<number, number>)[level] || 0;
      if (rarityOrder.indexOf(rarity) < rarityOrder.indexOf(lowestRarity)) {
        lowestRarity = rarity;
      }
    }
  }

  const totalNormalized = totalValue / MAX_NORMALIZED;
  const rarityCfg = await HeroConfig.findOne({ rarity: lowestRarity });
  const teamModifier = rarityCfg ? rarityCfg.teamModifier : 0.15;

  const economicFragment =
    totalNormalized * (1 - teamModifier) + teamModifier;

  return economicFragment;
}

async function saveDailyEarning(
  result: IDailyEarningPayload,
  playerId: string
) {
  try {
    // 🎯 Tentukan rentang waktu hari ini
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    // 🧮 Update atau insert jika belum ada
    await DailyEarning.findOneAndUpdate(
      {
        playerId,
        date: { $gte: todayStart, $lte: todayEnd },
      },
      {
        $set: {
          rank: result.rank,
          winStreak: result.winStreak,
          heroesUsed: result.heroes,
        },
        $inc: {
          totalFragment: result.totalFragment, // tambah akumulasi
          totalDailyEarning: result.totalDaily, // tambah total harian
        },
      },
      { upsert: true, new: true }
    );
  } catch (err: any) {
    console.error("❌ Error saving daily earning:", err.message);
  }
}

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

    const battle = new Battle({ players, mode, result: "init_battle", log: [] });
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
// ✅ PUT: update battle result & sync earnings
// ✅ Endpoint update battle + hitung earning otomatis
router.put("/battle/:id", async (req, res) => {
  try {
    const { result, players } = req.body;

    // 1️⃣ Update battle result
    const updateData: Record<string, any> = {};
    if (result) updateData.result = result;
    if (players) updateData.players = players;

    const battle = await Battle.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    })
      .populate({
        path: "players.team",
        model: "Team",
        populate: {
          path: "members",
          model: "Nft",
          populate: {
            path: "character",
            model: "Character",
            select:
              "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
          },
        },
      });

    if (!battle) return res.status(404).json({ error: "Battle not found" });

    // ===============================================
    // 2️⃣ Jika Battle Selesai → Proses Earning
    // ===============================================
    if (result === "end_battle") {
      for (const p of battle.players) {
        const playerId = p.user;
        const isWinner = p.isWinner;

        // === Ambil Data Tim ===
        const teamId = p.team?._id || p.team;
        const economicFragment = await calculateEconomicFragment(teamId);

        // === Rank Modifier ===
        const lastEarning = await DailyEarning.findOne({ playerId }).sort({
          createdAt: -1,
        });
        const playerRank = lastEarning?.rank || "sentinel";
        const rankModifier = await getRankModifier(playerRank);

        // === Win Streak ===
        const winStreak = isWinner ? (lastEarning?.winStreak || 0) + 1 : 0;

        // === Skill Fragment Berdasarkan Winrate ===
        const WINRATE_MODIFIER: Record<number, number> = {
          1: 0.01,
          2: 0.05,
          3: 0.07,
          4: 0.09,
          5: 0.11,
          6: 0.13,
          7: 0.15,
          8: 0.17,
          9: 0.21,
        };
        const skillFragment =
          (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0.21) * 100;

        // === Booster ===
        const booster = winStreak >= 3 ? 2 : 1;

        // === Total Fragment ===
        const totalFragment =
          (economicFragment * skillFragment) * booster * rankModifier;

        const totalDaily = totalFragment * 10;

        // === Tentukan Game Number Harian ===
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastGame = await MatchEarning.findOne({
          playerId,
          createdAt: { $gte: today },
        })
          .sort({ createdAt: -1 });

        const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

        // === Simpan ke MatchEarning ===
        await MatchEarning.create({
          playerId,
          gameNumber: nextGameNumber,
          winCount: isWinner ? 1 : 0,
          skillFragment,
          economicFragment,
          booster,
          rankModifier,
          totalFragment,
        });

        // === Update Player ===
        await Player.findOneAndUpdate(
          { walletAddress: playerId },
          {
            $inc: { totalEarning: totalFragment },
            $set: { lastActive: new Date() },
          },
          { upsert: false }
        );

        // === Simpan / Update DailyEarning ===
        await saveDailyEarning(
          {
            rank: playerRank,
            winStreak,
            totalFragment,
            totalDaily,
            heroes:
              p.team && "members" in p.team
                ? (p.team.members as any[])
                : [],
          },
          playerId
        );
      }
    }

    // ===============================================
    // 3️⃣ Response ke Client
    // ===============================================
    res.status(200).json({
      success: true,
      message: "Battle updated and earnings processed",
      battle,
    });
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

    // 1️⃣ Validasi input
    if (!turn || !attacker || !defender || !skill || damage === undefined || remainingHp === undefined) {
      return res.status(400).json({ error: "Missing required log fields" });
    }

    // 2️⃣ Cek apakah battle ada
    const battle = await Battle.findById(req.params.id);
    if (!battle) {
      console.warn(`⚠️ Battle not found: ${req.params.id}`);
      return res.status(404).json({ error: "Battle not found" });
    }

    // 3️⃣ Siapkan log baru
    const newLog = {
      turn,
      attacker,
      defender,
      skill,
      damage,
      isCrit: !!isCrit,
      remainingHp,
      timestamp: new Date(),
    };

    // 4️⃣ Tambahkan log ke array battle.log
    battle.log.push(newLog);
    battle.updatedAt = new Date();
    await battle.save();

    // 5️⃣ Logging ke console (monitor real-time)
    console.log(`🧩 [BATTLE LOG] BattleID=${battle._id}`);
    console.log(`🕹️ Turn ${turn}: ${attacker} ➜ ${defender}`);
    console.log(`⚔️ Skill=${skill} | Damage=${damage} | Crit=${!!isCrit}`);
    console.log(`❤️ Remaining HP: ${remainingHp}`);
    console.log("-----------------------------------");

    // 6️⃣ (opsional) kirim log balik ke client
    res.status(201).json({
      success: true,
      message: "Battle log appended successfully",
      log: newLog,
    });
  } catch (err: any) {
    console.error("❌ Error appending battle log:", err.message);
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
