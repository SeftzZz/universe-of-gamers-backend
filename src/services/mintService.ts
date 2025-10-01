import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
  TransactionInstruction,
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
} from "@solana/spl-token";

import {
  createMetadataAccountV3,
} from "@metaplex-foundation/mpl-token-metadata/dist/src/generated/instructions/createMetadataAccountV3";


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

function asSigner(pk: PublicKey) {
  return {
    publicKey: pk,
    getPublicKey: () => pk,
    // tambahin ini biar mirip beneran Signer
    signTransaction: async <T>(tx: T) => {
      console.warn("⚠️ signTransaction() called unexpectedly");
      return tx;
    },
    signAllTransactions: async <T>(txs: T[]) => {
      console.warn("⚠️ signAllTransactions() called unexpectedly");
      return txs;
    },
    signMessage: async (msg: Uint8Array) => {
      console.warn("⚠️ signMessage() called unexpectedly");
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
  mintKp?: Keypair
) {
  console.log("=== 🏗️ BUILD MINT TRANSACTION START ===");

  const sellerPk = new PublicKey(owner);
  console.log("👤 Seller:", sellerPk.toBase58());
  console.log("🔑 Custodian (userKp):", userKp.publicKey.toBase58());

  // === Hitung harga ===
  let priceUnits = 0;
  let useSol = false;

  if (paymentMint === "So11111111111111111111111111111111111111112") {
    priceUnits = Math.ceil(metadata.price * anchor.web3.LAMPORTS_PER_SOL);
    useSol = true;
  } else {
    const mintInfo = await provider.connection.getParsedAccountInfo(
      new PublicKey(paymentMint)
    );
    if (!mintInfo.value) throw new Error("❌ Invalid payment mint");
    // @ts-ignore
    const decimals = mintInfo.value.data.parsed.info.decimals || 9;
    priceUnits = Math.ceil(metadata.price * 10 ** decimals);
  }

  console.log("💲 Payment Mint:", paymentMint);
  console.log("💲 Price Units:", priceUnits, " | Use SOL?", useSol);

  // 💰 Balance check
  const solBalance = await provider.connection.getBalance(sellerPk);
  console.log("💰 Seller SOL balance:", solBalance / anchor.web3.LAMPORTS_PER_SOL);

  // === Keypairs & PDAs ===
  const mintKeypair = mintKp || Keypair.generate();
  const mint = mintKeypair.publicKey;
  console.log("🪙 New Mint:", mint.toBase58());

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

  console.log("📌 PDAs:", {
    listingPda: listingPda.toBase58(),
    marketConfigPda: marketConfigPda.toBase58(),
    treasuryPda: treasuryPda.toBase58(),
    escrowSignerPda: escrowSignerPda.toBase58(),
    mintAuthPda: mintAuthPda.toBase58(),
  });

  // === Payment ATAs ===
  let ataIxs: TransactionInstruction[] = [];
  let treasuryTokenAccount: PublicKey;
  let sellerPaymentAta: PublicKey;

  if (!useSol) {
    const sellerRes = await ensureAtaExists(
      provider.connection,
      new PublicKey(paymentMint),
      sellerPk,
      sellerPk
    );
    sellerPaymentAta = sellerRes.ata;
    if (sellerRes.ix) ataIxs.push(sellerRes.ix);

    const treasuryRes = await ensureTreasuryAtaExists(
      provider.connection,
      new PublicKey(paymentMint),
      treasuryPda,
      sellerPk
    );
    treasuryTokenAccount = treasuryRes.ata;
    if (treasuryRes.ix) ataIxs.push(treasuryRes.ix);

    console.log("🏦 ATA:", {
      sellerPaymentAta: sellerPaymentAta.toBase58(),
      treasuryTokenAccount: treasuryTokenAccount.toBase58(),
    });
  } else {
    treasuryTokenAccount = SystemProgram.programId;
    sellerPaymentAta = SystemProgram.programId;
    console.log("🏦 Using SOL → treasury & sellerPaymentAta set to SystemProgram");
  }

  // === Create Mint Account ===
  const lamportsForMint =
    await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  console.log(
    "ℹ️ Rent-exempt for mint:",
    lamportsForMint / anchor.web3.LAMPORTS_PER_SOL,
    "SOL"
  );

  const createMintIx = SystemProgram.createAccount({
    fromPubkey: sellerPk,
    newAccountPubkey: mint,
    space: MINT_SIZE,
    lamports: lamportsForMint,
    programId: TOKEN_PROGRAM_ID,
  });
  const initMintIx = createInitializeMintInstruction(mint, 0, mintAuthPda, null);
  console.log("✅ Mint account + initMintIx ready");

  // === Create Seller NFT ATA ===
  const sellerNftAta = getAssociatedTokenAddressSync(mint, sellerPk);
  const createSellerNftAtaIx = createAssociatedTokenAccountInstruction(
    sellerPk,
    sellerNftAta,
    sellerPk,
    mint
  );
  console.log("🎯 Seller NFT ATA:", sellerNftAta.toBase58());

  // === Metadata PDA ===
  const mplTokenMetadataProgramId = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplTokenMetadataProgramId.toBuffer(), mint.toBuffer()],
    mplTokenMetadataProgramId
  );
  console.log("📜 Metadata PDA:", metadataPda.toBase58());

  const royaltyBps = Math.floor((metadata.royalty || 0) * 100);
  console.log("🎨 Metadata:", {
    name: metadata.name,
    symbol: metadata.symbol || "",
    uri: metadata.uri,
    royaltyBps,
  });

  console.log("👀 Metadata Accounts to pass:", {
    metadata: metadataPda.toBase58(),
    mint: mint.toBase58(),
    mintAuthority: userKp.publicKey.toBase58(),
    payer: userKp.publicKey.toBase58(),
    updateAuthority: userKp.publicKey.toBase58(),
  });

  const createMetadataIx = (createMetadataAccountV3 as any)(
    {
      metadata: metadataPda.toBase58(),
      mint: mint.toBase58(),
      mintAuthority: userKp.publicKey.toBase58(),
      payer: userKp.publicKey.toBase58(),
      updateAuthority: userKp.publicKey.toBase58(),
    },
    {
      data: {
        name: metadata.name,
        symbol: metadata.symbol || "",
        uri: metadata.uri,
        sellerFeeBasisPoints: royaltyBps,
        creators: null,
        collection: null,
        uses: null,
      },
      isMutable: true,
      collectionDetails: null,
    }
  );

  console.log("✅ Metadata instruction built");

  // === Anchor Program call (mintAndList) ===
  const mintAndListInstruction = await program.methods
    .mintAndList(
      new BN(priceUnits),
      useSol,
      metadata.name,
      metadata.symbol || "",
      metadata.uri,
      royaltyBps
    )
    .accounts({
      listing: listingPda,
      marketConfig: marketConfigPda,
      treasuryPda,
      paymentMint: new PublicKey(paymentMint),
      treasuryTokenAccount,
      sellerPaymentAta,
      escrowSigner: escrowSignerPda,
      seller: sellerPk,
      sellerNftAta,
      mintAuthority: mintAuthPda,
      mint,
      metadata: metadataPda,
      tokenMetadataProgram: mplTokenMetadataProgramId,
      payer: sellerPk,
      updateAuthority: sellerPk,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  console.log("🚀 mintAndList instruction ready");

  // === Build TX ===
  const tx = new Transaction().add(
    createMintIx,
    initMintIx,
    ...ataIxs,
    createSellerNftAtaIx,
    createMetadataIx,
    mintAndListInstruction
  );

  tx.feePayer = sellerPk;
  tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;

  // Partial sign mint
  tx.partialSign(mintKeypair);
  tx.partialSign(userKp);

  console.log("📝 Transaction built & signed (partial)");
  console.log("=== ✅ BUILD MINT TRANSACTION DONE ===");

  return {
    tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    debug: {
      mint: mint.toBase58(),
      listingPda: listingPda.toBase58(),
      treasuryPda: treasuryPda.toBase58(),
      sellerAta: sellerNftAta.toBase58(),
      treasuryTokenAccount: treasuryTokenAccount.toBase58(),
      sellerPaymentAta: sellerPaymentAta.toBase58(),
      metadataPda: metadataPda.toBase58(),
      useSol,
      paymentMint,
    },
  };
}
