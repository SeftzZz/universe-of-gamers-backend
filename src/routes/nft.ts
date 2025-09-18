import { Router, Request, Response } from "express";
import multer from "multer";
import { Nft } from "../models/Nft";
import { Character } from "../models/Character";
import { Skill } from "../models/Skill";
import { Rune } from "../models/Rune";
import { Team } from "../models/Team";
import { generateNftMetadata } from "../services/metadataGenerator";
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import Auth from "../models/Auth";

import fs from "fs";
import path from "path";

import dotenv from "dotenv";
dotenv.config();

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const router = Router();
const upload = multer(); // memory storage

router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, description, image, price, royalty, character, owner, txSignature } = req.body;

    if (!owner || !txSignature) throw new Error("Owner & txSignature required");

    const char = await Character.findById(character);
    if (!char) throw new Error("Character not found");

    // assign base stats
    const nft = await Nft.create({
      name,
      description,
      image,
      price,
      royalty,
      character,
      owner,
      txSignature,
      hp: char.baseHp,
      atk: char.baseAtk,
      def: char.baseDef,
      spd: char.baseSpd,
      critRate: char.baseCritRate,
      critDmg: char.baseCritDmg,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.json({ success: true, nft });
  } catch (err: any) {
    console.error("❌ save NFT error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all NFTs
router.get("/fetch-nft", async (req, res) => {
  try {
    const nfts = await Nft.find();
    res.json(nfts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// GET NFTs by owner (only owner can access)
router.get("/my-nfts",authenticateJWT, async (req: AuthRequest, res) => {
  try {
    // Ambil user dari DB
    const user = await Auth.findById(req.user.id).select(
      "wallets custodialWallets"
    );
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Gabungkan semua wallet address (custodial + external)
    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    if (walletAddresses.length === 0) {
      return res.json([]);
    }

    // Cari NFT berdasarkan semua address
    const nfts = await Nft.find({ owner: { $in: walletAddresses } });

    res.json(nfts);
  } catch (err) {
    console.error("❌ Error fetching my NFTs:", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

/**
 * Equip Rune to a Character NFT
 */
router.post("/:characterId/equip-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { runeId } = req.body;

    if (!runeId) return res.status(400).json({ error: "runeId is required" });

    const character = await Nft.findById(characterId);
    if (!character) return res.status(404).json({ error: "Character not found" });

    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    const runeNft = await Nft.findById(runeId).populate("rune");
    if (!runeNft || !runeNft.rune) return res.status(404).json({ error: "Rune not found" });
    if (runeNft.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your rune" });
    }
    if (runeNft.isEquipped) {
      return res.status(400).json({ error: "Rune already equipped" });
    }

    const runeData: any = runeNft.rune;

    // Tambah ke array equipped
    character.equipped.push(runeNft._id);

    // Apply bonus stats
    character.hp += runeData.hpBonus ?? 0;
    character.atk += runeData.atkBonus ?? 0;
    character.def += runeData.defBonus ?? 0;
    character.spd += runeData.spdBonus ?? 0;

    runeNft.isEquipped = true;
    runeNft.equippedTo = character._id;

    await runeNft.save();
    await character.save();

    res.json({ message: "✅ Rune equipped successfully", character });
  } catch (err: any) {
    console.error("❌ Error equipping rune:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Unequip Rune to a Character NFT
 */
router.post("/:characterId/unequip-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { runeId } = req.body;

    if (!runeId) return res.status(400).json({ error: "runeId is required" });

    const character = await Nft.findById(characterId).populate("character");
    if (!character) return res.status(404).json({ error: "Character not found" });

    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    // cek rune ada di equipped array
    if (!character.equipped?.includes(runeId)) {
      return res.status(400).json({ error: "This rune is not equipped on this character" });
    }

    const runeNft = await Nft.findById(runeId).populate("rune");
    if (!runeNft || !runeNft.rune) return res.status(404).json({ error: "Rune not found" });

    const runeData: any = runeNft.rune;

    // Kurangi stats
    character.hp -= runeData.hpBonus ?? 0;
    character.atk -= runeData.atkBonus ?? 0;
    character.def -= runeData.defBonus ?? 0;
    character.spd -= runeData.spdBonus ?? 0;

    // Hapus rune dari equipped array
    character.equipped = character.equipped.filter(
      (id: any) => id.toString() !== runeId
    );

    runeNft.isEquipped = false;
    runeNft.equippedTo = null;

    await runeNft.save();
    await character.save();

    res.json({ message: "✅ Rune unequipped successfully", character });
  } catch (err: any) {
    console.error("❌ Error unequipping rune:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET NFT by ID
router.get("/nft/:id", async (req, res) => {
  try {
    const nft = await Nft.findById(req.params.id);
    if (!nft) return res.status(404).json({ error: "NFT not found" });
    res.json(nft);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFT" });
  }
});

// =====================
// Character Routes
// =====================

// POST Character
router.post("/character", async (req, res) => {
  try {
    const char = await Character.create(req.body);
    res.json({ success: true, data: char });
  } catch (err: any) {
    console.error("❌ Error creating character:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all Characters
router.get("/fetch-character", async (req, res) => {
  try {
    const chars = await Character.find();
    res.json(chars);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch characters" });
  }
});

// GET Character by ID
router.get("/character/:id", async (req, res) => {
  try {
    const char = await Character.findById(req.params.id).populate("runes");
    if (!char) return res.status(404).json({ error: "Character not found" });
    res.json(char);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch character" });
  }
});

// =====================
// Rune Routes
// =====================

// POST Rune
router.post("/rune", async (req, res) => {
  try {
    const rune = await Rune.create(req.body);
    res.json({ success: true, data: rune });
  } catch (err: any) {
    console.error("❌ Error creating rune:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all Runes
router.get("/rune", async (req, res) => {
  try {
    const runes = await Rune.find();
    res.json(runes);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch runes" });
  }
});

// GET Rune by ID
router.get("/rune/:id", async (req, res) => {
  try {
    const rune = await Rune.findById(req.params.id);
    if (!rune) return res.status(404).json({ error: "Rune not found" });
    res.json(rune);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch rune" });
  }
});

// =====================
// Team Routes
// =====================

/**
 * CREATE Team
 * Body: { name: string, owner: string, members: [nftId1, nftId2, nftId3] }
 */
router.post("/team", async (req, res) => {
  try {
    const { name, owner, members } = req.body;

    if (!members || members.length !== 3) {
      return res.status(400).json({ error: "A team must have exactly 3 NFTs" });
    }

    // Validate all NFT IDs exist
    const nfts = await Nft.find({ _id: { $in: members }, owner });
    if (nfts.length !== 3) {
      return res.status(400).json({ error: "Some NFTs are invalid or not owned by this user" });
    }

    const team = new Team({ name, owner, members });
    await team.save();

    res.status(201).json(team);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create team", details: err.message });
  }
});

/**
 * READ All Teams (optionally by owner)
 * Query: ?owner=walletAddress
 */
router.get("/team", async (req, res) => {
  try {
    const { owner } = req.query;
    const filter: any = owner ? { owner } : {};
    const teams = await Team.find(filter).populate("members");
    res.json(teams);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch teams" });
  }
});

/**
 * READ Team by ID
 */
router.get("/team/:id", async (req, res) => {
  try {
    const team = await Team.findById(req.params.id).populate("members");
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.json(team);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch team" });
  }
});

/**
 * UPDATE Team
 * Body: { name?: string, members?: string[] }
 */
router.put("/team/:id", async (req, res) => {
  try {
    const { name, members } = req.body;

    if (members && members.length !== 3) {
      return res.status(400).json({ error: "A team must have exactly 3 NFTs" });
    }

    let updateData: any = {};
    if (name) updateData.name = name;
    if (members) updateData.members = members;

    const team = await Team.findByIdAndUpdate(req.params.id, updateData, {
      new: true
    }).populate("members");

    if (!team) return res.status(404).json({ error: "Team not found" });
    res.json(team);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update team" });
  }
});

/**
 * DELETE Team
 */
router.delete("/team/:id", async (req, res) => {
  try {
    const team = await Team.findByIdAndDelete(req.params.id);
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.json({ message: "Team deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete team" });
  }
});

/**
 * Generate metadata JSON for a given NFT
 * POST /nft/:id/metadata
 * Body (optional): { outputDir: string }
 */
router.post("/nft/:id/metadata", async (req, res) => {
  try {
    const nftId = req.params.id;
    const outputDir = process.env.METADATA_DIR;

    const result = await generateNftMetadata(nftId, outputDir);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      message: "Metadata generated successfully",
      file: result.path,
      metadata: result.metadata
    });
  } catch (err: any) {
    console.error("❌ Error generating metadata:", err.message);
    res.status(500).json({ error: "Failed to generate metadata" });
  }
});

/**
 * GET all NFT metadata
 * GET /nft/metadata
 */
router.get("/nft/metadata", async (req, res) => {
  try {
    const outputDir: string = path.resolve(
      process.env.METADATA_DIR || "uploads/metadata/nft"
    );

    if (!fs.existsSync(outputDir)) {
      return res.status(404).json({ error: "Metadata directory not found" });
    }

    const files: string[] = fs
      .readdirSync(outputDir)
      .filter((f: string) => f.endsWith(".json"));

    if (files.length === 0) {
      return res.status(404).json({ error: "No metadata files found" });
    }

    const allMetadata = files.map((file: string) => {
      const filePath: string = path.join(outputDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return { id: path.basename(file, ".json"), ...content };
    });

    res.status(200).json(allMetadata);
  } catch (err: any) {
    console.error("❌ Error reading all metadata:", err.message);
    res.status(500).json({ error: "Failed to read metadata files" });
  }
});

/**
 * GET single NFT metadata
 * GET /nft/:id/metadata
 */
router.get("/nft/:id/metadata", async (req, res) => {
  try {
    const nftId: string = req.params.id;
    const outputDir: string = path.resolve(
      process.env.METADATA_DIR || "uploads/metadata/nft"
    );
    const filePath: string = path.join(outputDir, `${nftId}.json`);

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .json({ error: "Metadata not found. Please generate it first." });
    }

    const metadata = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.status(200).json(metadata);
  } catch (err: any) {
    console.error("❌ Error reading metadata:", err.message);
    res.status(500).json({ error: "Failed to read metadata" });
  }
});

export default router;
