import fs from "fs";
import path from "path";
import { Nft, INft } from "../models/Nft";

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
 * @param idOrMint MongoDB _id atau mintAddress
 * @param outputDir local dir on VPS
 * @param byMint kalau true → cari NFT pakai mintAddress
 */
export async function generateNftMetadata(
  idOrMint: string,
  outputDir: string,
  byMint = false
): Promise<MetadataResult> {
  try {
    // === 1. Fetch NFT dengan refs ===
    const nft: INft | null = byMint
      ? await Nft.findOne({ mintAddress: idOrMint })
          .populate("character")
          .populate("rune")
          .populate("equipped")
      : await Nft.findById(idOrMint)
          .populate("character")
          .populate("rune")
          .populate("equipped");

    if (!nft) throw new Error("NFT not found");

    const character: any = nft.character;
    const rune: any = nft.rune;

    // === 2. Handle equipped runes ===
    let runeAttributes: any[] = [];
    if (Array.isArray(nft.equipped) && nft.equipped.length > 0) {
      const runeNfts = await Nft.find({ _id: { $in: nft.equipped } }).populate("rune");
      runeAttributes = runeNfts.map((runeNft: any, idx: number) => ({
        trait_type: `Equipped Rune #${idx + 1}`,
        value: runeNft.rune?.name || runeNft.name,
      }));
    }

    // === 3. Tentukan image ===
    let finalImage = nft.image || "";
    if (!finalImage) {
      if (character?.image) finalImage = character.image;
      else if (rune?.image) finalImage = rune.image;
      else finalImage = "https://api.universeofgamers.io/assets/placeholder.png";
    }

    // === 4. Tentukan description ===
    const finalDescription =
      nft.description ||
      character?.description ||
      rune?.description ||
      `${nft.name || character?.name || rune?.name || "Unknown NFT"} — a digital collectible from Universe of Gamers.`;

    // === 5. Build metadata JSON ===
    const finalName = nft.name || character?.name || rune?.name || "Unknown NFT";
    const metadata = {
      name: finalName,
      symbol: "UOGNFT",
      description: finalDescription,
      image: finalImage,
      seller_fee_basis_points: 500,
      external_url: `https://marketplace.universeofgamers.io/nft/${nft.mintAddress}`,

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
        ...(character?.rarity ? [{ trait_type: "Rarity", value: character.rarity }] : []),
        ...runeAttributes,
      ].filter(Boolean),

      properties: {
        files: [{ uri: finalImage, type: "image/jpg" }],
        category: "image",
        creators: [
          {
            address: nft.owner,
            verified: true,
            share: 100,
          },
        ],
      },
    };

    // === 6. Ensure output dir exists ===
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // === 7. Save metadata JSON pakai mintAddress.json ===
    const filePath = path.join(outputDir, `${nft.mintAddress}.json`);
    fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));

    console.log(
      `✅ Metadata for NFT ${nft.mintAddress} saved to ${filePath}`
    );
    console.log("📦 Metadata snapshot:", {
      name: metadata.name,
      image: metadata.image,
      rarity: character?.rarity,
      element: character?.element,
    });

    return { success: true, path: filePath, metadata };
  } catch (err: any) {
    console.error("❌ Failed to generate metadata:", err.message);
    return { success: false, error: err.message };
  }
}
