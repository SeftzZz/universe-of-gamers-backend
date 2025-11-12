import bs58Module from "bs58";
const bs58: any = (bs58Module as any).default || bs58Module;
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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getMint,
  createTransferInstruction,
} from "@solana/spl-token";

import {
  createMetadataAccountV3,
} from "@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3";

import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as metadataPkg from "@metaplex-foundation/mpl-token-metadata";

import fetch from "node-fetch";
import https from "https";

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
  price: number;   // harga (SOL atau UOG)
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

const agent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false, // sementara false, bisa true setelah TLS OK
});

async function getUsdPrice(mint: string): Promise<number> {
  const url = `https://data.solanatracker.io/tokens/${mint}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": process.env.SOLANATRACKER_API_KEY || "d1df9e86-48aa-4875-bd20-b41bcad5c389",
  };

  const res = await fetch(url, { headers, agent }); // 👈 gunakan agent
  if (!res.ok) throw new Error(`Solana Tracker error ${res.status}: ${res.statusText}`);

  const data = await res.json();
  const pools = Array.isArray(data.pools) ? data.pools : [];
  const top = pools.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return top?.price?.usd ?? 0;
}

export const getAdminKeypair = (): Keypair => {
  console.log("🔑 [getAdminKeypair] Loading from .env...");
  const secret = process.env.ADMIN_TREASURY_KEY;

  if (!secret) {
    console.error("❌ [getAdminKeypair] Missing ADMIN_TREASURY_KEY in .env");
    throw new Error("Missing ADMIN_TREASURY_KEY in .env");
  }

  try {
    const secretKey = bs58.decode(secret.trim());
    const keypair = Keypair.fromSecretKey(secretKey);
    console.log("👑 [Admin Keypair Loaded]", keypair.publicKey.toBase58());
    return keypair;
  } catch (err: any) {
    console.error("❌ [getAdminKeypair] Invalid key format:", err.message);
    throw new Error("Invalid ADMIN_TREASURY_KEY format (must be base58)");
  }
};

export async function buildMintTransactionPhantom(
  owner: string,
  metadata: MintMetadata,
  paymentMint: string,
  mintKp: Keypair | PublicKey
) {
  console.log("=== 🏗️ BUILD MINT TRANSACTION (Phantom version) ===");
  console.log("🧩 TOKEN_PROGRAM_ID:", TOKEN_PROGRAM_ID.toBase58());
  console.log("🧩 ASSOCIATED_TOKEN_PROGRAM_ID:", ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());

  const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
  const adminKeypair = getAdminKeypair();
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, programID, provider);

  const sellerPk = new PublicKey(owner);
  const useSol = paymentMint === "So11111111111111111111111111111111111111111";
  const priceUnits = Math.floor(metadata.price * LAMPORTS_PER_SOL);

  console.log("💰 Price:", metadata.price, "→", priceUnits, "lamports");

  // === Fetch price + fee ===
  const solMint = "So11111111111111111111111111111111111111112";
  const uogMint = process.env.UOG_MINT!;
  const [solUsd, uogUsd] = await Promise.all([getUsdPrice(solMint), getUsdPrice(uogMint)]);
  const uogPerSol = solUsd / uogUsd;
  const mintFeeBps = 1000;
  const feeSol = metadata.price * (mintFeeBps / 10_000);
  const mintFeeUog = feeSol * uogPerSol;
  const mintFeeSpl = Math.ceil(mintFeeUog * 10 ** 6);

  console.log(`💸 Fee 10% dari ${metadata.price} SOL = ${feeSol.toFixed(3)} SOL ≈ ${mintFeeUog.toFixed(2)} UOG (${mintFeeSpl} microUOG)`);

  let mintPubkey = mintKp instanceof PublicKey ? mintKp : mintKp.publicKey;

  // === Create Mint Account & Initialize (dibayar oleh seller)
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const seed = "mint" + Date.now();
  mintPubkey = await PublicKey.createWithSeed(sellerPk, seed, TOKEN_PROGRAM_ID);

  const createMintIx = SystemProgram.createAccountWithSeed({
    fromPubkey: sellerPk,
    basePubkey: sellerPk,
    seed,
    newAccountPubkey: mintPubkey,
    lamports,
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  });


  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_auth"), mintPubkey.toBuffer()],
    program.programId
  );

  const initMintIx = createInitializeMintInstruction(
    mintPubkey,
    0,                 // decimals = 0, NFT
    mintAuthPda,       // mint authority
    null               // freeze authority = none
  );

  console.log("⚙️ Mint akan dibuat di Phantom (seller sebagai payer):", mintPubkey.toBase58());

  // === PDAs ===
  const [listingPda] = PublicKey.findProgramAddressSync([Buffer.from("listing"), mintPubkey.toBuffer()], program.programId);
  const [escrowSignerPda] = PublicKey.findProgramAddressSync([Buffer.from("escrow_signer"), mintPubkey.toBuffer()], program.programId);
  const [marketConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("market_config")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);

  const mc: any = await program.account.marketConfig.fetch(marketConfigPda);
  console.log("market_config:", {
    mintFeeBps: mc.mintFeeBps?.toString(),
    tradeFeeBps: mc.tradeFeeBps?.toString(),
    treasuryBump: mc.treasuryBump,
    admin: mc.admin?.toBase58(),
  });

  // === Metadata PDA ===
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
    METADATA_PROGRAM_ID
  );
  const royaltyBps = Math.floor((metadata.royalty || 0) * 100);

  // === Token accounts ===
  const splMint = new PublicKey(uogMint);
  const sellerNftAta = getAssociatedTokenAddressSync(mintPubkey, sellerPk);
  const sellerPaymentAta = getAssociatedTokenAddressSync(splMint, sellerPk);

  // ✅ Auto-derive treasury ATA & admin ATA
  const treasuryTokenAta = getAssociatedTokenAddressSync(splMint, treasuryPda, true);
  const adminTokenAccount = getAssociatedTokenAddressSync(splMint, adminKeypair.publicKey);

  // === Create ATA jika belum ada ===
  const ataIxs: TransactionInstruction[] = [];

  if (!(await connection.getAccountInfo(sellerPaymentAta))) {
    ataIxs.push(createAssociatedTokenAccountInstruction(sellerPk, sellerPaymentAta, sellerPk, splMint));
  }

  if (!(await connection.getAccountInfo(sellerNftAta))) {
    ataIxs.push(createAssociatedTokenAccountInstruction(sellerPk, sellerNftAta, sellerPk, mintPubkey));
  }

  console.log("✅ Seller NFT ATA:", sellerNftAta.toBase58());
  console.log("✅ Treasury ATA:", treasuryTokenAta.toBase58());
  console.log("✅ Admin ATA:", adminTokenAccount.toBase58());

  // === Build main instruction ===
  const ixMintAndList = await program.methods
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
      seller: sellerPk,
      listing: listingPda,
      escrowSigner: escrowSignerPda,
      mint: mintPubkey,
      sellerNftAta,
      mintAuthority: mintAuthPda,
      treasuryPda,
      paymentMint: new PublicKey(paymentMint),
      splMint,
      treasuryTokenAccount: treasuryTokenAta,
      sellerPaymentAta,
      marketConfig: marketConfigPda,
      admin: adminKeypair.publicKey,
      adminTokenAccount,
      metadata: metadataPda,
      tokenMetadataProgram: METADATA_PROGRAM_ID,
      updateAuthority: sellerPk,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  // === Final TX ===
  const tx = new Transaction()
    .add(createMintIx)
    .add(initMintIx)
    .add(...ataIxs)
    .add(ixMintAndList);

  tx.feePayer = sellerPk;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.signatures = [{ publicKey: sellerPk, signature: null }];

  console.log("📜 Final signer:", sellerPk.toBase58());
  const base64Tx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  console.log("🧾 TX ready for Phantom:", base64Tx.length, "bytes");

  return {
    transaction: base64Tx,
    mint: mintPubkey.toBase58(),
    listing: listingPda.toBase58(),
  };
}

// // === BUILD MINT TRANSACTION ===
// export async function buildMintTransaction(
//   owner: string,
//   metadata: {
//     name: string;
//     symbol?: string;
//     uri: string;
//     price: number; // harga mint NFT dalam SOL
//     royalty?: number;
//   },
//   paymentMint: string,
//   userKp: Keypair,
//   mintKp: Keypair
// ) {
//   console.log("=== 🏗️ BUILD MINT TRANSACTION START ===");

//   const connection = new Connection(process.env.SOLANA_CLUSTER!, "confirmed");
//   const provider = new anchor.AnchorProvider(connection, {} as any, { preflightCommitment: "confirmed" });
//   const program = new anchor.Program(
//     require("../../public/idl/universe_of_gamers.json"),
//     new PublicKey(process.env.PROGRAM_ID!),
//     provider
//   );

//   const sellerPk = new PublicKey(owner);
//   const useSol = paymentMint === "So11111111111111111111111111111111111111111";

//   const priceUnits = Math.ceil(metadata.price * LAMPORTS_PER_SOL);
//   console.log("💰 price input:", metadata.price, "→", priceUnits, "lamports");

//   // === Ambil harga SOL dan UOG dari CoinGecko ===
//   console.log("🌐 Fetching SOL↔UOG price from CoinGecko...");
//   const cgRes = await fetch(
//     "https://api.coingecko.com/api/v3/simple/price?ids=solana,universe-of-gamers&vs_currencies=usd"
//   );
//   const cgData = await cgRes.json();

//   const solPriceUsd = cgData.solana?.usd || 0;
//   const uogPriceUsd = cgData["universe-of-gamers"]?.usd || 0;

//   if (!solPriceUsd || !uogPriceUsd) throw new Error("❌ Failed to fetch SOL/UOG prices from CoinGecko");

//   const uogPerSol = solPriceUsd / uogPriceUsd;
//   console.log(`💹 Rate: 1 SOL ≈ ${uogPerSol.toLocaleString()} UOG`);

//   // === Hitung mint fee SPL (UOG) dari 5% harga SOL ===
//   const mintFeeBps = 1000; // 10%
//   const feeSol = metadata.price * (mintFeeBps / 10_000);
//   const mintFeeUog = feeSol * uogPerSol;

//   // UOG memiliki 6 desimal → konversi ke smallest unit
//   const mintFeeSpl = Math.ceil(mintFeeUog * 10 ** 6);

//   console.log(
//     `💸 Fee 10% dari ${metadata.price} SOL = ${feeSol} SOL ≈ ${mintFeeUog.toFixed(2)} UOG (${mintFeeSpl} microUOG)`
//   );

//   // === Derive PDA ===
//   const [listingPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("listing"), mintPubkey.toBuffer()],
//     program.programId
//   );
//   const [escrowSignerPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("escrow_signer"), mintPubkey.toBuffer()],
//     program.programId
//   );
//   const [marketConfigPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("market_config")],
//     program.programId
//   );
//   const [treasuryPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("treasury")],
//     program.programId
//   );
//   const [mintAuthPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("mint_auth"), mintPubkey.toBuffer()],
//     program.programId
//   );

//   const mc: any = await program.account.marketConfig.fetch(marketConfigPda);
//   console.log("market_config:", {
//     mintFeeBps: mc.mintFeeBps.toString(),
//     tradeFeeBps: mc.tradeFeeBps.toString(),
//     treasuryBump: mc.treasuryBump,
//     admin: mc.admin.toBase58(),
//   });

//   // === Metadata PDA ===
//   const [metadataPda] = PublicKey.findProgramAddressSync(
//     [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
//     METADATA_PROGRAM_ID
//   );
//   const royaltyBps = Math.floor((metadata.royalty || 0) * 100);

//   // === SPL mint untuk fee (UOG) ===
//   const splMint = new PublicKey(process.env.UOG_MINT!);

//   const sellerNftAta = getAssociatedTokenAddressSync(mintPubkey, sellerPk);
//   const sellerPaymentAta = getAssociatedTokenAddressSync(splMint, sellerPk);
//   const treasuryTokenAta = getAssociatedTokenAddressSync(splMint, treasuryPda, true);

//   const ataIxs: TransactionInstruction[] = [];

//   if (!(await connection.getAccountInfo(sellerPaymentAta))) {
//     ataIxs.push(
//       createAssociatedTokenAccountInstruction(userKp.publicKey, sellerPaymentAta, sellerPk, splMint)
//     );
//   }

//   if (!(await connection.getAccountInfo(treasuryTokenAta))) {
//     ataIxs.push(
//       createAssociatedTokenAccountInstruction(userKp.publicKey, treasuryTokenAta, treasuryPda, splMint)
//     );
//   }

//   // === Create mint account ===
//   const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
//   const createMintIx = SystemProgram.createAccount({
//     fromPubkey: userKp.publicKey,
//     newAccountPubkey: mintPubkey,
//     space: MINT_SIZE,
//     lamports,
//     programId: TOKEN_PROGRAM_ID,
//   });

//   const initMintIx = createInitializeMintInstruction(mintPubkey, 0, mintAuthPda, null);
//   const createSellerNftAtaIx = createAssociatedTokenAccountInstruction(
//     userKp.publicKey,
//     sellerNftAta,
//     sellerPk,
//     mintPubkey
//   );

//   // === mint_and_list ===
//   const txMintList = await program.methods
//     .mintAndList(
//       new anchor.BN(priceUnits),
//       useSol,
//       new anchor.BN(mintFeeSpl),
//       metadata.name,
//       metadata.symbol || "UOGNFT",
//       metadata.uri,
//       royaltyBps
//     )
//     .accountsStrict({
//       listing: listingPda,
//       escrowSigner: escrowSignerPda,
//       seller: sellerPk,
//       mint: mintPubkey,
//       sellerNftAta,
//       mintAuthority: mintAuthPda,
//       treasuryPda,
//       paymentMint: new PublicKey(paymentMint), // So111...
//       splMint,
//       treasuryTokenAccount: treasuryTokenAta,
//       sellerPaymentAta,
//       marketConfig: marketConfigPda,
//       metadata: metadataPda,
//       tokenMetadataProgram: METADATA_PROGRAM_ID,
//       payer: userKp.publicKey,
//       updateAuthority: userKp.publicKey,
//       tokenProgram: TOKEN_PROGRAM_ID,
//       systemProgram: SystemProgram.programId,
//       rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//     })
//     .transaction();

//   const txMint = new Transaction().add(
//     createMintIx,
//     initMintIx,
//     createSellerNftAtaIx,
//     ...ataIxs,
//     ...txMintList.instructions
//   );

//   txMint.feePayer = userKp.publicKey;
//   txMint.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
//   txMint.partialSign(mintKp, userKp);

//   console.log("🚀 Simulating...");
//   const sim = await connection.simulateTransaction(txMint);
//   if (sim.value.err) {
//     console.error("❌ Simulation failed:", sim.value.err);
//     console.error(sim.value.logs);
//     throw new Error("Simulation failed");
//   }

//   const sig = await connection.sendRawTransaction(txMint.serialize());
//   await connection.confirmTransaction(sig, "confirmed");
//   console.log("✅ mint_and_list confirmed:", sig);

//   return {
//     mintSignature: sig,
//     mint: mintPubkey.toBase58(),
//     listing: listingPda.toBase58(),
//     mintFeeSpl,
//     solToUogRate: uogPerSol,
//   };
// }