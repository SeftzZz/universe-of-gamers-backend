import { Character } from "../models/Character";
import { Rune } from "../models/Rune";
import { Nft } from "../models/Nft";
import { generateNftMetadata } from "./metadataGenerator";
import path from "path";
import fs from "fs";

const METADATA_DIR = path.join(__dirname, "../../metadata");

interface RewardInfo {
  type: "character" | "rune";
  rarity: string;
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
  return items[0].item; // fallback
}

/**
 * Perform one gatcha roll
 * @returns { nft, blueprint, rewardInfo }
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
    throw new Error(`No blueprint for ${rewardInfo.type} rarity=${rewardInfo.rarity}`);
  }

  // 3. Generate NFT
  const nft = new Nft({
    name: blueprint.name,
    description: blueprint.description,
    image: blueprint.image,
    owner: user,
    rarity: rewardInfo.rarity,
    character: rewardInfo.type === "character" ? blueprint._id : undefined,
    rune: rewardInfo.type === "rune" ? blueprint._id : undefined,
    price: 0,
    royalty: 0,
  });
  await nft.save();

  // 4. Metadata JSON
  const outputDir = path.join(__dirname, "../../metadata");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const metadataResult = await generateNftMetadata(nft._id.toString(), outputDir);

  if (!metadataResult.success) {
    throw new Error(`Failed to generate metadata: ${metadataResult.error}`);
  }

  const { path: metaPath, metadata: metaData } = metadataResult;

  return {
    nft,
    blueprint,
    rewardInfo,
    metadata: {
      path: metaPath!,      // ✅ pakai non-null assertion
      metadata: metaData!,
    },
  };

}