import fs from "fs";
import path from "path";
import { Nft, INft } from "../models/Nft"; // model kamu
import { Character } from "../models/Character";

interface MetadataSuccess {
  success: true;
  path: string;
  metadata: any;
}
interface MetadataError {
  success: false;
  error: any;
}
type MetadataResult = MetadataSuccess | MetadataError;

/**
 * Generate metadata JSON for a given NFT and save to VPS
 * @param nftId MongoDB NFT _id
 * @param outputDir local dir on VPS
 */
export async function generateNftMetadata(nftId: string, outputDir: any) {
  try {
    // === 1. Fetch NFT with character ref ===
    const nft: INft | null = await Nft.findById(nftId).populate("character");
    if (!nft) throw new Error("NFT not found");

    const character: any = nft.character;

    // === 2. Build metadata JSON ===
    const metadata = {
      name: nft.name || character?.name || "Unknown NFT",
      symbol: "UOG",
      description: nft.description || `An NFT character from Universe of Gamers`,
      image: nft.image, // URL or path to image
      seller_fee_basis_points: nft.royalty ?? 500,
      external_url: `https://universeofgamers.io/nft/${nft._id}`,

      attributes: [
        { trait_type: "Character", value: character?.name },
        { trait_type: "Element", value: character?.element },
        { trait_type: "Level", value: nft.level },
        { trait_type: "EXP", value: nft.exp },

        { trait_type: "HP", value: nft.hp },
        { trait_type: "ATK", value: nft.atk },
        { trait_type: "DEF", value: nft.def },
        { trait_type: "SPD", value: nft.spd },
        { trait_type: "Crit Rate", value: nft.critRate + "%" },
        { trait_type: "Crit Dmg", value: nft.critDmg + "%" },

        nft.equipped?.weapon
          ? { trait_type: "Equipped Weapon", value: nft.equipped.weapon }
          : null,
        nft.equipped?.armor
          ? { trait_type: "Equipped Armor", value: nft.equipped.armor }
          : null,
        nft.equipped?.rune
          ? { trait_type: "Equipped Rune", value: nft.equipped.rune }
          : null,
      ].filter(Boolean), // remove nulls

      properties: {
        files: [
          {
            uri: nft.image,
            type: "image/png"
          }
        ],
        category: "image",
        creators: [
          {
            address: nft.owner,
            share: 100
          }
        ]
      }
    };

    // === 3. Ensure output dir exists ===
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // === 4. Save metadata JSON ===
    const filePath = path.join(outputDir, `${nft._id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));

    console.log(`✅ Metadata for NFT ${nft._id} saved to ${filePath}`);
    return { success: true, path: filePath, metadata };
  } catch (err: any) {
    console.error("❌ Failed to generate metadata:", err.message);
    return { success: false, error: err.message };
  }
}
