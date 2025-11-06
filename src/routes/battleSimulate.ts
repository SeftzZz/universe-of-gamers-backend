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
import { Nft } from "../models/Nft";               // ✅ untuk verifikasi
import { startOfDay, endOfDay } from "date-fns";
import { broadcast } from "../index";

const router = express.Router();

interface IDailyEarningPayload {
  rank: string;
  winStreak: number;
  totalFragment: number;
  totalDaily: number;
  heroes: { rarity: string; level: number }[];
}

// ============================================================
// 🔧 Rank Modifier
// ============================================================
async function getRankModifier(rank: string): Promise<number> {
  const rankDoc = await RankConfig.findOne({ rank: rank.toLowerCase() });
  return rankDoc ? rankDoc.modifier : 0;
}

// ============================================================
// 💰 Economic Fragment Calculator
// ============================================================
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
    const rarity = h.rarity ?? "common";
    const level = h.level ?? 1;
    const config = await HeroConfig.findOne({ rarity });
    if (config) {
      totalValue += (config.teamValue as Record<number, number>)[level] || 0;
      if (rarityOrder.indexOf(rarity) < rarityOrder.indexOf(lowestRarity))
        lowestRarity = rarity;
    }
  }

  const totalNormalized = totalValue / MAX_NORMALIZED;
  const rarityCfg = await HeroConfig.findOne({ rarity: lowestRarity });
  const teamModifier = rarityCfg ? rarityCfg.teamModifier : 0.15;

  return totalNormalized * (1 - teamModifier) + teamModifier;
}

// ============================================================
// 💾 Save DailyEarning
// ============================================================
async function saveDailyEarning(result: IDailyEarningPayload, walletAddress: string) {
  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());

  await DailyEarning.findOneAndUpdate(
    {
      walletAddress,
      date: { $gte: todayStart, $lte: todayEnd },
    },
    {
      $set: {
        rank: result.rank,
        winStreak: result.winStreak,
        heroesUsed: result.heroes,
      },
      $inc: {
        totalFragment: result.totalFragment,
        totalDailyEarning: result.totalDaily,
      },
    },
    { upsert: true, new: true }
  );
}

// ============================================================
// 🛡️ NFT Integrity Check
// ============================================================
async function verifyNftIntegrity(nft: any): Promise<void> {
  console.log("──────────────────────────────────────────────");
  console.log(`🔍 Verifying NFT Integrity: ${nft.name}`);
  console.log(`🔑 Mint Address: ${nft.mintAddress}`);
  console.log("──────────────────────────────────────────────");

  // === 1️⃣ Ambil data NFT original dari DB
  const original = await Nft.findOne({ mintAddress: nft.mintAddress })
    .populate({ path: "character", model: "Character" })
    .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } });

  if (!original) {
    console.error("❌ NFT tidak ditemukan di database!");
    throw new Error(`NFT ${nft.name} not found or invalid mintAddress`);
  }

  // === 2️⃣ Validasi karakter
  const char = original.character as any;
  if (!char || typeof char !== "object" || !("baseHp" in char)) {
    console.error("❌ Character blueprint hilang atau tidak valid:", char);
    throw new Error(`NFT ${nft.name} missing or invalid character blueprint`);
  }

  console.log("🧬 Character Blueprint Loaded:");
  console.table({
    Name: char.name || "-",
    baseHp: char.baseHp,
    baseAtk: char.baseAtk,
    baseDef: char.baseDef,
    baseSpd: char.baseSpd,
    baseCritRate: char.baseCritRate,
    baseCritDmg: char.baseCritDmg,
  });

  // === 3️⃣ Hitung bonus dari rune
  const equipped = (original.equipped || []) as any[];
  const bonus = { hp: 0, atk: 0, def: 0, spd: 0, critRate: 0, critDmg: 0 };

  if (equipped.length > 0) {
    console.log(`💎 Equipped Runes (${equipped.length}):`);
    for (const [i, e] of equipped.entries()) {
      const rune = e?.rune as any;
      if (!rune) continue;
      console.log(`   #${i + 1}: ${rune.name || "Unknown Rune"}`);
      console.table({
        hpBonus: rune.hpBonus ?? 0,
        atkBonus: rune.atkBonus ?? 0,
        defBonus: rune.defBonus ?? 0,
        spdBonus: rune.spdBonus ?? 0,
        critRateBonus: rune.critRateBonus ?? 0,
        critDmgBonus: rune.critDmgBonus ?? 0,
      });

      bonus.hp += rune.hpBonus ?? 0;
      bonus.atk += rune.atkBonus ?? 0;
      bonus.def += rune.defBonus ?? 0;
      bonus.spd += rune.spdBonus ?? 0;
      bonus.critRate += rune.critRateBonus ?? 0;
      bonus.critDmg += rune.critDmgBonus ?? 0;
    }
  } else {
    console.log("💤 Tidak ada rune yang terpasang.");
  }

  console.log("📊 Total Rune Bonus:");
  console.table(bonus);

  // === 4️⃣ Fungsi bantu
  const safe = (v: number) => (Number.isFinite(v) ? v : 0);
  const check = (label: string, base: number, actual: number, bonusVal = 0) => {
    const allowed = base + bonusVal + Math.max(5, base * 0.05);
    console.log(
      `🔹 Check [${label.toUpperCase()}]: base=${base}, bonus=${bonusVal}, actual=${actual}, allowed≤${allowed}`
    );
    if (actual > allowed) {
      console.error(
        `🚨 Cheat detected → ${label}=${actual} > allowed=${allowed} (base=${base}, bonus=${bonusVal})`
      );
      throw new Error(
        `Cheat detected on ${nft.name}: ${label}=${actual} > allowed=${allowed}`
      );
    }
  };

  // === 5️⃣ Jalankan semua pengecekan
  check("hp", safe(char.baseHp), safe(nft.hp), safe(bonus.hp));
  check("atk", safe(char.baseAtk), safe(nft.atk), safe(bonus.atk));
  check("def", safe(char.baseDef), safe(nft.def), safe(bonus.def));
  check("spd", safe(char.baseSpd), safe(nft.spd), safe(bonus.spd));
  check("critRate", safe(char.baseCritRate), safe(nft.critRate), safe(bonus.critRate));
  check("critDmg", safe(char.baseCritDmg), safe(nft.critDmg), safe(bonus.critDmg));

  // === 6️⃣ Hasil akhir
  console.log(`✅ NFT integrity OK: ${nft.name}`);
  console.log("──────────────────────────────────────────────");
}

