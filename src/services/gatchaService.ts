import { Character } from "../models/Character";
import { Rune } from "../models/Rune";
import { Nft } from "../models/Nft";

interface RewardInfo {
  type: "character" | "rune";
  rarity: string;
}

/**
 * Perform one gatcha roll
 * @returns { nft, blueprint, rewardInfo }
 */
// 🎲 Roll satu item (helper tetap sama)
export async function doGatchaRoll(
  pack: any,
  user: string
): Promise<{
  nft: typeof Nft.prototype;
  blueprint: any;
  rewardInfo: RewardInfo;
}> {
  const rewardInfo: RewardInfo = weightedRandom(
    pack.rewards.map((r: any) => ({
      item: { type: r.type, rarity: r.rarity } as RewardInfo,
      weight: r.chance,
    }))
  );

  let blueprint: any;
  if (rewardInfo.type === "character") {
    const result = await Character.aggregate([
      { $match: { rarity: rewardInfo.rarity } },
      { $sample: { size: 1 } }
    ]);
    blueprint = result[0];
  } else {
    const result = await Rune.aggregate([
      { $match: { rarity: rewardInfo.rarity } },
      { $sample: { size: 1 } }
    ]);
    blueprint = result[0];
  }

  if (!blueprint) {
    throw new Error(
      `No blueprint for ${rewardInfo.type} rarity=${rewardInfo.rarity}`
    );
  }

  const nft = new Nft({
    owner: user,
    name: blueprint.name,
    description: blueprint.description,
    image: blueprint.image,
    price: 0,
    royalty: 0,
    character: rewardInfo.type === "character" ? blueprint._id : undefined,
    rune: rewardInfo.type === "rune" ? blueprint._id : undefined,
    level: 1,
    exp: 0,
    hp: rewardInfo.type === "character"
      ? blueprint.baseHp
      : blueprint.hpBonus ?? 1,
    atk: rewardInfo.type === "character"
      ? blueprint.baseAtk
      : blueprint.atkBonus ?? 0,
    def: rewardInfo.type === "character"
      ? blueprint.baseDef
      : blueprint.defBonus ?? 0,
    spd: rewardInfo.type === "character"
      ? blueprint.baseSpd
      : blueprint.spdBonus ?? 0,
    critRate: rewardInfo.type === "character"
      ? blueprint.baseCritRate ?? 0
      : blueprint.critRateBonus ?? 0,
    critDmg: rewardInfo.type === "character"
      ? blueprint.baseCritDmg ?? 0
      : blueprint.critDmgBonus ?? 0,
    mintAddress: null,
  });

  return { nft, blueprint, rewardInfo };
}

// 🎁 Roll banyak sekaligus
export async function doMultiGatchaRolls(
  pack: any,
  user: string,
  count: number
): Promise<
  { nft: typeof Nft.prototype; blueprint: any; rewardInfo: RewardInfo }[]
> {
  const results = [];
  for (let i = 0; i < count; i++) {
    const roll = await doGatchaRoll(pack, user);

    if (roll.nft.character) {
      await roll.nft.populate("character");
    } else if (roll.nft.rune) {
      await roll.nft.populate("rune");
    }

    results.push(roll);
  }
  return results;
}

/**
 * Weighted RNG helper
 */
function weightedRandom<T>(items: { item: T; weight: number }[]): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let rand = Math.random() * total;

  for (const { item, weight } of items) {
    if (rand < weight) return item;
    rand -= weight;
  }
  return items[0].item;
}
