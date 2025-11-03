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

import fetch from "node-fetch";

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
    price: number; // harga mint NFT dalam SOL
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

  const priceUnits = Math.ceil(metadata.price * LAMPORTS_PER_SOL);
  console.log("💰 price input:", metadata.price, "→", priceUnits, "lamports");

  // === Ambil harga SOL dan UOG dari CoinGecko ===
  console.log("🌐 Fetching SOL↔UOG price from CoinGecko...");
  const cgRes = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana,universe-of-gamers&vs_currencies=usd"
  );
  const cgData = await cgRes.json();

  const solPriceUsd = cgData.solana?.usd || 0;
  const uogPriceUsd = cgData["universe-of-gamers"]?.usd || 0;

  if (!solPriceUsd || !uogPriceUsd) throw new Error("❌ Failed to fetch SOL/UOG prices from CoinGecko");

  const uogPerSol = solPriceUsd / uogPriceUsd;
  console.log(`💹 Rate: 1 SOL ≈ ${uogPerSol.toLocaleString()} UOG`);

  // === Hitung mint fee SPL (UOG) dari 5% harga SOL ===
  const mintFeeBps = 1000; // 10%
  const feeSol = metadata.price * (mintFeeBps / 10_000);
  const mintFeeUog = feeSol * uogPerSol;

  // UOG memiliki 6 desimal → konversi ke smallest unit
  const mintFeeSpl = Math.ceil(mintFeeUog * 10 ** 6);

  console.log(
    `💸 Fee 10% dari ${metadata.price} SOL = ${feeSol} SOL ≈ ${mintFeeUog.toFixed(2)} UOG (${mintFeeSpl} microUOG)`
  );

  // === Derive PDA ===
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), mintKp.publicKey.toBuffer()],
    program.programId
  );
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

  // === SPL mint untuk fee (UOG) ===
  const splMint = new PublicKey(process.env.UOG_MINT!);

  const sellerNftAta = getAssociatedTokenAddressSync(mintKp.publicKey, sellerPk);
  const sellerPaymentAta = getAssociatedTokenAddressSync(splMint, sellerPk);
  const treasuryTokenAta = getAssociatedTokenAddressSync(splMint, treasuryPda, true);

  const ataIxs: TransactionInstruction[] = [];

  if (!(await connection.getAccountInfo(sellerPaymentAta))) {
    ataIxs.push(
      createAssociatedTokenAccountInstruction(userKp.publicKey, sellerPaymentAta, sellerPk, splMint)
    );
  }

  if (!(await connection.getAccountInfo(treasuryTokenAta))) {
    ataIxs.push(
      createAssociatedTokenAccountInstruction(userKp.publicKey, treasuryTokenAta, treasuryPda, splMint)
    );
  }

  // === Create mint account ===
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

  // === mint_and_list ===
  const txMintList = await program.methods
    .mintAndList(
      new anchor.BN(priceUnits),
      useSol,
      new anchor.BN(mintFeeSpl),
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
      paymentMint: new PublicKey(paymentMint), // So111...
      splMint,
      treasuryTokenAccount: treasuryTokenAta,
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

  console.log("🚀 Simulating...");
  const sim = await connection.simulateTransaction(txMint);
  if (sim.value.err) {
    console.error("❌ Simulation failed:", sim.value.err);
    console.error(sim.value.logs);
    throw new Error("Simulation failed");
  }

  const sig = await connection.sendRawTransaction(txMint.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  console.log("✅ mint_and_list confirmed:", sig);

  return {
    mintSignature: sig,
    mint: mintKp.publicKey.toBase58(),
    listing: listingPda.toBase58(),
    mintFeeSpl,
    solToUogRate: uogPerSol,
  };
}

export async function buildMintTransactionPhantom(
  owner: string,
  metadata: {
    name: string;
    symbol?: string;
    uri: string;
    price: number;
    royalty?: number;
  },
  paymentMint: string,
  mintKp: anchor.web3.Keypair
) {
  console.log("=== 🏗️ BUILD MINT TRANSACTION (Phantom version) ===");

  const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
  const provider = new anchor.AnchorProvider(connection, {} as any, {
    preflightCommitment: "confirmed",
  });
  const program = new anchor.Program(
    require("../../public/idl/universe_of_gamers.json"),
    new PublicKey(process.env.PROGRAM_ID!),
    provider
  );

  const sellerPk = new PublicKey(owner);
  const useSol = paymentMint === "So11111111111111111111111111111111111111111";
  const priceUnits = Math.ceil(metadata.price * LAMPORTS_PER_SOL);
  console.log("💰 Price:", metadata.price, "→", priceUnits, "lamports");

  // === Fetch SOL↔UOG rate ===
  console.log("🌐 Fetching SOL↔UOG price...");
  const cgRes = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana,universe-of-gamers&vs_currencies=usd"
  );
  const cgData = await cgRes.json();
  const solUsd = cgData.solana?.usd;
  const uogUsd = cgData["universe-of-gamers"]?.usd;
  if (!solUsd || !uogUsd) throw new Error("❌ Failed to fetch CoinGecko rates");

  const uogPerSol = solUsd / uogUsd;
  const mintFeeBps = 1000; // 10%
  const feeSol = metadata.price * (mintFeeBps / 10_000);
  const mintFeeUog = feeSol * uogPerSol;
  const mintFeeSpl = Math.ceil(mintFeeUog * 10 ** 6);

  console.log(
    `💸 Fee 10% dari ${metadata.price} SOL = ${feeSol.toFixed(3)} SOL ≈ ${mintFeeUog.toFixed(
      2
    )} UOG (${mintFeeSpl} microUOG)`
  );

  // === PDAs ===
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), mintKp.publicKey.toBuffer()],
    program.programId
  );
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

  const mc: any = await program.account.marketConfig.fetch(marketConfigPda);
  console.log("market_config:", {
    mintFeeBps: mc.mintFeeBps.toString(),
    tradeFeeBps: mc.tradeFeeBps.toString(),
    treasuryBump: mc.treasuryBump,
    admin: mc.admin.toBase58(),
  });

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintKp.publicKey.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const royaltyBps = Math.floor((metadata.royalty || 0) * 100);

  const splMint = new PublicKey(process.env.UOG_MINT!);
  const sellerNftAta = getAssociatedTokenAddressSync(mintKp.publicKey, sellerPk);
  const sellerPaymentAta = getAssociatedTokenAddressSync(splMint, sellerPk);
  const treasuryTokenAta = getAssociatedTokenAddressSync(splMint, treasuryPda, true);

  const ataIxs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(sellerPaymentAta))) {
    ataIxs.push(
      createAssociatedTokenAccountInstruction(sellerPk, sellerPaymentAta, sellerPk, splMint)
    );
  }
  if (!(await connection.getAccountInfo(treasuryTokenAta))) {
    ataIxs.push(
      createAssociatedTokenAccountInstruction(sellerPk, treasuryTokenAta, treasuryPda, splMint)
    );
  }

  // === Create Mint Account ===
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const createMintIx = SystemProgram.createAccount({
    fromPubkey: sellerPk, // Phantom sebagai payer
    newAccountPubkey: mintKp.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_PROGRAM_ID,
  });
  const initMintIx = createInitializeMintInstruction(mintKp.publicKey, 0, mintAuthPda, null);
  const createSellerNftAtaIx = createAssociatedTokenAccountInstruction(
    sellerPk,
    sellerNftAta,
    sellerPk,
    mintKp.publicKey
  );

  // === Mint and List ===
  const txMintList = await program.methods
    .mintAndList(
      new anchor.BN(priceUnits),
      useSol,
      new anchor.BN(mintFeeSpl),
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
      splMint,
      treasuryTokenAccount: treasuryTokenAta,
      sellerPaymentAta,
      marketConfig: marketConfigPda,
      metadata: metadataPda,
      tokenMetadataProgram: METADATA_PROGRAM_ID,
      payer: sellerPk,
      updateAuthority: sellerPk,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .transaction();

  // === Build full transaction ===
  const tx = new Transaction().add(
    createMintIx,
    initMintIx,
    createSellerNftAtaIx,
    ...ataIxs,
    ...txMintList.instructions
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = sellerPk;

  // 🔹 Partial sign oleh backend hanya untuk mintKp
  tx.partialSign(mintKp);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const base64Tx = serialized.toString("base64");

  console.log("📦 Unsigned transaction built for Phantom");

  return {
    transaction: base64Tx, // kirim ke frontend
    mint: mintKp.publicKey.toBase58(),
    listing: listingPda.toBase58(),
    solToUogRate: uogPerSol,
    mintFeeSpl,
  };
}