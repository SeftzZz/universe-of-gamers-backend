import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
  TransactionInstruction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { BN } from "@project-serum/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getMint,
  createTransferInstruction
} from "@solana/spl-token";

import {
  createMetadataAccountV3,
} from "@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3";

import * as metadataPkg from "@metaplex-foundation/mpl-token-metadata";

import dotenv from "dotenv";
dotenv.config();

const programIdStr = process.env.PROGRAM_ID;
if (!programIdStr) throw new Error("❌ PROGRAM_ID is missing in .env");

const programID = new PublicKey(programIdStr.trim());
const idl = require("../../public/idl/universe_of_gamers.json");

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, programID, provider);

export interface MintMetadata {
  name: string;
  symbol?: string;
  uri: string;
  price?: number;   // harga (SOL atau UOG)
  royalty?: number; // %
}

const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

export const NATIVE_SOL_MINT =
  "So11111111111111111111111111111111111111111";

async function ensureAtaExists(
  connection: anchor.web3.Connection,
  mint: PublicKey,
  owner: PublicKey,
  payer: PublicKey
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  console.log("🔍 ensureAtaExists:", {
    mint: mint.toBase58(),
    owner: owner.toBase58(),
    payer: payer.toBase58(),
    ata: ata.toBase58(),
  });

  try {
    await getAccount(connection, ata);
    console.log("✅ ATA already exists:", ata.toBase58());
    return { ata, ix: null };
  } catch {
    console.log("⚡ ATA not found, will create:", ata.toBase58());
    return {
      ata,
      ix: createAssociatedTokenAccountInstruction(payer, ata, owner, mint),
    };
  }
}

async function ensureTreasuryAtaExists(
  connection: anchor.web3.Connection,
  mint: PublicKey,
  treasuryPda: PublicKey,
  payer: PublicKey
): Promise<{ ata: PublicKey; ix: TransactionInstruction | null }> {
  const ata = await getAssociatedTokenAddress(mint, treasuryPda, true);
  try {
    await getAccount(connection, ata);
    return { ata, ix: null };
  } catch {
    const ix = createAssociatedTokenAccountInstruction(payer, ata, treasuryPda, mint);
    return { ata, ix };
  }
}

function asSigner(pk: PublicKey, kp?: Keypair) {
  return {
    publicKey: pk,
    getPublicKey: () => pk,
    secretKey: kp?.secretKey, // 👈 tambahin ini
    signTransaction: async (tx: Transaction) => {
      if (kp) tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      if (kp) txs.forEach(tx => tx.partialSign(kp));
      return txs;
    },
    signMessage: async (msg: Uint8Array) => {
      return msg;
    },
  };
}

function asFakeSigner(pk: PublicKey) {
  return {
    publicKey: pk,
    getPublicKey: () => pk,
  };
}

