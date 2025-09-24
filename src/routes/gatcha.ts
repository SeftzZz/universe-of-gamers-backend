import express from "express";
import bs58 from "bs58";
import { Keypair, Transaction } from "@solana/web3.js";
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
    const packs = await GatchaPack.find();
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
router.post("/:id/pull/custodian", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { id: userId } = req.user;
    const { id: packId } = req.params;

    console.log("⚡ Custodian gatcha request:", { userId, packId });

    // 🔐 Ambil user & decrypt PK
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const custodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!custodian) return res.status(400).json({ error: "No custodial Solana wallet" });

    const decrypted = decrypt(custodian.privateKey);
    const userKp = Keypair.fromSecretKey(bs58.decode(decrypted));
    console.log("🔓 Custodian wallet:", userKp.publicKey.toBase58());

    // ✅ Cek balance dulu
    const anchorLib = await import("@project-serum/anchor");
    const provider = anchorLib.AnchorProvider.env();
    const conn = provider.connection;
    const balanceLamports = await conn.getBalance(userKp.publicKey);
    const balanceSol = balanceLamports / anchorLib.web3.LAMPORTS_PER_SOL;
    console.log("💰 Balance:", balanceSol, "SOL");

    // 📦 Ambil pack
    const pack = await GatchaPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    // 🎲 Roll gatcha → multi (contoh count=3)
    const rolls = await doMultiGatchaRolls(pack, custodian.address, 3);

    // 🚀 Proses tiap NFT
    const processedResults = [];
    for (let i = 0; i < rolls.length; i++) {
      let { nft } = rolls[i];

      // 🔑 Generate mint
      const mintKp = Keypair.generate();
      const mintAddress = mintKp.publicKey.toBase58();
      nft.mintAddress = mintAddress;

      // 🔢 Populate character/rune
      if (nft.character) nft = await nft.populate("character");
      if (nft.rune) nft = await nft.populate("rune");

      // 🚀 Generate nama unik
      if (nft.character && (nft.character as any)._id) {
        const charId = (nft.character as any)._id;
        const charName = (nft.character as any).name;
        const existingCount = await Nft.countDocuments({ character: charId });
        nft.name = `${charName} #${existingCount + 1}`;
      } else if (nft.rune && (nft.rune as any)._id) {
        const runeId = (nft.rune as any)._id;
        const runeName = (nft.rune as any).name;
        const existingCount = await Nft.countDocuments({ rune: runeId });
        nft.name = `${runeName} #${existingCount + 1}`;
      } else {
        throw new Error("NFT tidak punya karakter atau rune untuk generate name");
      }

      await nft.save();

      // 📝 Generate metadata JSON per NFT
      const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
      const outputDir = path.join(process.cwd(), baseDir);
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

      const filePath = path.join(outputDir, `${mintAddress}.json`);
      const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
      if (!metadataResult.success) {
        throw new Error(`Metadata generation failed: ${metadataResult.error}`);
      }

      processedResults.push({
        nft,
        blueprint: rolls[i].blueprint,
        rewardInfo: rolls[i].rewardInfo,
        mintAddress,
        metadata: metadataResult.metadata,
        filePath,
        mintKp
      });
    }

    interface BuiltTx {
      mintAddress: string;
      signature: string;
      networkCostSol: number;
      totalCostSol: number;
    }

    // 🚀 Build TX per NFT
    const txs: BuiltTx[] = [];
    for (const r of processedResults) {
      const metadataUri = `https://api.universeofgamers.io/api/nft/${r.mintAddress}/metadata`;

      const txResp = await buildMintTransaction(
        custodian.address,
        {
          name: r.nft.name,
          symbol: "UOGNFT",
          uri: metadataUri,
          price: pack.priceSOL,
          royalty: r.nft.royalty || 0,
        },
        r.mintKp
      );

      const tx = Transaction.from(Buffer.from(txResp.tx, "base64"));
      tx.sign(userKp);

      const dummySig = `DUMMY_${Date.now()}_${r.mintAddress.slice(0, 6)}`;

      txs.push({
        mintAddress: r.mintAddress,
        signature: dummySig,
        networkCostSol: txResp.costs.totalSol,
        totalCostSol: (pack.priceSOL || 0) + txResp.costs.totalSol,
      });
    }

    const totalNetworkCostSol = txs.reduce((sum, t) => sum + t.networkCostSol, 0);
    const totalCostSol = txs.reduce((sum, t) => sum + t.totalCostSol, 0);

    res.json({
      message: "🎲 Custodian gatcha success! (dummy mode)",
      count: processedResults.length,
      results: processedResults.map((r, idx) => ({
        nft: r.nft,
        blueprint: r.blueprint,
        rewardInfo: r.rewardInfo,
        mintAddress: r.mintAddress,
        metadata: r.metadata,
        tx: txs[idx]
      })),
      costs: {
        packPriceSol: pack.priceSOL || 0,
        networkCostSol: totalNetworkCostSol,
        totalCostSol
      }
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

    console.log("⚡ Custodian gatcha request:", { userId, packId });

    // 🔐 Ambil user & decrypt PK
    const authUser = await Auth.findById(userId);
    if (!authUser) return res.status(404).json({ error: "User not found" });

    const custodian = authUser.custodialWallets.find((w) => w.provider === "solana");
    if (!custodian) return res.status(400).json({ error: "No custodial Solana wallet" });

    const decrypted = decrypt(custodian.privateKey);
    const userKp = Keypair.fromSecretKey(bs58.decode(decrypted));
    console.log("🔓 Custodian wallet:", userKp.publicKey.toBase58());

    // ✅ Cek balance dulu
    const anchorLib = await import("@project-serum/anchor");
    const provider = anchorLib.AnchorProvider.env();
    const conn = provider.connection;
    const balanceLamports = await conn.getBalance(userKp.publicKey);
    const balanceSol = balanceLamports / anchorLib.web3.LAMPORTS_PER_SOL;
    console.log("💰 Balance:", balanceSol, "SOL");

    if (balanceLamports < 0.01 * anchorLib.web3.LAMPORTS_PER_SOL) {
      return res.status(400).json({
        error: "Insufficient balance in custodial wallet",
        balance: balanceSol,
      });
    }

    // 📦 Ambil pack
    const pack = await GatchaPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    // 🎲 Roll gatcha
    let { nft, blueprint, rewardInfo } = await doGatchaRoll(pack, custodian.address);

    // 🔑 Generate mint lebih dulu
    const mintKp = Keypair.generate();
    const mintAddress = mintKp.publicKey.toBase58();
    nft.mintAddress = mintAddress;

    // 🔢 Populate character/rune biar ada name
    if (nft.character) {
      nft = await nft.populate("character");
    }
    if (nft.rune) {
      nft = await nft.populate("rune");
    }

    let finalName: string;

    if (nft.character && (nft.character as any)._id) {
      const charId = (nft.character as any)._id;
      const charName = (nft.character as any).name;
      const existingCount = await Nft.countDocuments({ character: charId });
      finalName = `${charName} #${existingCount + 1}`;
      nft.name = finalName;
    } else if (nft.rune && (nft.rune as any)._id) {
      const runeId = (nft.rune as any)._id;
      const runeName = (nft.rune as any).name;
      const existingCount = await Nft.countDocuments({ rune: runeId });
      finalName = `${runeName} #${existingCount + 1}`;
      nft.name = finalName;
    } else {
      // 🚨 Kalau ada data rusak/aneh
      throw new Error("NFT tidak punya karakter atau rune untuk generate name");
    }

    console.log("DEBUG finalName:", finalName);

    // 💾 Simpan NFT dengan nama final
    await nft.save();

    // 📝 Buat metadata JSON pakai mintAddress + nama final
    const baseDir = process.env.METADATA_DIR || "uploads/metadata/nft";
    const outputDir = path.join(process.cwd(), baseDir);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const filePath = path.join(outputDir, `${mintAddress}.json`);
    const metadataResult = await generateNftMetadata(mintAddress, outputDir, true);
    if (!metadataResult.success) throw new Error(`Metadata generation failed: ${metadataResult.error}`);

    const metadataUri = `https://api.universeofgamers.io/api/nft/${mintAddress}/metadata`;

    // 🛠️ Build TX dengan mintKp & metadataUri
    const txResp = await buildMintTransaction(
      custodian.address,
      {
        name: nft.name,         // 👈 sudah ada nomor urut konsisten
        symbol: "UOGNFT",
        uri: metadataUri,
        price: pack.priceSOL,   // 🔥 dari pack
        royalty: nft.royalty || 0,
      },
      mintKp
    );

    const tx = Transaction.from(Buffer.from(txResp.tx, "base64"));
    tx.sign(userKp);

    // ✅ Kirim transaksi ke Solana
    const sig = await anchorLib.web3.sendAndConfirmTransaction(
      conn,
      tx,
      [userKp, mintKp],
      {
        skipPreflight: false,
        commitment: "confirmed",
      }
    );

    console.log("✅ TX confirmed:", sig);

    // Hitung total biaya (pack + network)
    const packPriceSol = pack.priceSOL || 0;
    const networkCostSol = txResp.costs.totalSol;
    const totalCostSol = packPriceSol + networkCostSol;

    console.log("💰 Pack price:", packPriceSol, "SOL");
    console.log("💸 Network cost:", networkCostSol, "SOL");
    console.log("💵 Total user cost:", totalCostSol, "SOL");

    // ✅ Kirim response ke frontend
    res.json({
      message: "🎲 Custodian gatcha success!",
      rewardInfo,
      blueprint,
      nft,
      metadata: {
        path: filePath,
        metadata: metadataResult.metadata,
      },
      mintAddress,
      signature: sig,
      costs: {
        packPriceSol,
        networkCostSol,
        totalCostSol,
      }
    });

  } catch (err: any) {
    console.error("❌ Custodian gatcha error:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
