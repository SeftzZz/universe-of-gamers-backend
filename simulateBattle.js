// === 1. Dummy Data (2 tim, masing-masing 3 karakter) ===
const teamA = [
  { name: "Raka'jin", hp: 1000, atk: 120, def: 50, spd: 80, critRate: 0.2, critDmg: 1.5, cdSkill: 0, cdUlt: 0 },
  { name: "Eld", hp: 900, atk: 100, def: 60, spd: 70, critRate: 0.15, critDmg: 1.4, cdSkill: 0, cdUlt: 0 },
  { name: "Shinen", hp: 800, atk: 130, def: 40, spd: 90, critRate: 0.25, critDmg: 1.6, cdSkill: 0, cdUlt: 0 },
];

const teamB = [
  { name: "Thalmor", hp: 950, atk: 110, def: 55, spd: 85, critRate: 0.18, critDmg: 1.5, cdSkill: 0, cdUlt: 0 },
  { name: "Shinen", hp: 1100, atk: 105, def: 70, spd: 60, critRate: 0.12, critDmg: 1.3, cdSkill: 0, cdUlt: 0 },
  { name: "Raka'jin", hp: 850, atk: 125, def: 45, spd: 95, critRate: 0.22, critDmg: 1.7, cdSkill: 0, cdUlt: 0 },
];

// === 2. Helper functions ===
function isAlive(member) {
  return member.hp > 0;
}

function getAliveTeam(team) {
  return team.filter(isAlive);
}

function calcDamage(attacker, defender, skillType) {
  let baseDamage;

  switch (skillType) {
    case "skill":
      baseDamage = attacker.atk * 1.5 - defender.def * 0.5;
      break;
    case "ultimate":
      baseDamage = attacker.atk * 2.5 - defender.def * 0.5;
      break;
    default: // basic
      baseDamage = attacker.atk - defender.def * 0.5;
  }

  if (baseDamage < 1) baseDamage = 1;

  // Crit check
  if (Math.random() < attacker.critRate) {
    baseDamage *= attacker.critDmg;
    console.log(`💥 CRITICAL HIT by ${attacker.name}!`);
  }
  return Math.floor(baseDamage);
}

function chooseTarget(team) {
  const alive = getAliveTeam(team);
  return alive[Math.floor(Math.random() * alive.length)];
}

function chooseSkill(attacker) {
  if (attacker.cdUlt === 0 && Math.random() < 0.2) { // 20% chance pakai ult
    attacker.cdUlt = 5;
    return "ultimate";
  }
  if (attacker.cdSkill === 0 && Math.random() < 0.4) { // 40% chance pakai skill
    attacker.cdSkill = 2;
    return "skill";
  }
  return "basic";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === 3. Simulasi Pertarungan ===
async function simulateBattleSlow(teamA, teamB) {
  let turn = 1;
  const log = [];

  while (getAliveTeam(teamA).length > 0 && getAliveTeam(teamB).length > 0) {
    const allMembers = [...getAliveTeam(teamA), ...getAliveTeam(teamB)];
    allMembers.sort((a, b) => b.spd - a.spd);

    for (const attacker of allMembers) {
      const attackerTeam = teamA.includes(attacker) ? teamA : teamB;
      const enemyTeam = attackerTeam === teamA ? teamB : teamA;

      if (!isAlive(attacker) || getAliveTeam(enemyTeam).length === 0) continue;

      // Kurangi cooldown dulu
      if (attacker.cdSkill > 0) attacker.cdSkill--;
      if (attacker.cdUlt > 0) attacker.cdUlt--;

      // Pilih skill
      const skill = chooseSkill(attacker);
      const defender = chooseTarget(enemyTeam);
      const damage = calcDamage(attacker, defender, skill);
      defender.hp -= damage;
      if (defender.hp < 0) defender.hp = 0;

      const entry = { turn, attacker: attacker.name, defender: defender.name, skill, damage, remainingHp: defender.hp };
      log.push(entry);

      console.log(`Turn ${turn}: ${attacker.name} uses ${skill} on ${defender.name} for ${damage} dmg (HP left: ${defender.hp})`);
      turn++;

      // Delay biar keliatan
      await sleep(2000);
    }
  }

  const winner = getAliveTeam(teamA).length > 0 ? "Team A" : "Team B";
  console.log(`🏆 Winner: ${winner}`);
  return { winner, log };
}

// === 4. Jalankan simulasi ===
simulateBattleSlow(teamA, teamB);
