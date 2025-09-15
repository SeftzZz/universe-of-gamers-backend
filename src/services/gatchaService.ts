import { Character } from "../models/Character";
import { Rune } from "../models/Rune";
import { Nft } from "../models/Nft";
import { generateNftMetadata } from "./metadataGenerator";
import path from "path";
import fs from "fs";

interface RewardInfo {
  type: "character" | "rune";
  rarity: string;
}

/**
 * Perform one gatcha roll
 * @returns { nft, blueprint, rewardInfo, metadata }
 */
export async function doGatchaRoll(
  pack: any,
  user: string
): Promise<{
  nft: typeof Nft.prototype;
  blueprint: any;
  rewardInfo: RewardInfo;
  metadata: { path: string; metadata: any };
}> {
  // 1. Tentukan reward
  const rewardInfo: RewardInfo = weightedRandom(
    pack.rewards.map((r: any) => ({
      item: { type: r.type, rarity: r.rarity } as RewardInfo,
      weight: r.chance,
    }))
  );

  // 2. Ambil blueprint
  let blueprint: any;
  if (rewardInfo.type === "character") {
    blueprint = await Character.findOne({ rarity: rewardInfo.rarity });
  } else {
    blueprint = await Rune.findOne({ rarity: rewardInfo.rarity });
  }
  if (!blueprint) {
    throw new Error(
      `No blueprint for ${rewardInfo.type} rarity=${rewardInfo.rarity}`
    );
  }

  // 3. Generate NFT
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
    hp:
      rewardInfo.type === "character"
        ? blueprint.baseHp
        : blueprint.hpBonus ?? 1,
    atk:
      rewardInfo.type === "character"
        ? blueprint.baseAtk
        : blueprint.atkBonus ?? 0,
    def:
      rewardInfo.type === "character"
        ? blueprint.baseDef
        : blueprint.defBonus ?? 0,
    spd:
      rewardInfo.type === "character"
        ? blueprint.baseSpd
        : blueprint.spdBonus ?? 0,
    critRate:
      rewardInfo.type === "character"
        ? blueprint.baseCritRate ?? 0
        : blueprint.critRateBonus ?? 0,
    critDmg:
      rewardInfo.type === "character"
        ? blueprint.baseCritDmg ?? 0
        : blueprint.critDmgBonus ?? 0,
  });
  await nft.save();

  // 4. Tentukan folder metadata dari .env
  const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
  const outputDir = path.join(process.cwd(), baseDir);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // nama file = <idNFT>.json supaya unik
  const filePath = path.join(outputDir, `${nft._id}.json`);

  const metadataResult = await generateNftMetadata(nft._id.toString(), outputDir);

  if (!metadataResult.success) {
    throw new Error(`Failed to generate metadata: ${metadataResult.error}`);
  }

  return {
    nft,
    blueprint,
    rewardInfo,
    metadata: {
      path: filePath,
      metadata: metadataResult.metadata,
    },
  };
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
