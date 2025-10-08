import express from "express";
import bs58 from "bs58";
import { Keypair, Transaction, PublicKey } from "@solana/web3.js";
import { GatchaPack } from "../models/GatchaPack";
import { Nft, INft } from "../models/Nft";
import { doGatchaRoll, doMultiGatchaRolls } from "../services/gatchaService";
import { decrypt } from "../utils/cryptoHelper";
import Auth from "../models/Auth";
import { authenticateJWT, AuthRequest } from "../middleware/auth";
import { buildMintTransaction } from "../services/mintService";
import { generateNftMetadata } from "../services/metadataGenerator";

import fs from "fs";
import path from "path";

const router = express.Router();

/**
 * CREATE Gatcha Pack
 */
router.post("/", async (req, res) => {
  try {
    const pack = new GatchaPack(req.body);
    await pack.save();
    res.status(201).json(pack);
  } catch (err: any) {
    console.error("❌ Error creating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to create gatcha pack" });
  }
});

/**
 * GET all Gatcha Packs
 */
router.get("/", async (_req, res) => {
  try {
    // ambil hanya packs dengan price > 0
    const packs = await GatchaPack.find({ priceSOL: { $gt: 0 } });
    res.json(packs);
  } catch (err: any) {
    console.error("❌ Error fetching gatcha packs:", err.message);
    res.status(500).json({ error: "Failed to fetch gatcha packs" });
  }
});

/**
 * GET Gatcha Pack by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findById(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error fetching gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to fetch gatcha pack" });
  }
});

/**
 * UPDATE Gatcha Pack
 */
router.put("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json(pack);
  } catch (err: any) {
    console.error("❌ Error updating gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to update gatcha pack" });
  }
});

/**
 * DELETE Gatcha Pack
 */
router.delete("/:id", async (req, res) => {
  try {
    const pack = await GatchaPack.findByIdAndDelete(req.params.id);
    if (!pack) return res.status(404).json({ error: "Gatcha pack not found" });
    res.json({ message: "Gatcha pack deleted successfully" });
  } catch (err: any) {
    console.error("❌ Error deleting gatcha pack:", err.message);
    res.status(500).json({ error: "Failed to delete gatcha pack" });
  }
});

/**
 * POST /pull
 * Generate NFT + metadata JSON
 */
