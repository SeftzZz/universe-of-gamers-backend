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

import { 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL, 
  Keypair, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  LoadedAddresses,
  AddressLookupTableAccount,
  TransactionInstruction,
  ParsedAccountData,
} from "@solana/web3.js";
import { ComputeBudgetProgram, sendAndConfirmRawTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction, 
  NATIVE_MINT,
  createCloseAccountInstruction,
  getAccount,
  createApproveInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import { getTokenInfo } from "../services/priceService";
import { getMint } from "@solana/spl-token";

import fs from "fs";
import path from "path";

import Redis from "ioredis";
import pLimit from "p-limit";

import dotenv from "dotenv";
dotenv.config();

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const router = Router();
const upload = multer(); // memory storage

// Program ID Metaplex Token Metadata (mainnet)
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// === Helper untuk SPL events ===
function handleSpl(parsed: any, sig: any, tx: any, history: any[]) {
  switch (parsed.type) {
    case "mintTo":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Mint",
        from: null,
        to: parsed.info?.account || null,
        amount: parsed.info?.amount || "1",
      });
      break;

    case "transfer":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Transfer",
        from: parsed.info?.source || null,
        to: parsed.info?.destination || null,
        amount: parsed.info?.amount || "1",
      });
      break;

    case "burn":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Burn",
        from: parsed.info?.account || null,
        to: null,
        amount: parsed.info?.amount || "1",
      });
      break;
  }
}

// 🔑 Redis client
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// ⏱️ Batas concurrency (misalnya max 5 request paralel ke RPC)
const limit = pLimit(5);

// TTL cache (dalam detik)
const CACHE_TTL = 300; // 5 menit

// TTL (detik)
const TTL_METADATA = 86400; // 24 jam
const TTL_LISTING = 60;     // 1 menit

