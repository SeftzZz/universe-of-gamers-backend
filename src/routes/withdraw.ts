import express, { Request, Response } from "express";
import dotenv from "dotenv";
import bs58 from "bs58";
import * as anchor from "@project-serum/anchor";
import {
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { authenticateJWT } from "../middleware/auth";
import { PendingTx } from "../models/PendingTx";

dotenv.config();
const router = express.Router();

/* ============================================================
   🔧 CONFIGURATION
============================================================ */
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID!);
const MARKET_CONFIG = new PublicKey(process.env.MARKET_CONFIG!);
const TREASURY_PDA = new PublicKey(process.env.TREASURY_PDA!);
const TOKEN_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");

/* ============================================================
   🪙 ensureAta helper
============================================================ */
async function ensureAta(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(owner, ata, owner, mint)
    );
    const latest = await connection.getLatestBlockhash();
    tx.recentBlockhash = latest.blockhash;
    tx.feePayer = owner;
    console.log(`⚙️ Creating ATA for ${owner.toBase58()}...`);
    // Catatan: kita tidak sign di sini, hanya memastikan ATA valid
  }
  return ata;
}

/* ============================================================
   🔹 1) /withdraw/pull — Build unsigned TX (Admin Phantom Sign)
============================================================ */
router.post("/pull", authenticateJWT, async (req: Request, res: Response) => {
  try {
    console.log("──────────────────────────────────────────────");
    console.log("📥 [Withdraw Pull] Incoming request");

    const { amountSOL, activeWallet } = req.body;
    const user = (req as any).user || {};
    console.log("👤 Request by:", user?.wallet || "unknown");
    console.log("💬 Payload:", { amountSOL, activeWallet });

    const userId = user?.id;
    if (!userId) throw new Error("Unauthorized user");
    if (!amountSOL || isNaN(Number(amountSOL))) throw new Error("Invalid amountSOL");
    if (!activeWallet) throw new Error("Missing activeWallet");

    const lamports = Math.floor(Number(amountSOL) * LAMPORTS_PER_SOL);
    console.log(`💰 Withdraw amount: ${amountSOL} SOL (${lamports} lamports)`);

    /* ======================================================
       🔹 1. Check Treasury Balance
    ====================================================== */
    const treasuryBalance = await connection.getBalance(TREASURY_PDA);
    const treasurySOL = (treasuryBalance / LAMPORTS_PER_SOL).toFixed(6);
    console.log(`🏦 Treasury balance: ${treasurySOL} SOL`);
    if (treasuryBalance < lamports)
      throw new Error(`❌ Not enough SOL in Treasury PDA (available ${treasurySOL} SOL)`);

    /* ======================================================
       🔹 2. Load IDL & MarketConfig
    ====================================================== */
    console.log("🔄 Fetching IDL & MarketConfig from chain...");
    const idl = await anchor.Program.fetchIdl(PROGRAM_ID, { connection });
    if (!idl) throw new Error("IDL not found on-chain");

    const program = new anchor.Program(idl, PROGRAM_ID, { connection });
    const cfg: any = await program.account.marketConfig.fetch(MARKET_CONFIG);

    const adminPk = new PublicKey(cfg.admin);
    const allAdmins = (cfg.multisigAdmins as PublicKey[]).map(a => a.toBase58());
    console.log("📊 MarketConfig:");
    console.log("   Admin:", adminPk.toBase58());
    console.log("   Multisig admins:", allAdmins);
    console.log("   Threshold:", cfg.multisigThreshold);

    /* ======================================================
       🔹 3. Tentukan signer1 & signer2 (non-admin)
    ====================================================== */
    const multisigOnly = allAdmins.filter(a => a !== adminPk.toBase58());
    if (multisigOnly.length < 2)
      throw new Error("❌ Need at least 2 non-admin multisig signers");

    const signer1 = new PublicKey(multisigOnly[1]);
    const signer2 = new PublicKey(multisigOnly[2]);

    if (signer1.equals(signer2))
      throw new Error("❌ signer1 and signer2 cannot be the same wallet!");

    console.log("👥 Signers selected:");
    console.log("   signer1:", signer1.toBase58());
    console.log("   signer2:", signer2.toBase58());

    /* ======================================================
       🔹 4. Provider Dummy (read-only)
    ====================================================== */
    console.log("🧩 Initializing dummy provider...");
    const provider = new anchor.AnchorProvider(
      connection,
      new anchor.Wallet(anchor.web3.Keypair.generate()),
      { commitment: "confirmed" }
    );
    anchor.setProvider(provider);

    const adminAta = await ensureAta(TOKEN_MINT, adminPk);
    console.log("💼 Ensured admin ATA:", adminAta.toBase58());

    /* ======================================================
       🔹 5. Build Withdraw Instruction
    ====================================================== */
    console.log("⚙️ Building withdraw instruction...");
    const DUMMY_MINT = new PublicKey("So11111111111111111111111111111111111111112");

    // const dummyAta = await getAssociatedTokenAddress(DUMMY_MINT, signer1, true);
    const treasuryTokenAccount = new PublicKey("CdhF5WVa7zFTYP3igoi5mQN5zjJFnNBedzRPTevzrj2T");
    const adminTokenAccount = new PublicKey("5pv4AnwMqJSkxPAV7sETpWauYcApgB6Na6nGJNCm36Se");

    const ix = await program.methods
      .withdrawTreasury(new anchor.BN(lamports))
      .accounts({
        marketConfig: MARKET_CONFIG,
        treasuryPda: TREASURY_PDA,
        admin: new PublicKey("11111111111111111111111111111111"),
        signer1,
        signer2,
        mint: DUMMY_MINT,
        treasuryTokenAccount: treasuryTokenAccount,
        adminTokenAccount: adminTokenAccount,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // 🧩 PATCH SECTION — fix signer flags for Phantom
    console.log("🧩 Patching instruction signer flags...");
    const seen = new Set<string>();
    ix.keys = ix.keys
      .filter(k => {
        const key = k.pubkey.toBase58();
        if (seen.has(key)) {
          console.warn("⚠️ Duplicate pubkey removed from instruction:", key);
          return false;
        }
        seen.add(key);
        return true;
      })
      .map(k => {
        const pk = k.pubkey.toBase58();

        if (pk === "11111111111111111111111111111111") k.isSigner = false;
        if (pk === signer1.toBase58() || pk === signer2.toBase58()) k.isSigner = false;
        if (
          pk === SystemProgram.programId.toBase58() ||
          pk === TOKEN_PROGRAM_ID.toBase58()
        )
          k.isSigner = false;

        return k;
      });

    console.log("🧾 Final instruction keys:");
    ix.keys.forEach(k =>
      console.log(`   ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`)
    );

    /* ======================================================
       🔹 6. Build Transaction
    ====================================================== */
    console.log("📦 Building transaction skeleton...");
    const tx = new Transaction().add(ix);
    tx.feePayer = new PublicKey(activeWallet);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log("🧾 TX Signatures (pre-sign):", tx.signatures.length);

    const serialized = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Tx = bs58.encode(serialized);
    console.log(`📏 Serialized TX length: ${serialized.length} bytes`);

    /* ======================================================
       🔹 7. Save TX to DB
    ====================================================== */
    console.log("💾 Saving pending TX to database...");
    const pendingTx = new PendingTx({
      userId,
      wallet: activeWallet,
      amount: Number(amountSOL),
      txBase64: Buffer.from(serialized).toString("base64"),
      status: "admin_stage",
      createdAt: new Date(),
    });
    await pendingTx.save();

    console.log(`✅ TX stored in DB → _id: ${pendingTx._id}`);
    console.log("   Next stage: admin");
    console.log("──────────────────────────────────────────────");

    res.json({
      message: "✅ Transaction created for admin signature",
      txId: pendingTx._id,
      transaction: base58Tx,
      amountSOL,
      stage: "admin",
    });
  } catch (err: any) {
    console.error("❌ [Withdraw Pull] Error:", err.message);
    if (err.stack) console.error(err.stack.split("\n")[1]?.trim());

    let hint = "";
    if (err.message.includes("Signature verification failed"))
      hint = "👉 Duplicate signer or Phantom mismatch.";
    else if (err.message.includes("IDL not found"))
      hint = "👉 Pastikan program IDL sudah di-deploy ke chain.";

    res.status(400).json({ error: err.message, hint });
  }
});

/* ============================================================
   🔹 2) /withdraw/sign-admin — Simpan tanda tangan Admin
============================================================ */
router.post("/sign-admin", authenticateJWT, async (req, res) => {
  try {
    const { txId, signedTx } = req.body;
    if (!txId || !signedTx) throw new Error("Missing txId or signedTx");

    // ======================================================
    // 🔐 Ambil user dari JWT
    // ======================================================
    const user = (req as any).user || {};
    console.log("──────────────────────────────────────────────");
    console.log("👑 [Withdraw Admin Sign] Incoming admin signature...");
    console.log("   User ID:", user?.id || "unknown");
    console.log("   Wallet:", user?.wallet || "N/A");
    console.log("   TX ID:", txId);
    console.log("   Signed TX length:", signedTx.length, "chars");

    // ======================================================
    // 🔍 Ambil TX dari database
    // ======================================================
    const txDoc = await PendingTx.findById(txId);
    if (!txDoc) throw new Error("TX not found in database");

    console.log("📦 Found TX in DB:");
    console.log("   Status:", txDoc.status);
    console.log("   Wallet:", txDoc.wallet);
    console.log("   Amount (SOL):", txDoc.amount);
    console.log("   CreatedAt:", txDoc.createdAt);

    // ======================================================
    // 📦 Decode & analisis TX dari Phantom
    // ======================================================
    try {
      const decodedTx = Transaction.from(bs58.decode(signedTx));
      console.log("🖋️ Parsed Admin TX:", decodedTx.signatures.length, "signatures found");
      decodedTx.signatures.forEach((s, i) =>
        console.log(`   #${i + 1} ${s.publicKey.toBase58()} signed=${!!s.signature}`)
      );
    } catch (e: any) {
      console.warn("⚠️ Unable to decode admin signedTx:", e.message);
    }

    // ======================================================
    // 💾 Simpan tanda tangan admin
    // ======================================================
    txDoc.signedTxAdmin = signedTx;
    txDoc.status = "pending"; // lanjut ke signer1
    txDoc.updatedAt = new Date();
    await txDoc.save();

    console.log("✅ Admin signature stored successfully!");
    console.log("   Next stage: signer1");
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 📤 Response ke frontend
    // ======================================================
    res.json({
      message: "✅ Admin signature stored",
      nextStage: "signer1",
      status: txDoc.status,
    });
  } catch (err: any) {
    console.error("❌ [Withdraw Admin Sign] Error:", err.message);
    if (err.stack) console.error(err.stack.split("\n")[1]?.trim());
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
   🔹 3) /withdraw/pending/latest — Determine stage
============================================================ */
router.get("/pending/latest", authenticateJWT, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user || {};
    console.log("──────────────────────────────────────────────");
    console.log("🔎 [Withdraw Pending] Checking latest transaction...");
    console.log("   User ID:", user?.id || "unknown");
    console.log("   Wallet:", user?.wallet || "N/A");
    console.log("   Timestamp:", new Date().toISOString());

    // ======================================================
    // 🔍 Cari TX terbaru dengan status relevan
    // ======================================================
    const tx = await PendingTx.findOne({
      status: { $in: ["admin_stage", "pending", "signed"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!tx) {
      console.log("ℹ️ No pending or signed transaction found — returning admin stage.");
      console.log("──────────────────────────────────────────────");
      return res.json({ stage: "admin" });
    }

    // ======================================================
    // 🧩 Tentukan stage berdasarkan status TX
    // ======================================================
    let stage = "admin";
    if (tx.status === "pending") stage = "signer1";
    else if (tx.status === "signed") stage = "signer2";
    else if (tx.status === "admin_stage") stage = "admin";

    // ======================================================
    // 🧾 Log detail TX yang ditemukan
    // ======================================================
    console.log("📦 Found TX:");
    console.log("   TX ID:", tx._id);
    console.log("   Status:", tx.status);
    console.log("   Stage →", stage);
    console.log("   Wallet:", tx.wallet);
    console.log("   Amount (SOL):", tx.amount);
    console.log("   CreatedAt:", tx.createdAt);
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 🔁 Kirim response ke frontend
    // ======================================================
    res.json({
      stage,
      txId: tx._id,
      transaction: bs58.encode(Buffer.from(tx.txBase64, "base64")),
      amountSOL: tx.amount,
      status: tx.status,
      createdAt: tx.createdAt,
    });
  } catch (err: any) {
    console.error("❌ [Withdraw Pending] Error:", err.message);
    if (err.stack) console.error(err.stack.split("\n")[1]?.trim());
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
   🔹 4) /withdraw/sign — Signer1
============================================================ */
router.post("/sign", authenticateJWT, async (req: Request, res: Response) => {
  try {
    const { txId, signedTx } = req.body;
    if (!txId || !signedTx) throw new Error("Missing txId or signedTx");

    // ✅ ambil info user dari JWT
    const user = (req as any).user || {};
    console.log("──────────────────────────────────────────────");
    console.log("🖋️ [Withdraw Signer1] Incoming signature...");
    console.log("   User ID:", user?.id || "unknown");
    console.log("   Wallet:", user?.wallet || "N/A");
    console.log("   TX ID:", txId);
    console.log("   Signed TX length:", signedTx.length, "chars");

    // ✅ ambil dokumen TX
    const txDoc = await PendingTx.findById(txId);
    if (!txDoc) throw new Error("TX not found in database");

    // ✅ decode & analisis struktur tanda tangan
    try {
      const decodedTx = Transaction.from(bs58.decode(signedTx));
      console.log("📦 Parsed Phantom TX:", decodedTx.signatures.length, "signatures detected");
      decodedTx.signatures.forEach((s, i) =>
        console.log(`   #${i + 1} ${s.publicKey.toBase58()} signed=${!!s.signature}`)
      );
    } catch (e: any) {
      console.warn("⚠️ Warning: Unable to decode signedTx, maybe corrupted base58:", e.message);
    }

    // ✅ simpan hasil tanda tangan signer1
    txDoc.signedTx = signedTx;
    txDoc.status = "signed";
    txDoc.updatedAt = new Date();
    await txDoc.save();

    console.log("✅ Signer1 signature saved successfully to DB!");
    console.log("   Updated status:", txDoc.status);
    console.log("──────────────────────────────────────────────");

    res.json({
      message: "✅ signer1 signature saved",
      nextStage: "signer2",
      status: txDoc.status,
    });
  } catch (err: any) {
    console.error("❌ [Withdraw Signer1] Error:", err.message);
    if (err.stack) console.error(err.stack.split("\n")[1]?.trim());
    res.status(400).json({ error: err.message });
  }
});

/* ============================================================
   🔹 5) /withdraw/confirm — Signer2 + Broadcast
============================================================ */
router.post("/confirm", authenticateJWT, async (req: Request, res: Response) => {
  let txDoc: any;

  try {
    const { txId, signedTx } = req.body;
    if (!txId || !signedTx) throw new Error("Missing txId or signedTx");

    txDoc = await PendingTx.findById(txId);
    if (!txDoc) throw new Error("Transaction not found in DB");

    console.log("──────────────────────────────────────────────");
    console.log("🚀 [Withdraw Confirm] Broadcasting transaction...");
    console.log("   DB txId:", txId);
    console.log("   Stored status:", txDoc.status);
    console.log("   Stored createdAt:", txDoc.createdAt);
    console.log("   User wallet:", txDoc.wallet);
    console.log("   Amount (SOL):", txDoc.amount);

    // ======================================================
    // 🧩 Decode semua TX dari DB & Phantom
    // ======================================================
    const baseTx = Transaction.from(Buffer.from(txDoc.txBase64, "base64"));
    console.log("📦 Base TX loaded from DB:", baseTx.signatures.length, "signatures found");

    const signerTx = Transaction.from(bs58.decode(signedTx));
    console.log("🖋️ Signer TX from Phantom:", signerTx.signatures.length, "signatures");

    // 🔗 Merge semua signatures dari admin, base, dan signer
    const adminTx = txDoc.signedTxAdmin
      ? Transaction.from(bs58.decode(txDoc.signedTxAdmin))
      : null;

    const mergedSignatures = new Map();

    // Merge helper
    function mergeSignatures(tx: any) {
      if (!tx) return;
      for (const sig of tx.signatures) {
        if (sig.publicKey && sig.signature) {
          mergedSignatures.set(sig.publicKey.toBase58(), sig);
        }
      }
    }

    mergeSignatures(adminTx);
    mergeSignatures(baseTx);
    mergeSignatures(signerTx);

    baseTx.signatures = Array.from(mergedSignatures.values());

    console.log("🧩 Final merged signatures:");
    baseTx.signatures.forEach((s, i) =>
      console.log(`#${i + 1}`, s.publicKey.toBase58(), "signed=", !!s.signature)
    );

    if (adminTx) console.log("👑 Admin TX from DB:", adminTx.signatures.length, "signatures");

    // ======================================================
    // 🔗 Merge semua signatures
    // ======================================================
    const allSignatures = [
      ...(adminTx?.signatures || []),
      ...baseTx.signatures,
      ...signerTx.signatures,
    ];

    baseTx.signatures = allSignatures.filter(
      (sig, idx, arr) =>
        sig.publicKey &&
        idx === arr.findIndex(o => o.publicKey.equals(sig.publicKey))
    );

    console.log("🧩 Final merged signatures:");
    baseTx.signatures.forEach((s, i) =>
      console.log(`   #${i + 1} ${s.publicKey.toBase58()} signed=${!!s.signature}`)
    );

    // ======================================================
    // 🧮 Simulate sebelum broadcast
    // ======================================================
    const sim = await connection.simulateTransaction(baseTx);
    if (sim.value.err) {
      console.log("🪫 Simulation failed!");
      console.log("   Logs:", sim.value.logs?.join("\n") || "No logs");
      throw new Error("Simulation failed: " + JSON.stringify(sim.value.err));
    } else {
      console.log("✅ Simulation success, ready to send.");
    }

    // ======================================================
    // 🚀 Broadcast TX ke jaringan
    // ======================================================
    const rawTx = baseTx.serialize();
    console.log("📦 Serialized length:", rawTx.length, "bytes");

    const txSig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log("⏳ Awaiting confirmation...");
    const confirmation = await connection.confirmTransaction(txSig, "confirmed");

    console.log("✅ TX broadcasted successfully!");
    console.log("   Signature:", txSig);
    console.log("   Slot:", confirmation?.context?.slot);
    console.log("──────────────────────────────────────────────");

    // ======================================================
    // 🧾 Update database
    // ======================================================
    txDoc.status = "confirmed";
    txDoc.signature = txSig;
    txDoc.updatedAt = new Date();
    await txDoc.save();

    res.json({
      message: "✅ Withdraw confirmed & broadcasted",
      signature: txSig,
      explorer: `https://explorer.solana.com/tx/${txSig}?cluster=mainnet`,
      status: "confirmed",
    });
  } catch (err: any) {
    console.error("❌ [Withdraw Confirm] Error:", err.message);
    if (err.stack) console.error(err.stack.split("\n")[1]?.trim());

    // ======================================================
    // 🧾 Update DB kalau TX gagal
    // ======================================================
    if (txDoc) {
      txDoc.status = "failed";
      txDoc.errorMessage = err.message;
      txDoc.updatedAt = new Date();
      await txDoc.save();
      console.error("💾 DB updated → status: failed");
    }

    // ======================================================
    // 💡 Hint otomatis
    // ======================================================
    let hint = "";
    if (err.message.includes("Signature verification failed"))
      hint = "👉 Salah satu signer belum menandatangani.";
    else if (err.message.includes("Blockhash not found"))
      hint = "👉 Blockhash expired, regenerate TX dari awal.";
    else if (err.message.includes("Simulation failed"))
      hint = "👉 Cek logs di atas (kemungkinan account layout atau mint dummy salah).";

    res.status(400).json({ error: err.message, hint, status: "failed" });
  }
});

export default router;
