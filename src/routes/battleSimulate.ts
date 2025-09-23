import express from "express";
import { Battle } from "../models/Battle";
import { Team } from "../models/Team";

const router = express.Router();

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

    res.status(201).json(battle);
  } catch (err: any) {
    console.error("❌ Error simulate battle:", err.message);
    res.status(500).json({ error: "Failed to simulate battle" });
  }
});

export default router;
