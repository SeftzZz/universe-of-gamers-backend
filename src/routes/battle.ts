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
import { Nft } from "../models/Nft";               // ✅ untuk verifikasi NFT
import { ICharacter } from "../models/Character";
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
async function calculateEconomicFragment(
  teamId: Types.ObjectId | string
): Promise<number> {
  console.log("──────────────────────────────────────────────");
  console.log("💰 [calculateEconomicFragment] Starting calculation...");
  console.log(`🧩 Team ID: ${teamId}`);

  const team = await Team.findById(teamId).populate({
    path: "members",
    populate: {
      path: "character",
      model: "Character",
      select: "name rarity baseHp baseAtk baseDef baseSpd",
    },
  });

  if (!team || !team.members?.length) {
    console.warn(`⚠️ Team not found or has no members: ${teamId}`);
    console.log("──────────────────────────────────────────────");
    return 0;
  }

  const MAX_NORMALIZED = 3125000 * 3;
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
    console.log(`      ➜ Rarity: ${rarity}`);
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
  const teamModifierRaw = rarityCfg?.teamModifier ?? 0; // 0.10
  const teamModifier = teamModifierRaw * 100; // 10
  console.log(`🧩 Lowest Rarity: ${lowestRarity} | Team Modifier: ${teamModifier.toFixed(3)}`);
  // Formula disesuaikan agar tetap normal
  const result = Math.min(
    100,
    Math.max(
      0,
      ((totalNormalized * (1 - teamModifierRaw)) + teamModifierRaw) * 100
    )
  );

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

// =====================================================
// 🛡️ Helper: Verifikasi Integritas NFT
// =====================================================
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

// =====================================================
// 🎮 API ROUTES
// =====================================================

/**
 * CREATE new battle
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
 */
router.get("/battle", async (req, res) => {
  try {
    const filter: any = {};
    if (req.query.user) filter["players.user"] = req.query.user;
    if (req.query.mode) filter.mode = req.query.mode;
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
 * ✅ Tambahkan verifikasi integritas NFT
 */
router.put("/battle/:id", async (req, res) => {
  try {
    const { result, players, attacker, defender, skill, damage, isCrit } = req.body;
    const battleId = req.params.id;

    // ======================================================
    // ⚔️ UPDATE BATTLE RESULT
    // ======================================================
    if (result || players) {
      console.log("──────────────────────────────────────────────");
      console.log(`⚔️ [PUT /battle/${battleId}] Starting update...`);
      console.log(`🧩 Result: ${result || "N/A"}`);
      console.log(`👥 Players in request: ${players ? players.length : 0}`);

      const updateData: Record<string, any> = {};
      if (result) updateData.result = result;
      if (players) updateData.players = players;

      const battle = await Battle.findByIdAndUpdate(battleId, updateData, { new: true })
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

      if (!battle) {
        console.error("❌ Battle not found:", battleId);
        return res.status(404).json({ error: "Battle not found" });
      }

      console.log(`✅ Battle found → ${battle._id}`);
      console.log(`📊 Players count: ${battle.players.length}`);
      console.log("──────────────────────────────────────────────");

      // ✅ Anti-cheat verification
      for (const p of battle.players) {
        const walletAddress = p.user;
        console.log(`🔎 Verifying team integrity for player: ${walletAddress}`);

        const team: any =
          p.team && typeof p.team === "object" && "members" in p.team
            ? p.team
            : await Team.findById(p.team).populate({
                path: "members",
                model: "Nft",
                populate: { path: "character", model: "Character" },
              });

        if (team?.members && Array.isArray(team.members)) {
          for (const nft of team.members) {
            console.log(`🧬 Verifying NFT integrity → ${nft.name}`);
            await verifyNftIntegrity(nft);
          }
        }
      }

      console.log("✅ All NFT integrity checks passed");
      console.log("──────────────────────────────────────────────");

      // ===================================================
      // Jika Battle selesai → Proses reward/earning
      // ===================================================
      if (result === "end_battle") {
        console.log("🎯 Battle marked as END — processing rewards...");

        // 🔹 Helper format angka seperti di Excel (koma desimal, tanpa scaling)
        function formatExcel(value: number): string {
          return value.toLocaleString("id-ID", {
            minimumFractionDigits: 6,
            maximumFractionDigits: 9,
          });
        }

        for (const p of battle.players) {
          const walletAddress = p.user;
          const isWinner = p.isWinner;
          console.log(`🏁 Processing player: ${walletAddress} (${isWinner ? "WINNER" : "LOSER"})`);

          // ❌ Kalau kalah → tidak dapat apa-apa
          if (!isWinner) {
            console.log(`🚫 ${walletAddress} lost — no rewards granted.`);
            console.log("-----------------------------------");
            continue;
          }

          // ✅ Kalau menang, baru proses reward
          const teamId = p.team?._id || p.team;
          const economicFragment = await calculateEconomicFragment(teamId);
          console.log(`💰 Economic Fragment: ${formatExcel(economicFragment)}`);

          const lastEarning = await DailyEarning.findOne({ walletAddress }).sort({ createdAt: -1 });
          const playerRank = lastEarning?.rank || "sentinel";
          const rankModifier = await getRankModifier(playerRank);
          console.log(`🎖️ Rank: ${playerRank} | Rank Modifier: ${formatExcel(rankModifier)}`);

          const winStreak = (lastEarning?.winStreak || 0) + 1;
          const WINRATE_MODIFIER: Record<number, number> = {
            1: 0.01, 2: 0.05, 3: 0.07, 4: 0.09, 5: 0.11,
            6: 0.13, 7: 0.15, 8: 0.17, 9: 0.21,
          };
          const skillFragment = (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0);
          const booster = winStreak >= 3 ? 2 : 1;

          const totalFragment = economicFragment * skillFragment * booster * rankModifier;
          const totalDaily = totalFragment;

          console.log(`📈 Win Streak: ${winStreak}`);
          console.log(`⚙️ Skill Fragment: ${formatExcel(skillFragment)}`);
          console.log(`⚙️ Booster: ${booster}`);
          console.log(`💎 Total Fragment: ${formatExcel(totalFragment)}`);
          console.log(`💰 Total Daily: ${formatExcel(totalDaily)}`);

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

          if (matchResult.upsertedCount > 0) {
            console.log(`✅ MatchEarning created: ${walletAddress} | Game #${nextGameNumber}`);
          } else {
            console.log(`⚠️ Skipped duplicate MatchEarning for ${walletAddress} | Game #${nextGameNumber}`);
          }

          await Player.findOneAndUpdate(
            { walletAddress },
            { $inc: { totalEarning: totalFragment }, $set: { lastActive: new Date() } },
            { upsert: false }
          );

          console.log(`🧾 Player updated: ${walletAddress} | +${formatExcel(totalFragment)} fragments`);

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

      // 🔊 Broadcast update battle ke semua client
      broadcast({
        type: "battle_updated",
        battleId,
        result,
        battle,
        time: new Date().toISOString(),
      });
      console.log(`✅ Battle ${battleId} updated and broadcasted.`);
      console.log("──────────────────────────────────────────────");

      return res.status(200).json({
        success: true,
        message: "Battle updated and earnings processed (NFT verified)",
        battle,
      });
    }

    // ======================================================
    // 🧩 APPEND VERIFIED BATTLE LOG
    // ======================================================
    if (attacker && defender && skill && damage !== undefined) {
      const battle = await Battle.findById(battleId);
      if (!battle) return res.status(404).json({ error: "Battle not found" });

      const [attackerNft, defenderNft] = await Promise.all([
        Nft.findOne({ name: attacker })
          .populate({ path: "character", model: "Character" })
          .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
        Nft.findOne({ name: defender })
          .populate({ path: "character", model: "Character" })
          .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
      ]);

      if (!attackerNft || !defenderNft)
        return res.status(404).json({ error: "Attacker or defender NFT not found" });

      await verifyNftIntegrity(attackerNft);
      await verifyNftIntegrity(defenderNft);

      const baseDefenderHp = defenderNft.hp ?? (defenderNft.character as ICharacter)?.baseHp ?? 100;
      const prevLogs = battle.log.filter(l => l.defender === defender);
      const lastHp = prevLogs.length > 0 ? prevLogs[prevLogs.length - 1].remainingHp : baseDefenderHp;
      const remainingHp = Math.max(0, lastHp - damage);

      const newLog = {
        attacker,
        defender,
        skill,
        damage,
        isCrit: !!isCrit,
        remainingHp,
        timestamp: new Date(),
      };

      battle.log.push(newLog);
      battle.updatedAt = new Date();
      await battle.save();

      broadcast({
        type: "battle_log_broadcast",
        battleId,
        log: newLog,
      });

      return res.status(200).json({
        success: true,
        message: "Battle log appended (HP computed server-side)",
        log: newLog,
      });
    }

    // Jika tidak ada parameter relevan
    res.status(400).json({ error: "Invalid battle update or log payload" });

  } catch (err: any) {
    console.error("🚫 Error in PUT /battle/:id:", err.message);
    res.status(500).json({ error: err.message });
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
 * APPEND battle log
 */
router.post("/battle/:id/log", async (req, res) => {
  try {
    const { attacker, defender, skill, damage, isCrit } = req.body;

    // 1️⃣ Validasi input dasar
    if (!attacker || !defender || !skill || damage === undefined) {
      return res.status(400).json({ error: "Missing required log fields" });
    }

    // 2️⃣ Cek battle
    const battle = await Battle.findById(req.params.id);
    if (!battle) return res.status(404).json({ error: "Battle not found" });

    // 3️⃣ Ambil NFT attacker & defender dari DB
    const [attackerNft, defenderNft] = await Promise.all([
      Nft.findOne({ name: attacker })
        .populate("character")
        .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
      Nft.findOne({ name: defender })
        .populate("character")
        .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
    ]);

    if (!attackerNft || !defenderNft) {
      return res.status(404).json({ error: "Attacker or defender NFT not found" });
    }

    // 4️⃣ Verifikasi integritas attacker & defender
    await verifyNftIntegrity(attackerNft);
    await verifyNftIntegrity(defenderNft);

    // 5️⃣ Hitung HP dasar defender
    const baseDefenderHp = defenderNft.hp ?? (defenderNft.character as ICharacter)?.baseHp ?? 100;

    // 6️⃣ Ambil HP terakhir defender dari log sebelumnya
    const prevLogs = battle.log.filter(l => l.defender === defender);
    const lastHp =
      prevLogs.length > 0
        ? prevLogs[prevLogs.length - 1].remainingHp
        : baseDefenderHp;

    // 7️⃣ Hitung HP baru (server-side, fair)
    const remainingHp = Math.max(0, lastHp - damage);

    // 8️⃣ Buat log baru
    const newLog = {
      attacker,
      defender,
      skill,
      damage,
      isCrit: !!isCrit,
      remainingHp,
      timestamp: new Date(),
    };

    // 9️⃣ Simpan log ke battle
    battle.log.push(newLog);
    battle.updatedAt = new Date();
    await battle.save();

    // 🔟 Logging server
    console.log("🧩 [BATTLE LOG VERIFIED]");
    console.log(`BattleID=${battle._id}`);
    console.log(`🕹️ ${attacker} ➜ ${defender} | ${skill} | ${damage}${isCrit ? " (CRIT!)" : ""}`);
    console.log(`❤️ HP: ${lastHp} → ${remainingHp}`);
    console.log("-----------------------------------");

    // ✅ Response
    res.status(201).json({
      success: true,
      message: "Battle log verified and appended (HP computed server-side)",
      log: newLog,
    });
  } catch (err: any) {
    console.error("🚫 Error appending verified battle log:", err.message);
    res.status(403).json({
      error: "NFT integrity failed or invalid log data",
      details: err.message,
    });
  }
});

/**
 * GET battle logs only
 */
router.get("/battle/:id/log", async (req, res) => {
  try {
    const battle = await Battle.findById(req.params.id, { log: 1, _id: 0 });
    if (!battle) return res.status(404).json({ error: "Battle not found" });
    res.status(200).json(battle.log);
  } catch (err: any) {
    console.error("❌ Error fetching battle logs:", err.message);
    res.status(500).json({ error: "Failed to fetch battle logs" });
  }
});

export {
  getRankModifier,
  saveDailyEarning,
  verifyNftIntegrity,
  calculateEconomicFragment
};

export default router;