// ============================================================
// ⚔️ Battle Core
// ============================================================
function isAlive(m: any) { return m.hp > 0; }
function getAliveTeam(t: any[]) { return t.filter(isAlive); }
function chooseTarget(team: any[], attacker?: any) {
  const alive = getAliveTeam(team);
  const candidates = attacker ? alive.filter(m => m.id !== attacker.id) : alive;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function calcDamage(a: any, d: any, skill: any) {
  let rawDamage =
    (a.atk * (skill.atkMultiplier || 0)) +
    (a.def * (skill.defMultiplier || 0)) +
    (a.hp * (skill.hpMultiplier || 0));
  let defenseMultiplier = 100 / (100 + d.def);
  let reduced = rawDamage * defenseMultiplier;
  if (reduced < 10) reduced = 10;
  const isCrit = Math.random() < a.critRate;
  if (isCrit) reduced *= (1 + a.critDmg);
  return { damage: Math.round(reduced), isCrit };
}

function chooseSkill(a: any) {
  if (a.cdUlt === 0 && Math.random() < 0.2) { a.cdUlt = 5; return "ultimate"; }
  if (a.cdSkill === 0 && Math.random() < 0.4) { a.cdSkill = 2; return "skill"; }
  return "basic";
}

async function simulateBattle(teamA: any[], teamB: any[]) {
  let turn = 1;
  const log: any[] = [];
  [...teamA, ...teamB].forEach(m => { m.cdSkill = 0; m.cdUlt = 0; });

  while (getAliveTeam(teamA).length && getAliveTeam(teamB).length) {
    const all = [...getAliveTeam(teamA), ...getAliveTeam(teamB)]
      .sort((a, b) => b.spd - a.spd);

    for (const attacker of all) {
      const atkTeam = teamA.includes(attacker) ? teamA : teamB;
      const defTeam = atkTeam === teamA ? teamB : teamA;
      if (!isAlive(attacker) || !getAliveTeam(defTeam).length) continue;

      if (attacker.cdSkill > 0) attacker.cdSkill--;
      if (attacker.cdUlt > 0) attacker.cdUlt--;

      const skillType = chooseSkill(attacker);
      const skill =
        skillType === "skill" ? attacker.skillAttack :
        skillType === "ultimate" ? attacker.ultimateAttack :
        attacker.basicAttack;
      const defender = chooseTarget(defTeam, attacker);
      const result = calcDamage(attacker, defender, skill);

      defender.hp = Math.max(0, defender.hp - result.damage);
      // log.push({
      //   turn, attacker: attacker.name, defender: defender.name,
      //   skill: skill.name, damage: result.damage, isCrit: result.isCrit,
      //   remainingHp: defender.hp, timestamp: new Date(),
      // });

      // console.log(
      //   `Turn ${turn}: ${attacker.name} → ${defender.name} | ${skill.name} | ${result.damage}${result.isCrit ? " (CRIT!)" : ""}`
      // );
      if (defender && typeof defender.hp === "number") {
        log.push({
          attacker: attacker.name,
          defender: defender.name,
          skill: skill.name,
          damage: result.damage,
          isCrit: result.isCrit,
          remainingHp: defender.hp, // ✅ hanya kalau valid
          timestamp: new Date(),
        });

        console.log(
          `Attacker: ${attacker.name} → ${defender.name} | ${skill.name} | ${result.damage}${result.isCrit ? " (CRIT!)" : ""}`
        );
        console.log("🔥 Log count:", log.length);
        console.log("🚨 Missing HP:", log.filter(l => l.remainingHp === undefined));
      }
      turn++;
    }
  }

  const winner = getAliveTeam(teamA).length > 0 ? "teamA" : "teamB";
  console.log(`🏆 Winner: ${winner}`);
  return { winner, log };
}

// ============================================================
// 🚀 API Endpoint /battle/simulate
// ============================================================
router.post("/battle/simulate", async (req, res) => {
  try {
    const { teamAId, teamBId, mode = "pvp" } = req.body;

    console.log("──────────────────────────────────────────────");
    console.log(`🎮 [POST /battle/simulate] Starting battle simulation...`);
    console.log(`🆚 TeamA: ${teamAId} | TeamB: ${teamBId}`);
    console.log(`⚙️ Mode: ${mode}`);
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 🧩 Load Teams & Verify Integrity (Battle-Safe Version)
    // ======================================================
    console.log("──────────────────────────────────────────────");
    console.log("🧩 Loading teams and verifying NFT integrity...");
    console.log(`🆚 TeamA: ${teamAId} | TeamB: ${teamBId}`);
    console.log("──────────────────────────────────────────────");

    const teamA = await Team.findById(teamAId)
      .populate({
        path: "members",
        model: "Nft",
        populate: {
          path: "character",
          model: "Character",
          select:
            "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
        },
      });
    const teamB = await Team.findById(teamBId)
      .populate({
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
      console.error("❌ One or both teams not found!");
      return res.status(404).json({ error: "Team not found" });
    }

    console.log(`✅ TeamA loaded (${teamA.members.length} members)`);
    console.log(`✅ TeamB loaded (${teamB.members.length} members)`);
    console.log("──────────────────────────────────────────────");

    // ✅ Anti-cheat verification (TypeScript + runtime safe)
    for (const [idx, team] of [teamA, teamB].entries()) {
      const teamName = idx === 0 ? "Team A" : "Team B";
      console.log(`🔎 Verifying team integrity for ${teamName}...`);

      if (!team?.members || !Array.isArray(team.members) || team.members.length === 0) {
        console.log(`⚠️ No members found in ${teamName}`);
        continue;
      }

      for (const nftRaw of team.members) {
        try {
          // 🧩 Pastikan nft sudah berupa objek lengkap
          let nft: any;

          if (typeof nftRaw === "object" && "name" in nftRaw) {
            nft = nftRaw;
          } else {
            // Jika belum populate, ambil manual dari DB
            nft = await Nft.findById(nftRaw)
              .populate({
                path: "character",
                model: "Character",
                select:
                  "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
              })
              .populate({
                path: "equipped",
                populate: { path: "rune", model: "Rune" },
              });
          }

          if (!nft) {
            console.log(`⚠️ Skipping null NFT reference in ${teamName}`);
            continue;
          }

          const nftName = nft?.name || `(unknown NFT ${nft?._id})`;
          console.log(`🧬 Verifying NFT integrity → ${nftName}`);

          await verifyNftIntegrity(nft);
        } catch (err: any) {
          console.error(`❌ Failed verifying NFT in ${teamName}:`, err.message);
          throw err;
        }
      }
    }

    console.log("✅ All NFT integrity checks passed");
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 🧠 Setup teams for simulation
    // ======================================================
    const mapMember = (nft: any) => {
      const c = nft.character || {};
      return {
        id: nft._id.toString(),
        mintAddress: nft.mintAddress,
        name: nft.name || c.name,
        hp: nft.hp ?? c.baseHp ?? 100,
        atk: nft.atk ?? c.baseAtk ?? 50,
        def: nft.def ?? c.baseDef ?? 30,
        spd: nft.spd ?? c.baseSpd ?? 10,
        critRate: (nft.critRate ?? c.baseCritRate ?? 0) / 100,
        critDmg: (nft.critDmg ?? c.baseCritDmg ?? 0) / 100,
        basicAttack: c.basicAttack,
        skillAttack: c.skillAttack,
        ultimateAttack: c.ultimateAttack,
      };
    };

    const membersA = (teamA.members as any[]).map(mapMember);
    const membersB = (teamB.members as any[]).map(mapMember);

    console.log(`⚔️ Starting battle simulation between ${teamAId} and ${teamBId}...`);

    // ======================================================
    // 🎲 Run simulation logic
    // ======================================================
    const { winner, log } = await simulateBattle(membersA, membersB);
    console.log(`🏁 Simulation complete → Winner: ${winner}`);
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 💾 Save Battle Record
    // ======================================================
    const battle = await Battle.create({
      players: [
        { user: teamA.owner, team: teamA._id, isWinner: winner === "teamA" },
        { user: teamB.owner, team: teamB._id, isWinner: winner === "teamB" },
      ],
      mode,
      result: "end_battle",
      log,
    });

    console.log(`✅ Battle created with ID: ${battle._id}`);

    // ======================================================
    // 💰 Process Earnings
    // ======================================================
    if (battle.result === "end_battle") {
      console.log("🎯 Processing battle rewards...");
      for (const p of battle.players) {
        const walletAddress = p.user;
        const isWinner = p.isWinner;
        console.log(`🏁 Player ${walletAddress} → ${isWinner ? "WINNER" : "LOSER"}`);

        const teamId = p.team?._id || p.team;
        const economicFragment = await calculateEconomicFragment(teamId);
        console.log(`💰 Economic Fragment: ${economicFragment.toFixed(4)}`);

        const lastEarning = await DailyEarning.findOne({ walletAddress }).sort({ createdAt: -1 });
        const playerRank = lastEarning?.rank || "sentinel";
        const rankModifier = await getRankModifier(playerRank);
        const winStreak = isWinner ? (lastEarning?.winStreak || 0) + 1 : 0;

        const WINRATE_MODIFIER: Record<number, number> = {
          1: 0.01, 2: 0.05, 3: 0.07, 4: 0.09, 5: 0.11,
          6: 0.13, 7: 0.15, 8: 0.17, 9: 0.21,
        };

        const skillFragment =
          (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0.21) * 100;
        const booster = winStreak >= 3 ? 2 : 1;
        const totalFragment = economicFragment * skillFragment * booster * rankModifier;
        const totalDaily = totalFragment * 10;

        console.log(`📈 WinStreak=${winStreak} | Booster=${booster}`);
        console.log(`⚙️  SkillFrag=${skillFragment} | RankMod=${rankModifier}`);
        console.log(`💎 TotalFragment=${totalFragment.toFixed(2)} | TotalDaily=${totalDaily.toFixed(2)}`);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastGame = await MatchEarning.findOne({
          walletAddress,
          createdAt: { $gte: today },
        }).sort({ createdAt: -1 });
        const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

        const matchResult = await MatchEarning.updateOne(
          { walletAddress, gameNumber: nextGameNumber },
          {
            $setOnInsert: {
              winCount: isWinner ? 1 : 0,
              skillFragment,
              economicFragment,
              booster,
              rankModifier,
              totalFragment,
              createdAt: new Date(),
            },
          },
          { upsert: true }
        );

        if (matchResult.upsertedCount > 0) {
          console.log(`✅ MatchEarning created: ${walletAddress} | Game #${nextGameNumber}`);
        } else {
          console.log(`⚠️ Skipped duplicate MatchEarning for ${walletAddress} | Game #${nextGameNumber}`);
        }

        await Player.findOneAndUpdate(
          { walletAddress: walletAddress },
          {
            $inc: { totalEarning: totalFragment },
            $set: { lastActive: new Date() },
          },
          { upsert: false }
        );
        console.log(`🧾 Player updated: ${walletAddress} (+${totalFragment.toFixed(2)} fragments)`);

        await saveDailyEarning(
          {
            rank: playerRank,
            winStreak,
            totalFragment,
            totalDaily,
            heroes:
              p.team && typeof p.team === "object" && "members" in p.team
                ? (p.team.members as any[])
                : [],
          },
          walletAddress
        );
        console.log(`📅 DailyEarning updated for ${walletAddress}`);

        // 🟢 Broadcast ke semua client
        broadcast({
          type: "battle_reward",
          walletAddress,
          rank: playerRank,
          totalFragment,
          totalDaily,
          winStreak,
          booster,
          isWinner,
          battleId: battle._id,
          time: new Date().toISOString(),
        });

        console.log(`📢 Broadcasted battle_reward for ${walletAddress}`);
        console.log("-----------------------------------");
      }
    }

    console.log(`✅ Simulation finished and saved as Battle: ${battle._id}`);
    console.log("──────────────────────────────────────────────");

    res.status(201).json({
      success: true,
      message: "Battle simulated securely (NFT verified)",
      battle,
    });
  } catch (err: any) {
    console.error("🚫 Error simulate battle:", err.message);
    console.log("──────────────────────────────────────────────");
    res.status(403).json({
      error: "NFT integrity failed or simulation error",
      details: err.message,
    });
  }
});

export default router;
