import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  Keypair,
} from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { BN } from "@project-serum/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

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
  price?: number; // dalam SOL
  royalty?: number; // %
}

export async function buildMintTransaction(
  owner: string,
  metadata: MintMetadata
) {
  const sellerPk = new PublicKey(owner);

  const priceLamports = Math.floor(Number(metadata.price || 0) * LAMPORTS_PER_SOL);
  const royaltyPercent = Number(metadata.royalty || 0);
  const royaltyBps = Math.floor(royaltyPercent * 100);

  // === Buat mint baru ===
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const sellerAta = getAssociatedTokenAddressSync(mint, sellerPk);

  const mplTokenMetadataProgramId = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );

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

  const lamportsForMint =
    await provider.connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const createMintIx = SystemProgram.createAccount({
    fromPubkey: sellerPk,
    newAccountPubkey: mint,
    space: MINT_SIZE,
    lamports: lamportsForMint,
    programId: TOKEN_PROGRAM_ID,
  });

  const initMintIx = createInitializeMintInstruction(mint, 0, mintAuthPda, null);
  const createAtaIx = createAssociatedTokenAccountInstruction(
    sellerPk,
    sellerAta,
    sellerPk,
    mint
  );

  const ix = await program.methods
    .mintAndList(
      new BN(priceLamports),
      true,
      metadata.name,
      metadata.symbol || "",
      metadata.uri,
      royaltyBps
    )
    .accounts({
      listing: listingPda,
      marketConfig: marketConfigPda,
      treasuryPda,
      escrowSigner: escrowSignerPda,
      seller: sellerPk,
      sellerNftAta: sellerAta,
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

  const tx = new Transaction().add(createMintIx, initMintIx, createAtaIx, ix);
  tx.feePayer = sellerPk;
  tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;
  tx.partialSign(mintKp);

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });

  return {
    tx: serialized.toString("base64"),
    debug: {
      mint: mint.toBase58(),
      listingPda: listingPda.toBase58(),
      treasuryPda: treasuryPda.toBase58(),
      sellerAta: sellerAta.toBase58(),
    },
  };
}
