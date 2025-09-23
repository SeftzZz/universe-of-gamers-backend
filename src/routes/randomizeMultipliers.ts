import mongoose from "mongoose";
import { Character, ICharacter } from "../models/Character";

// batas multiplier per rarity
const rarityCaps: Record<ICharacter["rarity"], number> = {
  Common: 1.0,
  Rare: 1.5,
  Epic: 2.5,
  Legendary: 3.0,
};

// fungsi random float 0.1 – max
function getRandomMultiplier(max: number) {
  const min = 0.1;
  return +(Math.random() * (max - min) + min).toFixed(2); // 2 decimal
}

async function randomizeMultipliers() {
  await mongoose.connect("mongodb://root:20Advisia25%40@35.239.11.143:27017/universeofgamers?authSource=admin"); // ganti dengan URI kamu

  const characters = await Character.find();

  for (const char of characters) {
    const cap = rarityCaps[char.rarity] || 1.0;

    // union type → typescript friendly
    (["basicAttack", "skillAttack", "ultimateAttack"] as const).forEach(field => {
      const skill = char[field];
      if (skill) {
        skill.atkMultiplier = getRandomMultiplier(cap);
        skill.defMultiplier = getRandomMultiplier(cap);
        skill.hpMultiplier = getRandomMultiplier(cap);
      }
    });

    await char.save();
    console.log(`✅ Updated multipliers for ${char.name} (${char.rarity})`);
  }

  await mongoose.disconnect();
}

randomizeMultipliers().catch(err => {
  console.error("❌ Error randomizing multipliers:", err);
  process.exit(1);
});
