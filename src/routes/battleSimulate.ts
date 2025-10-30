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


function isAlive(member: any) {
  return member.hp > 0;
}
function getAliveTeam(team: any[]) {
  return team.filter(isAlive);
}
function chooseTarget(team: any[], attacker?: any) {
  const alive = getAliveTeam(team);
  const candidates = attacker ? alive.filter(m => m.id !== attacker.id) : alive;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function calcDamage(attacker: any, defender: any, skill: any) {
  // 1. Hitung raw damage dari ATK, DEF, HP attacker dengan multiplier skill
  let rawDamage =
    (attacker.atk * (skill.atkMultiplier || 0)) +
    (attacker.def * (skill.defMultiplier || 0)) +
    (attacker.hp * (skill.hpMultiplier || 0));

  // 2. Damage reduction berdasarkan DEF target
  let defenseMultiplier = 100 / (100 + defender.def);
  let reducedDamage = rawDamage * defenseMultiplier;

  // 3. Minimum damage
  if (reducedDamage < 10) reducedDamage = 10;

  // 4. Critical hit check
  let isCrit = Math.random() < attacker.critRate;
  if (isCrit) {
    reducedDamage *= (1 + attacker.critDmg);
  }

  return {
    damage: Math.round(reducedDamage),
    isCrit: isCrit,
  };
}
function chooseSkill(attacker: any) {
  if (attacker.cdUlt === 0 && Math.random() < 0.2) {
    attacker.cdUlt = 5;
    return "ultimate";
  }
  if (attacker.cdSkill === 0 && Math.random() < 0.4) {
    attacker.cdSkill = 2;
    return "skill";
  }
  return "basic";
}

async function simulateBattle(teamA: any[], teamB: any[]) {
  let turn = 1;
  const log: any[] = [];

  [...teamA, ...teamB].forEach(m => {
    m.cdSkill = 0;
    m.cdUlt = 0;
  });

  while (getAliveTeam(teamA).length > 0 && getAliveTeam(teamB).length > 0) {
    const allMembers = [...getAliveTeam(teamA), ...getAliveTeam(teamB)];
    allMembers.sort((a, b) => (b.spd || 0) - (a.spd || 0));

    for (const attacker of allMembers) {
      const attackerTeam = teamA.includes(attacker) ? teamA : teamB;
      const enemyTeam = attackerTeam === teamA ? teamB : teamA;
      if (!isAlive(attacker) || getAliveTeam(enemyTeam).length === 0) continue;

      if (attacker.cdSkill > 0) attacker.cdSkill--;
      if (attacker.cdUlt > 0) attacker.cdUlt--;

      const skillType = chooseSkill(attacker);

      let skillObj;
      switch (skillType) {
        case "skill":
          skillObj = attacker.skillAttack || attacker.basicAttack;
          break;
        case "ultimate":
          skillObj = attacker.ultimateAttack || attacker.basicAttack;
          break;
        default:
          skillObj = attacker.basicAttack;
          break;
      }

      if (!skillObj) {
        throw new Error(`No skill data found for ${attacker.name} (${skillType})`);
      }

      const defender = chooseTarget(enemyTeam, attacker);
      const damageResult = calcDamage(attacker, defender, skillObj);

      defender.hp -= damageResult.damage;
      if (defender.hp < 0) defender.hp = 0;

      const entry = {
        turn,
        attacker: attacker.name,
        defender: defender.name,
        skill: skillObj.name,
        damage: damageResult.damage,
        isCrit: damageResult.isCrit,
        remainingHp: defender.hp,
        timestamp: new Date(),
      };

      log.push(entry);

      // 🔎 Print langsung ke console
      console.log(
        `Turn ${turn}: ${entry.attacker} used ${entry.skill} on ${entry.defender} ` +
        `→ Damage: ${entry.damage}${entry.isCrit ? " (CRIT!)" : ""}, ` +
        `Remaining HP: ${entry.remainingHp}`
      );

      turn++;
    }
  }

  const winner = getAliveTeam(teamA).length > 0 ? "teamA" : "teamB";
  console.log(`🏆 Winner: ${winner}`);
  return { winner, log };
}

// === API Endpoint ===
router.post("/battle/simulate", async (req, res) => {
  try {
    const { teamAId, teamBId, mode = "pvp" } = req.body;

    // Populate bertingkat: Team → members (NFT) → character
    const teamA = await Team.findById(teamAId).populate({
      path: "members",
      model: "Nft",
      populate: {
        path: "character",
        model: "Character",
        select:
          "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
      },
    });

    const teamB = await Team.findById(teamBId).populate({
      path: "members",
      model: "Nft",
      populate: {
        path: "character",
        model: "Character",
        select:
          "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
      },
    });

    if (!teamA || !teamB) {
      return res.status(404).json({ error: "Team not found" });
    }

    // Map NFT + Character blueprint ke anggota battle
    const membersA = (teamA.members as any[]).map((nft) => {
      const char = nft.character as any;
      return {
        id: nft._id.toString(),
        name: nft.name || (char?.name ?? "Unknown"),
        hp: nft.hp ?? char?.baseHp ?? 100,
        atk: nft.atk ?? char?.baseAtk ?? 50,
        def: nft.def ?? char?.baseDef ?? 30,
        spd: nft.spd ?? char?.baseSpd ?? 10,
        critRate: (nft.critRate ?? char?.baseCritRate ?? 0) / 100,
        critDmg: (nft.critDmg ?? char?.baseCritDmg ?? 0) / 100,
        basicAttack: char?.basicAttack,
        skillAttack: char?.skillAttack,
        ultimateAttack: char?.ultimateAttack,
      };
    });

    const membersB = (teamB.members as any[]).map((nft) => {
      const char = nft.character as any;
      return {
        id: nft._id.toString(),
        name: nft.name || (char?.name ?? "Unknown"),
        hp: nft.hp ?? char?.baseHp ?? 100,
        atk: nft.atk ?? char?.baseAtk ?? 50,
        def: nft.def ?? char?.baseDef ?? 30,
        spd: nft.spd ?? char?.baseSpd ?? 10,
        critRate: (nft.critRate ?? char?.baseCritRate ?? 0) / 100,
        critDmg: (nft.critDmg ?? char?.baseCritDmg ?? 0) / 100,
        basicAttack: char?.basicAttack,
        skillAttack: char?.skillAttack,
        ultimateAttack: char?.ultimateAttack,
      };
    });

    // 🔎 Debug
    console.log("=== Team A Members ===", JSON.stringify(membersA, null, 2));
    console.log("=== Team B Members ===", JSON.stringify(membersB, null, 2));

    const { winner, log } = await simulateBattle(membersA, membersB);

    const battle = new Battle({
      players: [
        { user: teamA.owner, team: teamA._id, isWinner: winner === "teamA" },
        { user: teamB.owner, team: teamB._id, isWinner: winner === "teamB" },
      ],
      mode,
      result: "end_battle",
      log,
    });
    await battle.save();

    // ===============================================
    // 4️⃣ Jika Battle Selesai → Proses Earning
    // ===============================================
    if (battle.result === "end_battle") {
      for (const p of battle.players) {
        const playerId = p.user;
        const isWinner = p.isWinner;

        // === Ambil Data Tim ===
        const teamId = p.team?._id || p.team;
        const economicFragment = await calculateEconomicFragment(teamId);

        // === Rank Modifier ===
        const lastEarning = await DailyEarning.findOne({ playerId }).sort({ createdAt: -1 });
        const playerRank = lastEarning?.rank || "sentinel";
        const rankModifier = await getRankModifier(playerRank);

        // === Win Streak ===
        const winStreak = isWinner ? (lastEarning?.winStreak || 0) + 1 : 0;

        // === Skill Fragment ===
        const WINRATE_MODIFIER: Record<number, number> = {
          1: 0.01, 2: 0.05, 3: 0.07, 4: 0.09, 5: 0.11,
          6: 0.13, 7: 0.15, 8: 0.17, 9: 0.21,
        };
        const skillFragment =
          (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0.21) * 100;

        // === Booster ===
        const booster = winStreak >= 3 ? 2 : 1;

        // === Total Fragment ===
        const totalFragment =
          (economicFragment * skillFragment) * booster * rankModifier;
        const totalDaily = totalFragment * 10;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const lastGame = await MatchEarning.findOne({
          playerId,
          createdAt: { $gte: today },
        })
          .sort({ createdAt: -1 });

        const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

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
          { walletAddress: playerId }, // ✅ cari berdasarkan wallet
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
    // 5️⃣ Response ke Client
    // ===============================================
    res.status(201).json({
      success: true,
      message: "Battle simulated and earnings calculated",
      battle,
    });
  } catch (err: any) {
    console.error("❌ Error simulate battle:", err.message);
    res.status(500).json({ error: "Failed to simulate battle" });
  }
});

export default router;
