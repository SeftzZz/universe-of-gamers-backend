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
  console.log("──────────────────────────────────────────────");
  console.log("🔧 [getRankModifier] Fetching rank modifier...");
  console.log(`🎖️ Requested Rank: ${rank}`);

  const rankDoc = await RankConfig.findOne({ rank: rank.toLowerCase() });

  if (rankDoc) {
    console.log(`✅ Rank found in DB → ${rankDoc.rank}`);
    console.log(`💠 Modifier Value: ${rankDoc.modifier}`);
    console.log("──────────────────────────────────────────────");
    return rankDoc.modifier;
  } else {
    console.warn(`⚠️ Rank not found in RankConfig: ${rank}`);
    console.log("🧩 Fallback Modifier: 0 (default)");
    console.log("──────────────────────────────────────────────");
    return 0;
  }
}

// ============================================================
// 💰 Economic Fragment Calculator (with Character Rarity)
// ============================================================
export async function calculateEconomicFragment(
  teamId: Types.ObjectId | string
): Promise<number> {
  console.log("──────────────────────────────────────────────");
  console.log("💰 [calculateEconomicFragment] Starting calculation...");
  console.log(`🧩 Team ID: ${teamId}`);

  // 🧠 Populate members + their character
  const team = await Team.findById(teamId)
    .populate({
      path: "members",
      populate: {
        path: "character",
        model: "Character",
        select: "name rarity baseHp baseAtk baseDef baseSpd",
      },
    });

  if (!team || !team.members || team.members.length === 0) {
    console.warn(`⚠️ Team not found or has no members: ${teamId}`);
    console.log("──────────────────────────────────────────────");
    return 0;
  }

  const MAX_NORMALIZED = 37500 * 3;
  let totalValue = 0;
  let lowestRarity: "common" | "rare" | "epic" | "legendary" = "legendary";
  const rarityOrder = ["common", "rare", "epic", "legendary"];

  console.log(`👥 Team Members Count: ${team.members.length}`);

  for (const h of team.members as any[]) {
    const char = h.character;
    const rarity = char?.rarity?.toLowerCase?.() ?? "common";
    const level = h.level ?? 1;

    console.log(`   🦸 Hero: ${h.name || "(Unnamed Hero)"}`);
    console.log(`      ➜ Character: ${char?.name || "Unknown Character"}`);
    console.log(`      ➜ Rarity (from Character): ${rarity}`);
    console.log(`      ➜ Level: ${level}`);

    const config = await HeroConfig.findOne({ rarity });
    if (config) {
      const teamVal = (config.teamValue as Record<number, number>)[level] || 0;
      totalValue += teamVal;

      console.log(`      💎 teamValue(level ${level}): ${teamVal}`);
      console.log(`      ⚙️ teamModifier (rarity ${rarity}): ${config.teamModifier}`);

      if (rarityOrder.indexOf(rarity) < rarityOrder.indexOf(lowestRarity)) {
        lowestRarity = rarity as any;
      }
    } else {
      console.warn(`      ⚠️ No HeroConfig found for rarity: ${rarity}`);
    }
  }

  console.log(`📊 Total Value (sum of teamValue): ${totalValue}`);

  const totalNormalized = totalValue / MAX_NORMALIZED;
  console.log(`📈 Total Normalized: ${totalNormalized.toFixed(6)}`);

  const rarityCfg = await HeroConfig.findOne({ rarity: lowestRarity });
  const teamModifier = rarityCfg ? rarityCfg.teamModifier : 0.15;
  console.log(`🧩 Lowest Rarity: ${lowestRarity} | Team Modifier: ${teamModifier}`);

  const result = totalNormalized * (1 - teamModifier) + teamModifier * 100;
  console.log(`✅ Economic Fragment Result: ${result.toFixed(6)}`);
  console.log("──────────────────────────────────────────────");

  return result;
}

