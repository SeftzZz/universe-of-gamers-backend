import * as anchor from "@project-serum/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "bn.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export async function mintNftWithAnchor(metadata: any) {
  console.log("📦 Metadata diterima di anchorService:", metadata);

  const programIdStr = process.env.PROGRAM_ID;
  if (!programIdStr) throw new Error("❌ PROGRAM_ID is missing in .env");

  const programID = new PublicKey(programIdStr.trim());
  const idl = require("../../target/idl/uog_marketplace.json");

  // 🔍 Tambahkan log debug
  console.log("⚙️ [anchorService] PROGRAM_ID =", programID.toBase58());
  console.log("⚙️ [anchorService] IDL name   =", idl.name);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, programID, provider);

  if (!metadata.owner) throw new Error("❌ Missing seller (owner)");
  const sellerPk = new PublicKey(metadata.owner);

  // Mint baru
  const mintKeypair = anchor.web3.Keypair.generate();

  // --- Derive PDA sesuai Rust ---
  const [listingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("listing"), mintKeypair.publicKey.toBuffer()],
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
    [Buffer.from("escrow_signer"), mintKeypair.publicKey.toBuffer()],
    program.programId
  );
  const [mintAuthPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_auth"), mintKeypair.publicKey.toBuffer()],
    program.programId
  );

  const mplTokenMetadataProgramId = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), mplTokenMetadataProgramId.toBuffer(), mintKeypair.publicKey.toBuffer()],
    mplTokenMetadataProgramId
  );

  const sellerAta = getAssociatedTokenAddressSync(mintKeypair.publicKey, sellerPk);

  console.log("👉 Accounts yang akan dipakai:", {
    listing: listingPda.toBase58(),
    marketConfig: marketConfigPda.toBase58(),
    treasury: treasuryPda.toBase58(),
    escrowSigner: escrowSignerPda.toBase58(),
    seller: sellerPk.toBase58(),
    sellerAta: sellerAta.toBase58(),
    mint: mintKeypair.publicKey.toBase58(),
    mintAuth: mintAuthPda.toBase58(),
    metadata: metadataPda.toBase58(),
  });

  // --- Call program ---
  const tx = await program.methods
    .mintAndList(
      new BN(metadata.price),
      true,
      metadata.name,
      metadata.symbol || "",
      metadata.uri,
      metadata.royaltyBps || 0
    )
    .accounts({
      listing: listingPda,
      escrowSigner: escrowSignerPda,
      seller: sellerPk,
      mint: mintKeypair.publicKey,
      sellerNftAta: sellerAta,
      mintAuthority: mintAuthPda,
      treasuryPda: treasuryPda,
      marketConfig: marketConfigPda,
      metadata: metadataPda,
      tokenMetadataProgram: mplTokenMetadataProgramId,
      payer: sellerPk,
      updateAuthority: sellerPk,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .signers([mintKeypair])
    .rpc();

  console.log("✅ Mint tx berhasil:", tx);
  return tx;
}