// 🔹 Helper fetch dengan timeout
async function fetchWithTimeout(url: string, ms = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

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

// GET all NFTs langsung dari DB tanpa validasi on-chain
router.get("/fetch-nft", async (req, res) => {
  try {
    console.time("⏱ fetch-nft-total");

    console.time("⏱ DB-find");
    // ✅ Ambil NFT yang sedang dijual dan populate karakter/rune (seperti /my-nfts)
    const nfts = await Nft.find({ isSell: true })
      .populate("character", "name rarity element")
      .populate("rune", "name rarity");
    console.timeEnd("⏱ DB-find");

    console.log(`📦 Total NFT for sale: ${nfts.length}`);

    // ✅ Tidak perlu flatten manual → langsung kirim hasil populate
    res.json(nfts);

    console.timeEnd("⏱ fetch-nft-total");
  } catch (err) {
    console.error("❌ Fetch NFT error (DB only):", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// GET NFTs by owner (only owner can access)
router.get("/my-nfts", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const user = await Auth.findById(req.user.id).select(
      "wallets custodialWallets"
    );
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    if (walletAddresses.length === 0) {
      return res.json([]);
    }

    // ✅ populate karakter (nama, rarity, element)
    const nfts = await Nft.find({ owner: { $in: walletAddresses } })
      .populate("character", "name rarity element")
      .populate("rune", "name rarity");

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

/**
 * Edit (replace) a Rune on a Character NFT
 */
router.post("/:characterId/edit-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { oldRuneId, newRuneId } = req.body;

    if (!oldRuneId || !newRuneId) {
      return res.status(400).json({ error: "oldRuneId and newRuneId are required" });
    }

    // Ambil character
    const character = await Nft.findById(characterId).populate("character");
    if (!character) return res.status(404).json({ error: "Character not found" });
    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    // Pastikan oldRune sedang dipakai
    if (!character.equipped?.includes(oldRuneId)) {
      return res.status(400).json({ error: "Old rune is not equipped on this character" });
    }

    // Ambil rune lama
    const oldRuneNft = await Nft.findById(oldRuneId).populate("rune");
    if (!oldRuneNft || !oldRuneNft.rune) return res.status(404).json({ error: "Old rune not found" });

    // Ambil rune baru
    const newRuneNft = await Nft.findById(newRuneId).populate("rune");
    if (!newRuneNft || !newRuneNft.rune) return res.status(404).json({ error: "New rune not found" });
    if (newRuneNft.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your rune" });
    }
    if (newRuneNft.isEquipped) {
      return res.status(400).json({ error: "New rune is already equipped" });
    }

    const oldRuneData: any = oldRuneNft.rune;
    const newRuneData: any = newRuneNft.rune;

    // 1. Hapus bonus rune lama
    character.hp  -= oldRuneData.hpBonus ?? 0;
    character.atk -= oldRuneData.atkBonus ?? 0;
    character.def -= oldRuneData.defBonus ?? 0;
    character.spd -= oldRuneData.spdBonus ?? 0;

    // 2. Apply bonus rune baru
    character.hp  += newRuneData.hpBonus ?? 0;
    character.atk += newRuneData.atkBonus ?? 0;
    character.def += newRuneData.defBonus ?? 0;
    character.spd += newRuneData.spdBonus ?? 0;

    // 3. Update array equipped
    character.equipped = character.equipped.map((id: any) =>
      id.toString() === oldRuneId ? newRuneNft._id : id
    );

    // 4. Update status rune
    oldRuneNft.isEquipped = false;
    oldRuneNft.equippedTo = null;
    newRuneNft.isEquipped = true;
    newRuneNft.equippedTo = character._id;

    // 5. Save semua perubahan
    await oldRuneNft.save();
    await newRuneNft.save();
    await character.save();

    res.json({ message: "✅ Rune replaced successfully", character });
  } catch (err: any) {
    console.error("❌ Error editing rune:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all NFTs from DB
router.get("/fetch-nftDB", async (req, res) => {
  try {
    const nftdb = await Nft.find();
    res.json(nftdb);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch nft" });
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
 * INIT Teams for all users
 * POST /nft/team/init
 */
router.post("/team/init", async (req: Request, res: Response) => {
  try {
    const users = await Auth.find().select("_id wallets custodialWallets");

    let createdTeams: any[] = [];

    for (const user of users) {
      // ambil alamat wallet utama (kalau punya lebih dari satu, pakai yang pertama)
      const wallet =
        user.wallets?.[0]?.address || user.custodialWallets?.[0]?.address;

      if (!wallet) continue; // skip user tanpa wallet

      for (let i = 1; i <= 8; i++) {
        const teamName = `TEAM#${i}`;

        // cek apakah team ini sudah ada
        const exists = await Team.findOne({ owner: wallet, name: teamName });
        if (exists) continue;

        // buat team baru
        const team = await Team.create({
          name: teamName,
          owner: wallet,
          members: [], // default kosong
        });

        createdTeams.push(team);
      }
    }

    res.json({
      message: "✅ Init teams completed",
      createdCount: createdTeams.length,
      createdTeams,
    });
  } catch (err: any) {
    console.error("❌ Error initializing teams:", err);
    res.status(500).json({ error: err.message });
  }
});

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
 * READ My Teams (hanya tim milik user login)
 */
router.get("/team", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    // 🔐 Ambil user dari DB
    const user = await Auth.findById(req.user.id).select(
      "wallets custodialWallets"
    );
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // 🔗 Gabungkan semua wallet address user
    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    if (walletAddresses.length === 0) {
      return res.json([]); // user belum punya wallet
    }

    // 📦 Filter teams berdasarkan owner
    const teams = await Team.find({ owner: { $in: walletAddresses } })
      .populate("members");

    res.json(teams);
  } catch (err: any) {
    console.error("❌ Failed to fetch teams:", err);
    res.status(500).json({ error: "Failed to fetch teams" });
  }
});

/**
 * Get Active Team
 */
router.get("/team/active", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const user = await Auth.findById(req.user.id).select("wallets custodialWallets");
    if (!user) return res.status(401).json({ error: "User not found" });

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    const team = await Team.findOne({ owner: { $in: walletAddresses }, isActive: true })
      .populate("members");

    if (!team) return res.status(404).json({ error: "No active team" });

    res.json(team);
  } catch (err: any) {
    console.error("❌ Error fetching active team:", err);
    res.status(500).json({ error: "Failed to fetch active team" });
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

    // ✅ Validasi baru: minimal 0, maksimal 3 anggota
    if (members && (members.length < 0 || members.length > 3)) {
      return res.status(400).json({ error: "A team must have between 0 and 3 NFTs" });
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
    console.error("❌ Error updating team:", err.message);
    res.status(500).json({ error: "Failed to update team" });
  }
});

/**
 * Activate a Team (hanya 1 yang boleh aktif)
 */
router.post("/team/:id/activate", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const teamId = req.params.id;

    // Ambil user
    const user = await Auth.findById(req.user.id).select("wallets custodialWallets");
    if (!user) return res.status(401).json({ error: "User not found" });

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    // Nonaktifkan semua team milik user
    await Team.updateMany({ owner: { $in: walletAddresses } }, { $set: { isActive: false } });

    // Aktifkan tim yang dipilih
    const team = await Team.findOneAndUpdate(
      { _id: teamId, owner: { $in: walletAddresses } },
      { $set: { isActive: true } },
      { new: true }
    ).populate("members");

    if (!team) return res.status(404).json({ error: "Team not found or not owned" });

    res.json({ message: "✅ Team activated", team });
  } catch (err: any) {
    console.error("❌ Error activating team:", err);
    res.status(500).json({ error: "Failed to activate team" });
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
router.post("/:id/metadata", async (req, res) => {
  try {
    const nftId = req.params.id;
    const outputDir = process.env.METADATA_DIR || "uploads/metadata/nft";

    const result = await generateNftMetadata(nftId, outputDir);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      message: "Metadata generated successfully",
      file: result.path,
      metadata: result.metadata,
    });
  } catch (err: any) {
    console.error("❌ Error generating metadata:", err.message);
    res.status(500).json({ error: "Failed to generate metadata" });
  }
});

/**
 * GET all NFT metadata
 * GET /metadata
 */
router.get("/metadata", async (req, res) => {
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
 * GET NFT metadata
 * GET /:mintAddress/metadata
 */
router.get("/:mintAddress/metadata", async (req: Request, res: Response) => {
  try {
    const { mintAddress } = req.params;

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const mintPk = new PublicKey(mintAddress);
    
    const filePath = path.join(
      process.cwd(),
      "uploads/metadata/nft",
      `${mintAddress}.json`
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Metadata not found" });
    }

    // Baca & kirim sebagai JSON
    const raw = fs.readFileSync(filePath, "utf-8");
    const metadata = JSON.parse(raw);

    // ✅ Fetch PDA listing (marketplace program)
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });
    const program = new anchor.Program(
      require("../../public/idl/universe_of_gamers.json"),
      new anchor.web3.PublicKey(process.env.PROGRAM_ID!),
      provider
    );

    const [listingPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mintPk.toBuffer()],
      program.programId
    );

    let priceSol: number | null = null;
    try {
      const listing: any = await program.account.listing.fetch(listingPda);
      priceSol = listing.price.toNumber() / anchor.web3.LAMPORTS_PER_SOL;
      console.log("💰 Price fetched from listing:", priceSol);
    } catch (e) {
      console.warn("⚠️ Listing not found on chain, price not available");
    }

    res.setHeader("Content-Type", "application/json");
    return res.json({
      ...metadata,
      price: priceSol, // tambahin field price
    });
  } catch (err: any) {
    console.error("❌ Metadata fetch error:", err.message);
    res.status(500).json({ error: "Failed to load metadata" });
  }
});

/**
 * GET NFT onchain
 * GET /:mintAddress/onchain
 */
// GET detail NFT by mintAddress (on-chain validation + history)
router.get("/:mintAddress/onchain", async (req: Request, res: Response) => {
  const { mintAddress } = req.params;
  console.time(`⏱ onchain-${mintAddress}`);

  try {
    // 🔑 Cache utama
    // const cacheKey = `nft:onchain:${mintAddress}`;
    // const cached = await redis.get(cacheKey);
    // if (cached) {
    //   console.log(`⚡ Cache HIT: ${mintAddress}`);
    //   console.timeEnd(`⏱ onchain-${mintAddress}`);
    //   return res.json(JSON.parse(cached));
    // }

    // 🔹 Cari NFT dari DB
    const nft = await Nft.findOne({ mintAddress });
    if (!nft) {
      return res.status(404).json({ error: "NFT not found in DB" });
    }

    // --- Logging raw price ---
    const rawPrice: any = nft.price;
    // console.log(`🔍 NFT raw:`, {
    //   _id: nft._id,
    //   name: nft.name,
    //   typePrice: typeof rawPrice,
    //   rawPrice: rawPrice,
    //   toJSON: typeof rawPrice?.toJSON === "function" ? rawPrice.toJSON() : null,
    //   toString: typeof rawPrice?.toString === "function" ? rawPrice.toString() : null,
    // });

    const obj = nft.toObject();
    // console.log(`📦 NFT toObject.price:`, obj.price);

    // --- Hasil final ---
    const result = {
      ...obj,
      price: obj.price ? Number(obj.price) : 0, // ✅ konsisten konversi
      onChain: false,
      metadata: null,
      history: [],
    };

    // Simpan ke cache
    // await redis.setex(cacheKey, TTL_LISTING, JSON.stringify(result));

    // console.timeEnd(`⏱ onchain-${mintAddress}`);
    return res.json(result);
  } catch (err: any) {
    console.error("❌ DB fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch NFT from DB" });
  }
});

/**
 * GET NFT list history
 * GET /nft/history
 */
router.get("/history", async (req, res) => {
  console.time("⏱ onchain-total");
  try {
    const connection = new Connection(
      process.env.SOLANA_CLUSTER as string,
      "confirmed"
    );

    const nfts = await Nft.find({ isSell: true });
    console.log(`📦 Total NFT (DB only, isSell=true): ${nfts.length}`);

    const results: any[] = [];

    for (const nft of nfts) {
      const mintPk = new PublicKey(nft.mintAddress);

      try {
        // === Cari metadata PDA ===
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
          METADATA_PROGRAM_ID
        );
        const accountInfo = await connection.getAccountInfo(metadataPda);

        let metadata: any = null;
        if (accountInfo) {
          let uri = accountInfo.data
            .slice(115, 315)
            .toString("utf-8")
            .replace(/\0/g, "")
            .trim();
          uri = uri.replace(/[^\x20-\x7E]+/g, "");

          if (uri && uri.startsWith("http")) {
            try {
              const resp = await fetchWithTimeout(uri, 5000);
              if (resp.ok) metadata = await resp.json();
            } catch (err) {
              console.warn(`⚠️ Failed fetch metadata ${nft.mintAddress}`, err);
            }
          }
        }

        // === Cek listing PDA hanya jika env true ===
        let priceSol: number | null = null;
        if (process.env.USE_ONCHAIN_LISTING === "true") {
          try {
            const provider = new anchor.AnchorProvider(connection, {} as any, {
              preflightCommitment: "confirmed",
            });
            const program = new anchor.Program(
              require("../../public/idl/universe_of_gamers.json"),
              new PublicKey(process.env.PROGRAM_ID!),
              provider
            );

            const [listingPda] = PublicKey.findProgramAddressSync(
              [Buffer.from("listing"), mintPk.toBuffer()],
              program.programId
            );

            const listing: any = await program.account.listing.fetch(listingPda);
            priceSol = listing.price.toNumber() / anchor.web3.LAMPORTS_PER_SOL;
          } catch {
            // kalau USE_ONCHAIN_LISTING true tapi PDA gak ada → skip
            console.log(`⚠️ No onchain listing for ${nft.mintAddress}`);
          }
        }

        results.push({
          _id: nft._id,
          name: nft.name,
          mintAddress: nft.mintAddress,
          image: nft.image,
          owner: nft.owner,
          price: priceSol ?? Number(nft.price) ?? 0,
          updatedAt: nft.updatedAt,
          metadata,
          onChain: true,
        });
      } catch (err) {
        console.warn(`⚠️ Failed fetch onchain for ${nft.mintAddress}`, err);
        results.push({
          _id: nft._id,
          name: nft.name,
          mintAddress: nft.mintAddress,
          image: nft.image,
          owner: nft.owner,
          price: Number(nft.price) ?? 0,
          updatedAt: nft.updatedAt,
          metadata: null,
          onChain: false,
        });
      }
    }

    console.timeEnd("⏱ onchain-total");
    return res.json({ history: results });
  } catch (err) {
    console.error("❌ onchain error:", err);
    return res.status(500).json({ error: "Failed to fetch NFTs (onchain)" });
  }
});

/**
 * GET NFT list history milik user login
 * GET /nft/my-history
 */
router.get("/my-history", authenticateJWT, async (req: AuthRequest, res) => {
  console.time("⏱ my-history-total");
  try {
    // 🔑 Ambil data user dari JWT
    const user = await Auth.findById(req.user.id).select("wallets custodialWallets");
    if (!user) return res.status(401).json({ error: "User not found" });

    const walletAddresses = [
      ...(user.wallets?.map((w) => w.address) || []),
      ...(user.custodialWallets?.map((c) => c.address) || []),
    ];

    if (!walletAddresses.length) {
      console.warn("⚠️ No wallet found in user profile");
      return res.json({ history: [] });
    }

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const results: any[] = [];

    const nfts = await Nft.find({
      owner: { $in: walletAddresses },
      isSell: true,
    });

    console.log(`📦 Found ${nfts.length} NFT(s) owned by user`);

    for (const nft of nfts) {
      const mintPk = new PublicKey(nft.mintAddress);
      let metadata: any = null;
      let sellerAta: string | null = null;
      let sellerWallet: string | null = null;

      const spl = await import("@solana/spl-token");

      try {
        console.log(`🔍 Checking on-chain transfer for ${nft.name} (${nft.mintAddress})`);

        // === (1) Ambil ATA owner saat ini ===
        const ownerPk = new PublicKey(nft.owner);
        const ataPk = spl.getAssociatedTokenAddressSync(mintPk, ownerPk);
        console.log(`💳 Current ATA: ${ataPk.toBase58()}`);

        // === (2) Ambil transaksi terakhir dari ATA ===
        const signatures = await connection.getSignaturesForAddress(ataPk, { limit: 1 });
        if (signatures.length === 0) {
          console.warn(`⚠️ No transaction found for ATA ${ataPk.toBase58()}`);
        }

        if (signatures.length > 0) {
          const txSig = signatures[0].signature;
          console.log(`🧾 Latest Tx Signature: ${txSig}`);

          const parsedTx = await connection.getParsedTransaction(txSig, {
            maxSupportedTransactionVersion: 0,
          });

          if (parsedTx?.meta?.preTokenBalances?.length && parsedTx.meta.postTokenBalances?.length) {
            const preBalances = parsedTx.meta.preTokenBalances;
            const postBalances = parsedTx.meta.postTokenBalances;

            const sellerBalance = preBalances.find((pre: any) => {
              const post = postBalances.find((p: any) => p.accountIndex === pre.accountIndex);
              const preAmt = pre?.uiTokenAmount?.uiAmount ?? 0;
              const postAmt = post?.uiTokenAmount?.uiAmount ?? 0;
              return preAmt > postAmt;
            });

            if (sellerBalance) {
              sellerAta =
                parsedTx.transaction.message.accountKeys[
                  sellerBalance.accountIndex
                ]?.pubkey?.toBase58?.() ?? null;
              sellerWallet = sellerBalance.owner || null;
              console.log(
                `✅ Found seller: ${sellerWallet} (ATA: ${sellerAta}) for ${nft.mintAddress}`
              );
            } else {
              console.warn(`⚠️ No seller ATA found for ${nft.mintAddress}`);
            }
          } else {
            console.warn(`⚠️ No token balances in tx meta for ${nft.mintAddress}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ Failed to fetch seller ATA for ${nft.mintAddress}:`, err);
      }

      // === (3) Fetch metadata (optional) ===
      try {
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
          METADATA_PROGRAM_ID
        );
        const accountInfo = await connection.getAccountInfo(metadataPda);
        if (accountInfo) {
          let uri = accountInfo.data
            .slice(115, 315)
            .toString("utf-8")
            .replace(/\0/g, "")
            .trim()
            .replace(/[^\x20-\x7E]+/g, "");
          if (uri.startsWith("http")) {
            console.log(`🌐 Fetching metadata: ${uri}`);
            const resp = await fetch(uri);
            if (resp.ok) metadata = await resp.json();
          }
        }
      } catch (err) {
        console.warn(`⚠️ Failed fetch metadata ${nft.mintAddress}:`, err);
      }

      // === (4) Optional: On-chain listing ===
      let priceSol: number | null = null;
      if (process.env.USE_ONCHAIN_LISTING === "true") {
        try {
          const provider = new anchor.AnchorProvider(connection, {} as any, {
            preflightCommitment: "confirmed",
          });
          const program = new anchor.Program(
            require("../../public/idl/universe_of_gamers.json"),
            new PublicKey(process.env.PROGRAM_ID!),
            provider
          );
          const [listingPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("listing"), mintPk.toBuffer()],
            program.programId
          );
          const listing: any = await program.account.listing.fetch(listingPda);
          priceSol = listing.price.toNumber() / anchor.web3.LAMPORTS_PER_SOL;
          console.log(`💰 Listing price found on-chain: ${priceSol} SOL`);
        } catch (err: any) {
          console.log(`⚠️ No onchain listing for ${nft.mintAddress}:`, err?.message || err);
        }
      }

      results.push({
        _id: nft._id,
        name: nft.name,
        mintAddress: nft.mintAddress,
        image: nft.image,
        owner: nft.owner,
        sellerWallet,
        sellerAta,
        price: priceSol ?? Number(nft.price) ?? 0,
        updatedAt: nft.updatedAt,
        metadata,
        onChain: true,
      });

      console.log(`✅ Processed NFT ${nft.name} (${nft.mintAddress})`);
    }

    console.timeEnd("⏱ my-history-total");
    console.log(`📊 Returning ${results.length} NFT history entries`);
    return res.json({ history: results });
  } catch (err) {
    console.error("❌ my-history error:", err);
    return res.status(500).json({ error: "Failed to fetch my-history NFTs" });
  }
});

// GET /nft/top-creators
router.get("/top-creators", async (req, res) => {
  try {
    // ambil semua NFT dari DB (tidak hanya isSell)
    const nfts = await Nft.find({}).select("owner");

    if (!nfts || nfts.length === 0) {
      return res.json([]);
    }

    // hitung jumlah NFT per owner
    const ownerMap: Record<string, number> = {};
    nfts.forEach((nft) => {
      if (!nft.owner) return;
      ownerMap[nft.owner] = (ownerMap[nft.owner] || 0) + 1;
    });

    // ambil semua user (hanya name + avatar + addresses)
    const users = await Auth.find({})
      .select("name avatar wallets.address custodialWallets.address")
      .lean();

    // gabungkan data
    const creators = Object.entries(ownerMap).map(([owner, count]) => {
      const user = users.find(
        (u: any) =>
          (u.wallets?.some((w: any) => w.address === owner) ||
            u.custodialWallets?.some((c: any) => c.address === owner))
      );

      return {
        owner,
        count,
        name: user?.name || null,
        avatar: user?.avatar
          ? `${process.env.BASE_URL}/${
              user.avatar.startsWith("/") ? user.avatar.slice(1) : user.avatar
            }`
          : "assets/images/avatar/avatar-small-01.png",
      };
    });

    // urutkan dari terbanyak & ambil top 5
    const topCreators = creators.sort((a, b) => b.count - a.count).slice(0, 5);

    return res.json(topCreators);
  } catch (err: any) {
    console.error("❌ Error fetching top creators:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;