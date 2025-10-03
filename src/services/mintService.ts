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
  getMint
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

  // === Hitung harga ===
  const useSol = paymentMint === "So11111111111111111111111111111111111111111";
  const mintInfo = await getMint(connection, new PublicKey(paymentMint));
  const decimals = mintInfo.decimals;

  const priceUnits = useSol
    ? Math.ceil(metadata.price * anchor.web3.LAMPORTS_PER_SOL)
    : Math.ceil(metadata.price * 10 ** decimals);

  console.log("💰 price input:", metadata.price, "→ priceUnits:", priceUnits, "useSol:", useSol);

  // === Mint baru (pakai mintKp yang sudah digenerate di pull) ===
  const mintPk = mintKp.publicKey;

  // === PDAs ===
  const [listingPda] = PublicKey.findProgramAddressSync([Buffer.from("listing"), mintPk.toBuffer()], program.programId);
  const [escrowSignerPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow_signer"), mintPk.toBuffer()], program.programId);
  const [marketConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("market_config")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
  const [mintAuthPda] = PublicKey.findProgramAddressSync([Buffer.from("mint_auth"), mintPk.toBuffer()], program.programId);

  const mc: any = await program.account.marketConfig.fetch(marketConfigPda);
  console.log("market_config:", {
    mintFeeBps: mc.mintFeeBps.toString(),
    tradeFeeBps: mc.tradeFeeBps.toString(),
    relistFeeBps: mc.relistFeeBps.toString(),
    treasuryBump: mc.treasuryBump,
    admin: mc.admin.toBase58()
  });

  // === Metadata PDA ===
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const royaltyBps = Math.floor((metadata.royalty || 0) * 100);

  // === ATAs ===
  const sellerNftAta = getAssociatedTokenAddressSync(mintPk, sellerPk);

  let ataIxs: TransactionInstruction[] = [];
  let treasuryPaymentAta = SystemProgram.programId;
  let sellerPaymentAta = SystemProgram.programId;

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
    treasuryPaymentAta = await getAssociatedTokenAddress(new PublicKey(paymentMint), treasuryPda, true);
    console.log("📌 ATAs (SOL):", {
      treasuryPaymentAta: treasuryPaymentAta.toBase58(),
    });
  }

  // === Pre-balance check Treasury ===
  let treasuryPreLamports = 0;
  let treasuryPreTokenBalance = 0;

  if (useSol) {
    treasuryPreLamports = await connection.getBalance(treasuryPda);
    console.log("💰 Treasury SOL balance (pre):", treasuryPreLamports / anchor.web3.LAMPORTS_PER_SOL, "SOL");
  } else {
    const bal = await connection.getTokenAccountBalance(treasuryPaymentAta);
    treasuryPreTokenBalance = parseInt(bal.value.amount);
    console.log("💰 Treasury SPL balance (pre):", bal.value.uiAmountString, `(${decimals} decimals)`);
  }

  // === Create Mint Account + Init ===
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: userKp.publicKey,
    newAccountPubkey: mintPk,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID,
  });
  const initMintIx = createInitializeMintInstruction(mintPk, 0, mintAuthPda, null);
  const createSellerNftAtaIx = createAssociatedTokenAccountInstruction(userKp.publicKey, sellerNftAta, sellerPk, mintPk);

  // === mintAndList tx langsung ===
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
      mint: mintPk,
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

  const tx = new Transaction().add(
    createMintIx,
    initMintIx,
    createSellerNftAtaIx,
    ...ataIxs,
    ...txMintList.instructions
  );

  tx.feePayer = userKp.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  tx.partialSign(mintKp, userKp);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");

  console.log("✅ mint_and_list confirmed:", sig);

  // === Post-balance check Treasury ===
  if (useSol) {
    const treasuryPostLamports = await connection.getBalance(treasuryPda);
    console.log("💰 Treasury SOL balance (post):", treasuryPostLamports / anchor.web3.LAMPORTS_PER_SOL, "SOL");
    console.log("💰 Fee diff (SOL):", (treasuryPostLamports - treasuryPreLamports) / anchor.web3.LAMPORTS_PER_SOL, "SOL");
  } else {
    const bal = await connection.getTokenAccountBalance(treasuryPaymentAta);
    const treasuryPostTokenBalance = parseInt(bal.value.amount);
    console.log("💰 Treasury SPL balance (post):", bal.value.uiAmountString, `(${decimals} decimals)`);
    console.log("💰 Fee diff (SPL):", (treasuryPostTokenBalance - treasuryPreTokenBalance) / 10 ** decimals, "tokens");
  }

  return {
    signature: sig,
    mint: mintPk.toBase58(),
    listing: listingPda.toBase58(),
  };
}