router.post("/pull", async (req, res) => {
  try {
    const { packId, user, pulls = 1 } = req.body;
    if (!packId || !user) {
      return res.status(400).json({ error: "packId and user required" });
    }

    const pack = await GatchaPack.findById(packId).lean();
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    const results = [];
    for (let i = 0; i < pulls; i++) {
      const result = await doGatchaRoll(pack, user);
      results.push(result);
    }

    res.status(201).json({
      message: "Gatcha successful",
      pack: pack.name,
      pulls,
      results,
    });
  } catch (err: any) {
    console.error("❌ Error in gatcha pull:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/** 
 * POST /:id/pull/custodian
 * Gatcha versi custodial:
 * - Ambil privateKey user dari Auth
 * - Decrypt
 * - Sign & broadcast TX di backend
 */
// Untuk demo custodian, ga perlu paymentMint
router.post("/:id/pull/custodian", async (req: AuthRequest, res) => {
  try {
    const userId = "68d6b0cb7087a4fea2243cd5";
    const packId = "68d15469578e8ad7ead06f18";

    console.log("⚡ Custodian gatcha request:", { userId, packId });

    // Ambil user
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const custodian = authUser.custodialWallets.find(w => w.provider === "solana");
    if (!custodian) return res.status(400).json({ error: "No custodial Solana wallet" });

    const decrypted = decrypt(custodian.privateKey);
    const userKp = Keypair.fromSecretKey(bs58.decode(decrypted));
    console.log("🔓 Custodian wallet:", userKp.publicKey.toBase58());

    // Ambil pack
    const pack = await GatchaPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    // Roll gatcha multi
    const rolls = await doMultiGatchaRolls(pack, custodian.address, 3);

    const processedResults = [];
    for (let i = 0; i < rolls.length; i++) {
      let { nft } = rolls[i];

      const mintKp = Keypair.generate();
      const mintAddress = mintKp.publicKey.toBase58();
      nft.mintAddress = mintAddress;

      if (nft.character) nft = await nft.populate("character");
      if (nft.rune) nft = await nft.populate("rune");

      if (nft.character && (nft.character as any)._id) {
        const charId = (nft.character as any)._id;
        const charName = (nft.character as any).name;
        const existingCount = await Nft.countDocuments({ character: charId });
        nft.name = `${charName} #${existingCount + 1}`;
        nft.base_name = charName;
      } else if (nft.rune && (nft.rune as any)._id) {
        const runeId = (nft.rune as any)._id;
        const runeName = (nft.rune as any).name;
        const existingCount = await Nft.countDocuments({ rune: runeId });
        nft.name = `${runeName} #${existingCount + 1}`;
        nft.base_name = runeName;
      } else {
        throw new Error("NFT tidak punya karakter atau rune");
      }

      await nft.save();

      // Metadata JSON dummy
      const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
      const outputDir = path.join(process.cwd(), baseDir);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const filePath = path.join(outputDir, `${mintAddress}.json`);
      const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
      if (!metadataResult.success) throw new Error(`Metadata generation failed: ${metadataResult.error}`);

      processedResults.push({
        nft,
        blueprint: rolls[i].blueprint,
        rewardInfo: rolls[i].rewardInfo,
        mintAddress,
        metadata: metadataResult.metadata,
        filePath
      });
    }

    // TX dummy
    const resultsWithTx = processedResults.map(r => ({
      ...r,
      tx: {
        mintAddress: r.mintAddress,
        signature: `DUMMY_${Date.now()}_${r.mintAddress.slice(0, 6)}`
      }
    }));

    res.json({
      message: "🎲 Custodian gatcha success! (dummy mode)",
      count: resultsWithTx.length,
      results: resultsWithTx,
      costs: { packPriceSol: pack.priceSOL || 0 }
    });
  } catch (err: any) {
    console.error("❌ Custodian gatcha error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/pull", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { id: packId } = req.params;
    const { paymentMint } = req.body;

    console.log("⚡ Custodian gatcha request:", { userId, packId, paymentMint });

    // === Ambil user & custodian wallet
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const custodian = authUser.custodialWallets.find(w => w.provider === "solana");
    if (!custodian) return res.status(400).json({ error: "No Solana wallet" });

    const decrypted = decrypt(custodian.privateKey);
    const userKp = Keypair.fromSecretKey(bs58.decode(decrypted));
    console.log("🔓 Custodian wallet:", userKp.publicKey.toBase58());

    const anchorLib = await import("@project-serum/anchor");
    const provider = anchorLib.AnchorProvider.env();
    const conn = provider.connection;

    // === Ambil pack
    const pack = await GatchaPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    let priceAmount = 0;

    if (paymentMint === "So11111111111111111111111111111111111111111") {
      const balanceLamports = await conn.getBalance(userKp.publicKey);
      const balanceSol = balanceLamports / anchorLib.web3.LAMPORTS_PER_SOL;
      priceAmount = pack.priceSOL || 0;
      if (balanceSol < priceAmount) {
        return res.status(400).json({ error: "Insufficient SOL balance", balance: balanceSol, required: priceAmount });
      }
    } else if (paymentMint === process.env.UOG_MINT) {
      const UOG_MINT = new PublicKey(process.env.UOG_MINT!);
      const tokenAccounts = await conn.getTokenAccountsByOwner(userKp.publicKey, { mint: UOG_MINT });
      if (tokenAccounts.value.length === 0) {
        return res.status(400).json({ error: "User has no UOG account" });
      }
      const accountInfo = await conn.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
      const balanceUOG = parseFloat(accountInfo.value.uiAmountString || "0");
      priceAmount = pack.priceUOG || 0;
      if (balanceUOG < priceAmount) {
        return res.status(400).json({ error: "Insufficient UOG balance", balance: balanceUOG, required: priceAmount });
      }
    } else {
      return res.status(400).json({ error: "Invalid paymentMint" });
    }

    // === Roll gatcha
    let { nft, blueprint, rewardInfo } = await doGatchaRoll(pack, custodian.address);

    // === Generate mint
    const mintKp = Keypair.generate();
    const mintAddress = mintKp.publicKey.toBase58();
    nft.mintAddress = mintAddress;

    // === Populate char/rune + naming
    if (nft.character) nft = await nft.populate("character");
    if (nft.rune) nft = await nft.populate("rune");

    let finalName: string;
    if (nft.character && (nft.character as any)._id) {
      const charId = (nft.character as any)._id;
      const charName = (nft.character as any).name;
      const existingCount = await Nft.countDocuments({ character: charId });
      finalName = `${charName} #${existingCount + 1}`;
      nft.name = finalName;
      nft.base_name = charName;
    } else if (nft.rune && (nft.rune as any)._id) {
      const runeId = (nft.rune as any)._id;
      const runeName = (nft.rune as any).name;
      const existingCount = await Nft.countDocuments({ rune: runeId });
      finalName = `${runeName} #${existingCount + 1}`;
      nft.name = finalName;
      nft.base_name = runeName;
    } else {
      throw new Error("NFT tidak punya karakter atau rune untuk generate name");
    }
    console.log("DEBUG finalName:", finalName);

    // === Save NFT doc
    await nft.save();

    // === Metadata
    const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
    const outputDir = path.join(process.cwd(), baseDir);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filePath = path.join(outputDir, `${mintAddress}.json`);
    const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
    if (!metadataResult.success) throw new Error(`Metadata generation failed: ${metadataResult.error}`);

    const metadataUri = `https://api.universeofgamers.io/api/nft/${mintAddress}/metadata`;

    // === Build & Send TX (pakai buildMintTransaction baru)
    const { signature } = await buildMintTransaction(
      custodian.address,
      {
        name: nft.name,
        symbol: "UOGNFT",
        uri: metadataUri,
        price: priceAmount,
        royalty: nft.royalty || 0,
      },
      paymentMint,
      userKp,
      mintKp
    );

    // === Update DB
    await Nft.findByIdAndUpdate(nft._id, {
      owner: userKp.publicKey.toBase58(),
      isSell: false,
      price: 0,
      txSignature: signature,
    });

    res.json({
      message: "🎲 Gatcha success!",
      rewardInfo,
      blueprint,
      nft,
      metadata: {
        path: filePath,
        metadata: metadataResult.metadata,
      },
      mintAddress,
      signature,
      costs: {
        priceAmount,
        paymentMint,
      },
    });
  } catch (err: any) {
    console.error("❌ Gatcha error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