// === BUILD MINT TRANSACTION ===
export async function buildMintTransaction(
  owner: string,
  metadata: {
    name: string;
    symbol?: string;
    uri: string;
    price: number;
    royalty?: number;
  },
  paymentMint: string,
  userKp: Keypair,
  mintKp: Keypair
) {
  console.log("=== 🏗️ BUILD MINT TRANSACTION START ===");

  const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
  const provider = new anchor.AnchorProvider(connection, {} as any, { preflightCommitment: "confirmed" });
  const program = new anchor.Program(
    require("../../public/idl/universe_of_gamers.json"),
    new PublicKey(process.env.PROGRAM_ID!),
    provider
  );

  const sellerPk = new PublicKey(owner);
  const useSol = paymentMint === "So11111111111111111111111111111111111111111";

  let decimals = 0;
  if (!useSol) {
    const mintInfo = await getMint(connection, new PublicKey(paymentMint));
    decimals = mintInfo.decimals;
  }

  const priceUnits = useSol
    ? Math.ceil(metadata.price * anchor.web3.LAMPORTS_PER_SOL)
    : Math.ceil(metadata.price * 10 ** decimals);

  console.log("💰 price input:", metadata.price, "→ priceUnits:", priceUnits, "useSol:", useSol);

  // === 🧩 PDAs ===
  const [listingPda, listingBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), mintKp.publicKey.toBuffer()],
    program.programId
  );

  if (listingBump === 255) {
    console.warn("⚠️ listing PDA on-curve, re-minting new NFT...");
    // 🔁 Buat mint baru dan ulang seluruh proses mintAndList
    mintKp = Keypair.generate();
    // continue;
    return { error: "Listing PDA on-curve, re-mint required" };
  }

  const [escrowSignerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow_signer"), mintKp.publicKey.toBuffer()],
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
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_auth"), mintKp.publicKey.toBuffer()],
    program.programId
  );

  // === Market Config debug ===
  const mc: any = await program.account.marketConfig.fetch(marketConfigPda);
  console.log("market_config:", {
    mintFeeBps: mc.mintFeeBps.toString(),
    tradeFeeBps: mc.tradeFeeBps.toString(),
    treasuryBump: mc.treasuryBump,
    admin: mc.admin.toBase58(),
  });

  // === Metadata PDA ===
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintKp.publicKey.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const royaltyBps = Math.floor((metadata.royalty || 0) * 100);

  // === ATAs ===
  const sellerNftAta = getAssociatedTokenAddressSync(mintKp.publicKey, sellerPk);
  const ataIxs: TransactionInstruction[] = [];
  let treasuryPaymentAta = SystemProgram.programId;
  let sellerPaymentAta = sellerPk;

  if (!useSol) {
    const sellerRes = await ensureAtaExists(connection, new PublicKey(paymentMint), sellerPk, userKp.publicKey);
    sellerPaymentAta = sellerRes.ata;
    if (sellerRes.ix) ataIxs.push(sellerRes.ix);

    const treasuryRes = await ensureTreasuryAtaExists(connection, new PublicKey(paymentMint), treasuryPda, userKp.publicKey);
    treasuryPaymentAta = treasuryRes.ata;
    if (treasuryRes.ix) ataIxs.push(treasuryRes.ix);

    console.log("📌 ATAs (SPL):", {
      sellerPaymentAta: sellerPaymentAta.toBase58(),
      treasuryPaymentAta: treasuryPaymentAta.toBase58(),
    });
  } else {
    sellerPaymentAta = sellerPk;
    treasuryPaymentAta = treasuryPda;
  }

  // === Create Mint Account + Init ===
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: userKp.publicKey,
    newAccountPubkey: mintKp.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID,
  });
  const initMintIx = createInitializeMintInstruction(mintKp.publicKey, 0, mintAuthPda, null);
  const createSellerNftAtaIx = createAssociatedTokenAccountInstruction(
    userKp.publicKey,
    sellerNftAta,
    sellerPk,
    mintKp.publicKey
  );

  // === Anchor Instruction: mint_and_list ===
  const txMintList = await program.methods
    .mintAndList(
      new anchor.BN(priceUnits),
      useSol,
      metadata.name,
      metadata.symbol || "UOGNFT",
      metadata.uri,
      royaltyBps
    )
    .accountsStrict({
      listing: listingPda,
      escrowSigner: escrowSignerPda,
      seller: sellerPk,
      mint: mintKp.publicKey,
      sellerNftAta,
      mintAuthority: mintAuthPda,
      treasuryPda,
      paymentMint: new PublicKey(paymentMint),
      treasuryTokenAccount: treasuryPaymentAta,
      sellerPaymentAta,
      marketConfig: marketConfigPda,
      metadata: metadataPda,
      tokenMetadataProgram: METADATA_PROGRAM_ID,
      payer: userKp.publicKey,
      updateAuthority: userKp.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .transaction();

  // === Combine All Instructions ===
  const txMint = new Transaction().add(
    createMintIx,
    initMintIx,
    createSellerNftAtaIx,
    ...ataIxs,
    ...txMintList.instructions
  );

  txMint.feePayer = userKp.publicKey;
  txMint.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  txMint.partialSign(mintKp, userKp);

  const sigMint = await connection.sendRawTransaction(txMint.serialize());
  await connection.confirmTransaction(sigMint, "confirmed");

  console.log("✅ mint_and_list confirmed:", sigMint);

  return {
    mintSignature: sigMint,
    mint: mintKp.publicKey.toBase58(),
    listing: listingPda.toBase58(),
    listingBump,
  };
}

