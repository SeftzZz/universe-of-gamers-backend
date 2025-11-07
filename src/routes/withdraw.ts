import express, { Request, Response } from "express";
import fs from "fs";
import bs58 from "bs58";
import * as anchor from "@project-serum/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Keypair,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { authenticateJWT } from "../middleware/auth";

const router = express.Router();

/* ============================================================
   🔧 CONFIGURATION
============================================================ */
const PROGRAM_ID = new PublicKey("UogxY2cxWWwYKMdoS18U22gS6qGymaqBDcpb5Tz5RR6");
const MARKET_CONFIG = new PublicKey("45CmznCKrKsWxwfqAqjee2JWoumHZ9o7Nvjc63EjTuYw");
const TREASURY_PDA = new PublicKey("4gpiH5gPZotdQkDWn8ufguBU8BNAaWBxjCatoa7g9XUi");
const TOKEN_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const rpcUrl = "https://mainnet.helius-rpc.com/?api-key=99344f8f-e269-4d69-b838-675fad917aa0";
const connection = new Connection(rpcUrl, "confirmed");

/* ============================================================
   🔑 LOAD ADMIN KEYS
============================================================ */
const admin1Secret = JSON.parse(
  fs.readFileSync(".config/solana/id.json", "utf8")
);
const admin1 = Keypair.fromSecretKey(Uint8Array.from(admin1Secret));

// Admin2 pakai base58 private key
const admin2PrivateBase58 = "4pg4vz4PFPBiXTkdNAx1o9Sn9cXytRhPEtcdsZuKVHQW5kQ6NxMa6scFMKFhwA1zY9XSqxFBwQRvmdgk4mPndRzn"; // <-- isi private key base58
const admin2 = Keypair.fromSecretKey(bs58.decode(admin2PrivateBase58));

const wallet = new anchor.Wallet(admin2);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);

/* ============================================================
   🔧 HELPERS
============================================================ */
async function ensureAta(mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  const info = await connection.getAccountInfo(ata);
  if (!info) {
    console.log("🧩 Membuat ATA:", ata.toBase58());
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(owner, ata, owner, mint)
    );
    await provider.sendAndConfirm(tx, []);
  }
  return ata;
}

/* ============================================================
   🔹 1) PULL — Build signed TX (Admin1 + Admin2)
============================================================ */
/* ============================================================
   🔹 1) PULL — Build signed TX (Admin1 + Admin2)
============================================================ */
router.post("/pull", authenticateJWT, async (req: Request, res: Response) => {
  try {
    const { amountSOL } = req.body;
    const lamports = Math.floor(Number(amountSOL) * LAMPORTS_PER_SOL);

    console.log("⚙️ [Withdraw Pull] Start:", {
      admin1: admin1.publicKey.toBase58(),
      admin2: admin2.publicKey.toBase58(),
      amountSOL,
      lamports,
    });

    // --- Fetch IDL ---
    const idl = await anchor.Program.fetchIdl(PROGRAM_ID, provider);
    if (!idl) throw new Error("IDL tidak ditemukan di chain.");
    const program = new anchor.Program(idl, PROGRAM_ID, provider);

    // --- Prepare account args sesuai IDL ---
    const accountArgs: {
      marketConfig: PublicKey;
      treasuryPda: PublicKey;
      admin: PublicKey;
      mint: PublicKey;
      systemProgram: PublicKey;
      tokenProgram: PublicKey;
      treasuryTokenAccount?: PublicKey;
      adminTokenAccount?: PublicKey;
    } = {
      marketConfig: MARKET_CONFIG,
      treasuryPda: TREASURY_PDA,
      admin: admin1.publicKey,
      mint: TOKEN_MINT,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
    };

    // --- Buat ATA dummy (SOL → ATA fiktif) ---
    const dummyAta = await ensureAta(TOKEN_MINT, admin2.publicKey);
    accountArgs.treasuryTokenAccount = dummyAta;
    accountArgs.adminTokenAccount = dummyAta;

    console.log("💎 Building transaction...");
    const tx = await program.methods
      .withdrawTreasury(new anchor.BN(lamports))
      .accounts(accountArgs)
      .transaction();

    // --- Setup fee payer & recent blockhash ---
    tx.feePayer = admin1.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // --- Partial sign by both admins ---
    tx.partialSign(admin1);
    tx.partialSign(admin2);

    // --- Debug signatures check ---
    console.log("🧾 Signatures check:");
    tx.signatures.forEach((sig) => {
      console.log(" →", sig.publicKey.toBase58(), "signed?", !!sig.signature);
    });

    // --- Serialize and verify signatures ---
    const signedKeys = tx.signatures.filter((s) => s.signature).map((s) => s.publicKey.toBase58());
    if (!signedKeys.includes(admin1.publicKey.toBase58())) {
      throw new Error(`Missing signature for Admin1: ${admin1.publicKey.toBase58()}`);
    }
    if (!signedKeys.includes(admin2.publicKey.toBase58())) {
      throw new Error(`Missing signature for Admin2: ${admin2.publicKey.toBase58()}`);
    }

    // --- Serialize TX ---
    const serializedTx = tx.serialize({ requireAllSignatures: true });
    const base58Tx = bs58.encode(serializedTx);

    console.log("✅ TX ready:", {
      admin1: admin1.publicKey.toBase58(),
      admin2: admin2.publicKey.toBase58(),
      txLength: base58Tx.length,
    });

    // --- Send & confirm transaction ---
    const signature = await connection.sendRawTransaction(serializedTx, {
      skipPreflight: false,
    });
    const confirmation = await connection.confirmTransaction(signature, "confirmed");

    console.log("🚀 Withdraw confirmed:", {
      signature,
      slot: confirmation?.context?.slot,
    });

    res.json({
      message: "✅ Withdraw executed successfully",
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
    });
  } catch (err: unknown) {
    const e = err as Error;
    console.error("❌ [Withdraw Pull] Error:", e.message);

    // Coba cetak siapa yang belum tanda tangan (debug tambahan)
    if (e.message.includes("Signature verification failed")) {
      console.error(
        "⚠️ Kemungkinan salah satu admin belum tanda tangan atau private key tidak cocok."
      );
    }

    res.status(400).json({ error: e.message });
  }
});


export default router;