// ============================================================
// 💾 Save DailyEarning
// ============================================================
async function saveDailyEarning(result: IDailyEarningPayload, walletAddress: string) {
  console.log("──────────────────────────────────────────────");
  console.log("💾 [saveDailyEarning] Updating daily record...");
  console.log(`👛 Wallet Address: ${walletAddress}`);
  console.log(`📅 Rank: ${result.rank}`);
  console.log(`🔥 Win Streak: ${result.winStreak}`);
  console.log(`💎 Total Fragment (+): ${result.totalFragment}`);
  console.log(`💰 Total Daily (+): ${result.totalDaily}`);

  const todayStart = startOfDay(new Date());
  const todayEnd = endOfDay(new Date());
  console.log(`🕓 Date Range: ${todayStart.toISOString()} → ${todayEnd.toISOString()}`);

  try {
    const updateResult = await DailyEarning.findOneAndUpdate(
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

    if (updateResult) {
      console.log("✅ DailyEarning successfully updated or created.");
      console.log(`📊 New Total Fragment: ${updateResult.totalFragment}`);
      console.log(`📊 New Total DailyEarning: ${updateResult.totalDailyEarning}`);
    } else {
      console.warn("⚠️ DailyEarning update returned null (unexpected).");
    }
  } catch (err: any) {
    console.error("❌ Error saving DailyEarning:", err.message);
  }

  console.log("──────────────────────────────────────────────");
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
/// ============================================================
// ⚔️ Battle Core
// ============================================================
function isAlive(m: any) {
  return m.hp > 0;
}

function getAliveTeam(t: any[]) {
  return t.filter(isAlive);
}

function chooseTarget(team: any[], attacker?: any) {
  const alive = getAliveTeam(team);
  const candidates = attacker ? alive.filter(m => m.id !== attacker.id) : alive;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  console.log(`🎯 [Target Selection] ${attacker?.name || "Unknown"} → ${target?.name}`);
  return target;
}

// ============================================================
// 💥 Damage Calculation
// ============================================================
function calcDamage(a: any, d: any, skill: any) {
  console.log("──────────────────────────────────────────────");
  console.log(`⚔️ [calcDamage] ${a.name} attacks ${d.name} using ${skill.name}`);

  const atkMultiplier = skill.atkMultiplier || 0;
  const defMultiplier = skill.defMultiplier || 0;
  const hpMultiplier = skill.hpMultiplier || 0;

  let rawDamage = (a.atk * atkMultiplier) + (a.def * defMultiplier) + (a.hp * hpMultiplier);
  console.log(`📊 Raw Damage = (ATK:${a.atk}×${atkMultiplier}) + (DEF:${a.def}×${defMultiplier}) + (HP:${a.hp}×${hpMultiplier}) = ${rawDamage.toFixed(2)}`);

  const defenseMultiplier = 100 / (100 + d.def);
  let reduced = rawDamage * defenseMultiplier;
  console.log(`🛡️ Defense Multiplier: ${defenseMultiplier.toFixed(3)} | Reduced Damage: ${reduced.toFixed(2)}`);

  if (reduced < 10) {
    console.log("⚠️ Minimum damage applied (10)");
    reduced = 10;
  }

  const critChance = a.critRate;
  const isCrit = Math.random() < critChance;
  if (isCrit) {
    const critMult = 1 + a.critDmg;
    reduced *= critMult;
    console.log(`💥 CRITICAL HIT! Damage ×${critMult} = ${reduced.toFixed(2)}`);
  } else {
    console.log(`🎯 Normal hit (${(critChance * 100).toFixed(1)}% crit chance)`);
  }

  const finalDamage = Math.round(reduced);
  console.log(`✅ Final Damage Output: ${finalDamage}`);
  console.log("──────────────────────────────────────────────");

  return { damage: finalDamage, isCrit };
}

// ============================================================
// 🌀 Skill Selection Logic
// ============================================================
function chooseSkill(a: any) {
  if (a.cdUlt === 0 && Math.random() < 0.2) {
    a.cdUlt = 5;
    console.log(`🌀 ${a.name} uses ULTIMATE SKILL!`);
    return "ultimate";
  }
  if (a.cdSkill === 0 && Math.random() < 0.4) {
    a.cdSkill = 2;
    console.log(`💫 ${a.name} uses ACTIVE SKILL!`);
    return "skill";
  }
  console.log(`🔹 ${a.name} uses BASIC ATTACK`);
  return "basic";
}

// ============================================================
// 🧠 Battle Simulation
// ============================================================
async function simulateBattle(teamA: any[], teamB: any[]) {
  console.log("============================================================");
  console.log("🔥 [simulateBattle] Battle started!");
  console.log(`👥 Team A: ${teamA.map(m => m.name).join(", ")}`);
  console.log(`👥 Team B: ${teamB.map(m => m.name).join(", ")}`);
  console.log("============================================================");

  let turn = 1;
  const log: any[] = [];
  [...teamA, ...teamB].forEach(m => { m.cdSkill = 0; m.cdUlt = 0; });

  while (getAliveTeam(teamA).length && getAliveTeam(teamB).length) {
    console.log(`\n⚡ TURN ${turn} START`);
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
      const prevHp = defender.hp;
      const result = calcDamage(attacker, defender, skill);

      defender.hp = Math.max(0, defender.hp - result.damage);

      log.push({
        turn,
        attacker: attacker.name,
        defender: defender.name,
        skill: skill.name,
        damage: result.damage,
        isCrit: result.isCrit,
        remainingHp: defender.hp,
        timestamp: new Date(),
      });

      console.log(`💥 Turn ${turn}: ${attacker.name} → ${defender.name}`);
      console.log(`   Skill: ${skill.name} | Damage: ${result.damage}${result.isCrit ? " (CRIT!)" : ""}`);
      console.log(`   HP: ${prevHp} → ${defender.hp}`);
      console.log(`🔥 Total Logs So Far: ${log.length}`);
      console.log("-----------------------------------");

      turn++;
    }
  }

  const winner = getAliveTeam(teamA).length > 0 ? "teamA" : "teamB";
  console.log("============================================================");
  console.log(`🏆 BATTLE END — Winner: ${winner.toUpperCase()}`);
  console.log(`🕐 Total Turns: ${turn - 1}`);
  console.log(`📜 Total Logs Recorded: ${log.length}`);
  console.log("============================================================");

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
      console.log("🎯 Battle marked as END — processing rewards...");
      
      for (const p of battle.players) {
        const walletAddress = p.user;
        const isWinner = p.isWinner;
        console.log(`🏁 Processing player: ${walletAddress} (${isWinner ? "WINNER" : "LOSER"})`);

        // ❌ Kalau kalah → lewati reward total
        if (!isWinner) {
          console.log(`🚫 ${walletAddress} lost — no rewards granted.`);
          continue;
        }

        // ✅ Kalau menang, baru proses reward
        const teamId = p.team?._id || p.team;
        const economicFragment = await calculateEconomicFragment(teamId);
        console.log(`💰 Economic Fragment: ${economicFragment}`);

        const lastEarning = await DailyEarning.findOne({ walletAddress }).sort({ createdAt: -1 });
        const playerRank = lastEarning?.rank || "sentinel";
        const rankModifier = await getRankModifier(playerRank);
        console.log(`🎖️ Rank: ${playerRank} | Rank Modifier: ${rankModifier}`);

        const winStreak = (lastEarning?.winStreak || 0) + 1;
        const WINRATE_MODIFIER: Record<number, number> = {
          0: 0.0,  // kalah = 0
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
        const skillFragment = (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0);
        const booster = winStreak >= 3 ? 2 : 1;

        // 🔹 Global reward multiplier (tanpa ubah config DB)
        const totalFragment = economicFragment * skillFragment * booster * rankModifier;
        const totalDaily = totalFragment;

        console.log(`📈 Win Streak: ${winStreak}`);
        console.log(`⚙️ Skill Fragment: ${skillFragment}`);
        console.log(`⚙️ Booster: ${booster}`);
        console.log(`💎 Total Fragment: ${totalFragment}`);
        console.log(`💰 Total Daily: ${totalDaily}`);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const lastGame = await MatchEarning.findOne({
          walletAddress,
          createdAt: { $gte: today },
        }).sort({ createdAt: -1 });
        const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

        await MatchEarning.updateOne(
          { walletAddress, gameNumber: nextGameNumber },
          {
            $setOnInsert: {
              winCount: 1,
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

        await Player.findOneAndUpdate(
          { walletAddress },
          { $inc: { totalEarning: totalFragment }, $set: { lastActive: new Date() } }
        );

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
