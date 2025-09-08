import { Router, Request } from "express";
import multer from "multer";
import { Nft } from "../models/Nft";
import { Character } from "../models/Character";
import { Rune } from "../models/Rune";

import { mintNftWithAnchor } from "../services/anchorService";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import dotenv from "dotenv";
dotenv.config();

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const router = Router();
const upload = multer(); // memory storage

const programIdStr = process.env.PROGRAM_ID;
if (!programIdStr) throw new Error("❌ PROGRAM_ID is missing in .env");

const programID = new PublicKey(programIdStr.trim());
const idl = require("../../public/idl/uog_marketplace.json");

// 🔍 Tambahkan log debug
console.log("⚙️ [nft.ts] PROGRAM_ID =", programID.toBase58());
console.log("⚙️ [nft.ts] IDL name   =", idl.name);

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, programID, provider);

router.post("/make-tx", async (req: Request, res) => {
  try {
    console.log("📥 Incoming make-tx request");
    console.log("📥 Body:", JSON.stringify(req.body, null, 2));

    const { owner, metadata } = req.body;
    if (!owner) throw new Error("Owner required");

    const sellerPk = new PublicKey(owner);
    console.log("👤 Seller:", sellerPk.toBase58());

    // --- cek balance seller
    const balSeller = await provider.connection.getBalance(sellerPk);
    console.log("💳 Seller balance (lamports):", balSeller);

    // --- Konversi price & royalty ke lamports ---
    const priceLamports = Math.floor(Number(metadata.price) * LAMPORTS_PER_SOL);
    const royaltyPercent = Number(metadata.royalty || "0"); // frontend: 8 → 8%
    if (isNaN(royaltyPercent)) throw new Error("Invalid royalty format");

    const royaltyBps = Math.floor(royaltyPercent * 100); // 8 → 800 bps
    if (royaltyBps > 10000) throw new Error("Royalty too high (max 10000 bps)");

    console.log("💰 Parsed price & royalty:", {
      priceInput: metadata.price,
      royaltyInput: metadata.royalty,
      priceLamports,
      royaltyPercent,
      royaltyBps,
    });

    // --- Mint baru ---
    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey;
    console.log("🪙 New Mint:", mint.toBase58());

    const sellerAta = getAssociatedTokenAddressSync(mint, sellerPk);
    console.log("📦 Seller ATA:", sellerAta.toBase58());

    const mplTokenMetadataProgramId = new PublicKey(
      "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
    );

    const { name, uri, symbol } = metadata;
    console.log("📝 Metadata args:", { name, symbol, uri });

    // --- Derive PDA sesuai Rust ---
    const [listingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mint.toBuffer()],
      program.programId
    );
    const [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );
    const [escrowSignerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_signer"), mint.toBuffer()],
      program.programId
    );
    const [mintAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_auth"), mint.toBuffer()],
      program.programId
    );
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), mplTokenMetadataProgramId.toBuffer(), mint.toBuffer()],
      mplTokenMetadataProgramId
    );

    console.log("🔑 Derived PDAs:", {
      listingPda: listingPda.toBase58(),
      marketConfigPda: marketConfigPda.toBase58(),
      treasuryPda: treasuryPda.toBase58(),
      escrowSignerPda: escrowSignerPda.toBase58(),
      mintAuthPda: mintAuthPda.toBase58(),
      metadataPda: metadataPda.toBase58(),
    });

    const balTreasury = await provider.connection.getBalance(treasuryPda);
    console.log("💳 Treasury balance (lamports):", balTreasury);

    // --- Create mint account ---
    const lamportsForMint = await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    console.log("💵 Rent-exempt lamports for mint:", lamportsForMint);

    const createMintIx = SystemProgram.createAccount({
      fromPubkey: sellerPk,
      newAccountPubkey: mint,
      space: MINT_SIZE,
      lamports: lamportsForMint,
      programId: TOKEN_PROGRAM_ID,
    });

    // --- Initialize mint (decimals=0, mintAuthority=PDA) ---
    const initMintIx = createInitializeMintInstruction(mint, 0, mintAuthPda, null);

    // --- Create seller ATA ---
    const createAtaIx = createAssociatedTokenAccountInstruction(
      sellerPk,
      sellerAta,
      sellerPk,
      mint
    );

    // --- Build Anchor ix ---
    console.log("🚀 Building mintAndList ix...");
    const ix = await program.methods
      .mintAndList(
        new BN(priceLamports),
        true,   // useSol
        name,
        symbol || "",
        uri,
        royaltyBps
      )  
      .accounts({
        listing: listingPda,
        marketConfig: marketConfigPda,
        treasuryPda: treasuryPda,
        escrowSigner: escrowSignerPda,
        seller: sellerPk,
        sellerNftAta: sellerAta,
        mintAuthority: mintAuthPda,
        mint: mint,
        metadata: metadataPda,
        tokenMetadataProgram: mplTokenMetadataProgramId,
        payer: sellerPk,
        updateAuthority: sellerPk,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    console.log("✅ mintAndList ix built:");
    console.log("   ↳ programId:", ix.programId.toBase58());
    console.log("   ↳ keys:", ix.keys.map(k => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable
    })));

    // --- Final transaction ---
    const tx = new Transaction().add(createMintIx, initMintIx, createAtaIx, ix);
    tx.feePayer = sellerPk;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
    tx.partialSign(mintKp);

    console.log("🧾 Transaction ready, feePayer:", sellerPk.toBase58());
    console.log("🧾 Mint secretKey (base64):", Buffer.from(mintKp.secretKey).toString("base64"));

    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log("📦 Serialized tx length:", serialized.length);

    const nft = await Nft.create({
      name: metadata.name,
      description: metadata.description,
      price: priceLamports,
      properties: metadata.properties,
      size: metadata.size,
      blockchain: metadata.blockchain,
      collection: metadata.collection,
      royalty: royaltyPercent,
      owner: metadata.owner,
      metadata: metadata,
      txSignature: serialized.toString("base64"),
    });

    const decoded = Transaction.from(serialized);
    console.log("📋 Instruction program IDs:", decoded.instructions.map(ix => ix.programId.toBase58()));

    res.json({ 
      tx: serialized.toString("base64"),
      debug: {
        listingPda: listingPda.toBase58(),
        marketConfigPda: marketConfigPda.toBase58(),
        treasuryPda: treasuryPda.toBase58(),
        escrowSignerPda: escrowSignerPda.toBase58(),
        mintAuthPda: mintAuthPda.toBase58(),
        metadataPda: metadataPda.toBase58(),
        mint: mint.toBase58(),
        sellerAta: sellerAta.toBase58(),
        sellerBalance: balSeller,
        treasuryBalance: balTreasury
      }
    });
  } catch (err: any) {
    console.error("❌ make-tx error:", err);
    console.error("❌ Stack:", err.stack);
    try {
      console.error("❌ Full error object:", JSON.stringify(err, null, 2));
    } catch {}
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// GET all NFTs
router.get("/", async (req, res) => {
  try {
    const nfts = await Nft.find();
    res.json(nfts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// GET NFT by ID
router.get("/:id", async (req, res) => {
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
router.get("/character", async (req, res) => {
  try {
    const chars = await Character.find().populate("runes");
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

/////////////////////////////
// // POST NFT (simpan langsung ke MongoDB)
// router.post("/", async (req, res) => {
//   try {
//     // parsing metadata jika dikirim dalam string
//     let metadata = req.body.metadata;
//     if (typeof metadata === "string") {
//       try {
//         metadata = JSON.parse(metadata);
//       } catch {
//         metadata = { raw: req.body.metadata }; // fallback kalau bukan JSON valid
//       }
//     }

//     const nft = await Nft.create({
//       name: req.body.name,
//       description: req.body.description,
//       image: req.body.image,
//       price: req.body.price,
//       metadata: metadata,
//       blockchain: req.body.blockchain,
//       collection: req.body.collection,
//       royalty: req.body.royalty,
//       character: req.body.character, // reference ObjectId ke Character
//     });

//     res.json({ success: true, data: nft });
//   } catch (err: any) {
//     console.error("❌ Error creating NFT:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

// Simpan NFT ke MongoDB setelah mint sukses
router.post("/", async (req, res) => {
  try {
    let metadata = req.body.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = { raw: req.body.metadata };
      }
    }

    const nft = await Nft.create({
      name: req.body.name,
      description: req.body.description,
      image: req.body.image,
      price: req.body.price,
      metadata,
      blockchain: req.body.blockchain,
      collection: req.body.collection,
      royalty: req.body.royalty,
      character: req.body.character,
      owner: req.body.owner,   // tambahkan owner (wallet address)
      txSignature: req.body.txSignature // simpan tx hash biar bisa trace di explorer
    });

    res.json({ success: true, data: nft });
  } catch (err: any) {
    console.error("❌ Error saving NFT:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
