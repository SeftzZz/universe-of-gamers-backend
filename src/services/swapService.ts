import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  createApproveInstruction,
  NATIVE_MINT,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import { LAMPORTS_PER_SOL, AccountMeta } from "@solana/web3.js";

export const WSOL_MINT = NATIVE_MINT;

// ==================== SEPARATE FUNCTIONS ====================

/**
 * Validate user has sufficient balances for the swap
 */
async function validateUserBalances(
  connection: Connection,
  fromPubkey: PublicKey,
  fromMintPublicKey: PublicKey,
  inAmount: string,
  outputMint: PublicKey
): Promise<void> {
  console.log("💰 Validating user balances...");

  // === 1. Input check ===
  if (fromMintPublicKey.equals(NATIVE_MINT)) {
    // Input = SOL → check lamports
    const solBalance = await connection.getBalance(fromPubkey);
    console.log(`   SOL balance: ${solBalance}, Required: ${inAmount}`);
    if (solBalance < Number(inAmount)) {
      throw new Error(
        `Insufficient SOL balance. Required: ${inAmount}, Available: ${solBalance}`
      );
    }
  } else {
    // Input = SPL token
    const userInputATA = await getAssociatedTokenAddress(fromMintPublicKey, fromPubkey);
    try {
      const tokenAccountInfo = await getAccount(connection, userInputATA);
      const userTokenBalance = Number(tokenAccountInfo.amount);
      console.log(`   Input token balance: ${userTokenBalance}, Required: ${inAmount}`);

      if (userTokenBalance < Number(inAmount)) {
        throw new Error(
          `Insufficient token balance. Required: ${inAmount}, Available: ${userTokenBalance}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Account does not exist")) {
        throw new Error(
          `User does not have token account for input mint: ${fromMintPublicKey.toBase58()}`
        );
      }
      throw error;
    }
  }

  // === 2. Check SOL for fees ===
  const solBalance = await connection.getBalance(fromPubkey);
  const estimatedFee = 100000; // ~0.0001 SOL
  console.log(
    `   SOL balance for fees: ${solBalance / LAMPORTS_PER_SOL} SOL, Required ~${estimatedFee / LAMPORTS_PER_SOL} SOL`
  );

  if (solBalance < estimatedFee) {
    throw new Error(
      `Insufficient SOL for fees. Required: ~${estimatedFee} lamports, Available: ${solBalance}`
    );
  }
}

/**
 * Load UOG program and parse DFLOW transaction
 */
async function loadProgramAndParseTransaction(
  connection: Connection,
  openTransaction: string,
  fromPubkey: PublicKey
): Promise<{ programUog: anchor.Program; aggIx: TransactionInstruction; metas: any[]; ixData: Buffer }> {
  const provider = new anchor.AnchorProvider(connection, {} as any, {
    preflightCommitment: "confirmed",
  });

  // Load UOG marketplace IDL
  const idlUog = require("../../public/idl/universe_of_gamers.json");
  const programUog = new anchor.Program(
    idlUog,
    new PublicKey(process.env.PROGRAM_ID as string),
    provider
  );

  // Parse DFLOW transaction
  const tx = Transaction.from(Buffer.from(openTransaction, "base64"));

  // Find DFLOW instruction
  const ixIndex = tx.instructions.findIndex(
    (ix) => ix.programId.toBase58().startsWith("DF1o")
  );
  if (ixIndex < 0) throw new Error("❌ DFLOW instruction not found in tx");

  const aggIx = tx.instructions[ixIndex];
  const metas = [
    ...aggIx.keys,   // aggregator accounts
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const ixData = aggIx.data;

  return { programUog, aggIx, metas, ixData };
}

/**
 * Get program derived addresses
 */
async function getProgramDerivedAddresses(
  programUog: anchor.Program
): Promise<[PublicKey, PublicKey]> {
  const [marketConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market_config")],
    programUog.programId
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    programUog.programId
  );

  return [marketConfigPda, treasuryPda];
}

/**
 * Prepare token accounts and instructions for the swap
 */
async function prepareTokenAccountsAndInstructions(
  connection: Connection,
  fromPubkey: PublicKey,
  fromMint: PublicKey,
  inAmount: string,
  outputMint: PublicKey,
  treasuryPda: PublicKey,
  programUog: anchor.Program,
  marketConfigPda: PublicKey,
  outAmount: string
): Promise<{
  userInTokenAccount: PublicKey;
  userOutTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  preInstructions: TransactionInstruction[];
  extraPostInstructions: TransactionInstruction[];
}> {
  let userInTokenAccount: PublicKey;
  let userOutTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;
  const preInstructions: TransactionInstruction[] = [];
  const extraPostInstructions: TransactionInstruction[] = [];

  // === Input handling ===
  if (fromMint.equals(NATIVE_MINT)) {
    // Input = SOL → wrap ke WSOL ATA
    userInTokenAccount = await prepareWSOLInputAccount(
      connection,
      fromPubkey,
      inAmount,
      preInstructions
    );
  } else {
    // Input = SPL token
    userInTokenAccount = await getAssociatedTokenAddress(fromMint, fromPubkey);
  }

  // === Output handling ===
  if (outputMint.equals(NATIVE_MINT)) {
    // ✅ Output = native SOL → userOut pakai WSOL ATA
    userOutTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, treasuryPda, true);

    console.log("⚡ Output is native SOL (handled via WSOL ATA)");
    console.log("   User WSOL ATA     :", userOutTokenAccount.toBase58());
    console.log("   Treasury WSOL ATA :", treasuryTokenAccount.toBase58());

    // === Create ATA kalau belum ada ===
    const userOutInfo = await connection.getAccountInfo(userOutTokenAccount);
    if (!userOutInfo) {
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          userOutTokenAccount,
          fromPubkey,
          WSOL_MINT
        )
      );
      preInstructions.push(createSyncNativeInstruction(userOutTokenAccount));
    }

    const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
    if (!treasuryInfo) {
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          treasuryTokenAccount,
          treasuryPda,
          WSOL_MINT
        )
      );
      preInstructions.push(createSyncNativeInstruction(treasuryTokenAccount));
    }

    // === Hitung fee + approve untuk SOL case ===
    const marketConfig: any = await programUog.account.marketConfig.fetch(marketConfigPda);
    const tradeFeeBps: number = marketConfig.tradeFeeBps ?? marketConfig.trade_fee_bps;
    const outAmountRaw = BigInt(outAmount);
    const trade_fee = (outAmountRaw * BigInt(tradeFeeBps)) / BigInt(10_000);

    console.log("💸 Approving delegate for trade_fee (SOL):", trade_fee.toString());

    preInstructions.push(
      createApproveInstruction(
        userOutTokenAccount,  // source ATA (WSOL user)
        treasuryPda,          // delegate = treasury PDA
        fromPubkey,           // owner = user wallet
        Number(trade_fee)     // jumlah fee
      )
    );

    console.log("✅ Approve instruction pushed (SOL case)");
    console.log("   userOutTokenAccount (source):", userOutTokenAccount.toBase58());
    console.log("   treasuryTokenAccount (destination):", treasuryTokenAccount.toBase58());
    console.log("   delegate (treasuryPda):", treasuryPda.toBase58());
    console.log("   owner (fromPubkey):", fromPubkey.toBase58());
    console.log("   trade_fee (lamports):", trade_fee.toString());

    // === Setelah swap selesai → unwrap WSOL kembali ke SOL ===
    extraPostInstructions.push(
      createCloseAccountInstruction(
        userOutTokenAccount,
        fromPubkey, // SOL kembali ke wallet user
        fromPubkey
      )
    );
  } else {
    // ✅ Output = SPL biasa
    const result = await prepareSPLOutputAccounts(
      connection,
      fromPubkey,
      outputMint,
      treasuryPda,
      preInstructions
    );

    userOutTokenAccount = result.userOutTokenAccount;
    treasuryTokenAccount = result.treasuryTokenAccount;
    preInstructions.push(...result.preInstructions);

    // Hitung fee SPL
    const marketConfig: any = await programUog.account.marketConfig.fetch(marketConfigPda);
    const tradeFeeBps: number = marketConfig.tradeFeeBps ?? marketConfig.trade_fee_bps;
    const outAmountRaw = BigInt(outAmount);
    const trade_fee = (outAmountRaw * BigInt(tradeFeeBps)) / BigInt(10_000);

    console.log("   Estimated trade fee (SPL):", trade_fee.toString());

    preInstructions.push(
      createApproveInstruction(
        userOutTokenAccount,  // source ATA (SPL user)
        treasuryPda,          // delegate = treasury PDA
        fromPubkey,           // owner = user wallet
        Number(trade_fee)     // jumlah fee
      )
    );

    console.log("✅ Approve instruction pushed (SPL case)");
    console.log("   userOutTokenAccount (source):", userOutTokenAccount.toBase58());
    console.log("   treasuryTokenAccount (destination):", treasuryTokenAccount.toBase58());
    console.log("   delegate (treasuryPda):", treasuryPda.toBase58());
    console.log("   owner (fromPubkey):", fromPubkey.toBase58());
    console.log("   trade_fee (lamports):", trade_fee.toString());
  }

  return { userInTokenAccount, userOutTokenAccount, treasuryTokenAccount, preInstructions, extraPostInstructions };
}

/**
 * Prepare accounts for SPL token output
 */
async function prepareSPLOutputAccounts(
  connection: Connection,
  fromPubkey: PublicKey,
  outputMint: PublicKey,
  treasuryPda: PublicKey,
  preInstructions: TransactionInstruction[]
): Promise<{
  userOutTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
  preInstructions: TransactionInstruction[];
}> {
  let userOutTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  if (outputMint.equals(WSOL_MINT)) {
    // ✅ Kalau output = SOL → userOut harus ATA WSOL, bukan pubkey langsung
    userOutTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, treasuryPda, true);

    console.log("⚡ Output is SOL → pakai WSOL ATA");
    console.log("   User WSOL ATA :", userOutTokenAccount.toBase58());
    console.log("   Treasury WSOL ATA:", treasuryTokenAccount.toBase58());
  } else {
    // ✅ Output = SPL biasa
    userOutTokenAccount = await getAssociatedTokenAddress(outputMint, fromPubkey, false);
    treasuryTokenAccount = await getAssociatedTokenAddress(outputMint, treasuryPda, true);

    console.log("⚡ Output is SPL → pakai Treasury ATA SPL");
    console.log("   SPL mint      :", outputMint.toBase58());
    console.log("   Treasury ATA  :", treasuryTokenAccount.toBase58());
  }

  // === Create ATA kalau belum ada ===
  const userOutInfo = await connection.getAccountInfo(userOutTokenAccount);
  if (!userOutInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        userOutTokenAccount,
        fromPubkey,
        outputMint
      )
    );
    if (outputMint.equals(WSOL_MINT)) {
      preInstructions.push(createSyncNativeInstruction(userOutTokenAccount));
    }
  }

  const treasuryInfo = await connection.getAccountInfo(treasuryTokenAccount);
  if (!treasuryInfo) {
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        treasuryTokenAccount,
        treasuryPda,
        outputMint
      )
    );
    if (outputMint.equals(WSOL_MINT)) {
      preInstructions.push(createSyncNativeInstruction(treasuryTokenAccount));
    }
  }

  return { userOutTokenAccount, treasuryTokenAccount, preInstructions };
}

async function prepareWSOLInputAccount(
  connection: Connection,
  fromPubkey: PublicKey,
  inAmount: string,
  preInstructions: TransactionInstruction[]
): Promise<PublicKey> {
  const userWSOLATA = await getAssociatedTokenAddress(WSOL_MINT, fromPubkey, false);

  const ataInfo = await connection.getAccountInfo(userWSOLATA);
  if (!ataInfo || ataInfo.owner.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
    console.log("⚙️ Recreating WSOL ATA (missing or not owned by token program)");
    preInstructions.push(
      createAssociatedTokenAccountInstruction(
        fromPubkey,
        userWSOLATA,
        fromPubkey,
        WSOL_MINT
      )
    );
  } else {
    // valid account tapi pastikan state initialized
    try {
      const parsed = await getAccount(connection, userWSOLATA);
      if (!parsed.isInitialized) {
        console.log("⚙️ Reinitializing WSOL ATA (was closed or uninitialized)");
        preInstructions.push(
          createAssociatedTokenAccountInstruction(
            fromPubkey,
            userWSOLATA,
            fromPubkey,
            WSOL_MINT
          )
        );
      }
    } catch (err: any) {
      console.warn("⚠️ WSOL ATA parse failed, creating new one:", err.message);
      preInstructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey,
          userWSOLATA,
          fromPubkey,
          WSOL_MINT
        )
      );
    }
  }

  // Hitung rent-exempt minimum
  const rentExemptLamports = await connection.getMinimumBalanceForRentExemption(165); // size token account
  const solBalance = await connection.getBalance(fromPubkey);

  const required = Number(inAmount) + rentExemptLamports + 100000; // +fee buffer
  if (solBalance < required) {
    throw new Error(
      `Not enough SOL. Required ${required}, available ${solBalance}`
    );
  }

  const buffer = Math.ceil(Number(inAmount) * 0.002 * LAMPORTS_PER_SOL); // 0.2% buffer
  const lamportsToWrap = Number(inAmount) + buffer;

  const bal = await connection.getBalance(userWSOLATA);
  console.log("💵 WSOL ATA current balance:", bal / LAMPORTS_PER_SOL);
  console.log("🧮 inAmount:", Number(inAmount) / LAMPORTS_PER_SOL);
  if (bal < Number(inAmount)) console.warn("⚠️ WSOL ATA balance < inAmount! Will fail swap.");

  // Transfer hanya inAmount (bukan +rentExempt, karena rentExempt sudah otomatis di ATA saat dibuat)
  preInstructions.push(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey: userWSOLATA,
      lamports: lamportsToWrap,
    })
  );

  preInstructions.push(
    createSyncNativeInstruction(userWSOLATA)
  );
  preInstructions.push(
    createApproveInstruction(
      userWSOLATA,
      TOKEN_PROGRAM_ID,
      fromPubkey,
      Number(inAmount)
    )
  );

  console.log("⚡ Input is SOL → wrap jadi WSOL ATA:", userWSOLATA.toBase58());
  return userWSOLATA;
}

/**
 * Build the main swap instruction
 */
async function buildSwapInstruction(
  programUog: anchor.Program,
  ixData: Buffer,
  fromPubkey: PublicKey,
  dexProgram: PublicKey,
  marketConfigPda: PublicKey,
  treasuryPda: PublicKey,
  outputMint: PublicKey,
  treasuryTokenAccount: PublicKey,
  userOutTokenAccount: PublicKey,
  metas: any[],
  inAmount: string
): Promise<TransactionInstruction> {
  // ⚠️ Jangan hapus satu pun dari metas DFLOW.
  // Hanya pastikan user wallet jadi signer (DFLOW perlu itu).
  const finalMetas = metas.map((m) =>
    m.pubkey.equals(fromPubkey)
      ? { pubkey: m.pubkey, isSigner: true, isWritable: true }
      : m
  );

  console.log("🧾 Final metas (no filter, preserving DFLOW order):");
  finalMetas.forEach((m, i) =>
    console.log(`[${i}] ${m.pubkey.toBase58()} signer=${m.isSigner}`)
  );

  // 🚀 Panggil swapToken seperti biasa
  return await programUog.methods
    .swapToken(ixData, new anchor.BN(inAmount))
    .accounts({
      user: fromPubkey,
      dexProgram,
      marketConfig: marketConfigPda,
      treasuryPda,
      outputMint,
      treasuryTokenAccount,
      userOutTokenAccount,
    })
    .remainingAccounts(finalMetas)
    .instruction();
}

/**
 * Build and finalize the transaction
 */
async function buildFinalTransaction(
  connection: Connection,
  fromPubkey: PublicKey,
  preInstructions: TransactionInstruction[],
  ix: TransactionInstruction,
  extraPostInstructions: TransactionInstruction[],
  userInTokenAccount: PublicKey,
  userOutTokenAccount: PublicKey,
  treasuryTokenAccount: PublicKey,
  treasuryPda: PublicKey
): Promise<Transaction> {
  // Compute budget + priority fee
  const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

  // Debug account ownership
  await logAccountOwner(connection, "UserInTokenAccount", userInTokenAccount);
  await logAccountOwner(connection, "User ATA", userOutTokenAccount);
  await logAccountOwner(connection, "Treasury ATA", treasuryTokenAccount);
  await logAccountOwner(connection, "Treasury PDA", treasuryPda);
  await logAccountOwner(connection, "From wallet", fromPubkey);

  // Build final transaction
  const txOut = new Transaction().add(
    modifyComputeUnits,
    addPriorityFee,
    ...preInstructions,
    ix,
    ...extraPostInstructions
  );

  txOut.feePayer = fromPubkey;
  console.log("🧾 FeePayer:", txOut.feePayer.toBase58());

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  console.log("   Blockhash:", blockhash, "LastValidBlockHeight:", lastValidBlockHeight);
  txOut.recentBlockhash = blockhash;

  return txOut;
}

const DFLOW_PROGRAM_ID = new PublicKey("DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
const EVENT_AUTHORITY = new PublicKey("8xeaWCsJYxRoudEZGJWURdfrtFhLYZz9b4iHJnW5tb3d");
const SWAP2_DISCRIMINATOR = Uint8Array.from([65, 75, 63, 76, 235, 91, 91, 136]);

async function buildDFlowSwap2Instruction(
  userAuthority: PublicKey,
  fromMint: PublicKey,
  toMint: PublicKey,
  inAmount: bigint,
  outAmount: bigint,
  baseMetas: AccountMeta[]
) {
  /**
   * Encoding sesuai IDL:
   * actions: Vec<Action> → kosong (u32 length = 0)
   * quoted_out_amount: u64 → dari outAmount
   * slippage_bps: u16 → misal 50
   * platform_fee_bps: u16 → misal 0
   * positive_slippage_fee_limit_pct: u8 → misal 1
   */
  const slippage_bps = 300;
  const platform_fee_bps = 0;
  const positive_slippage_fee_limit_pct = 1;

  const data = Buffer.concat([
    Buffer.from(SWAP2_DISCRIMINATOR), // 8 bytes
    Buffer.from(new Uint32Array([0]).buffer), // Vec<Action> kosong
    Buffer.from(new BN(outAmount).toArray("le", 8)), // quoted_out_amount
    Buffer.from(new Uint16Array([slippage_bps]).buffer),
    Buffer.from(new Uint16Array([platform_fee_bps]).buffer),
    Buffer.from(new Uint8Array([positive_slippage_fee_limit_pct])),
  ]);

  const keys: AccountMeta[] = [
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: userAuthority, isSigner: true, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: DFLOW_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: DFLOW_PROGRAM_ID,
    keys,
    data,
  });
}

async function buildRaydiumCpmmswapInstruction({
  userAuthority,
  poolId,           // ✅ sudah konsisten
  ammConfig,
  inputMint,
  outputMint,
  amountIn,
  minOut,
}: {
  userAuthority: PublicKey;
  poolId: PublicKey; // ✅ sesuai
  ammConfig: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  minOut: bigint;
}): Promise<TransactionInstruction> {
  const RAYDIUM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

  // === discriminator from IDL ===
  const SWAP_BASE_INPUT_DISCRIMINATOR = Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]);

  // === encode args ===
  const data = Buffer.concat([
    SWAP_BASE_INPUT_DISCRIMINATOR,
    Buffer.from(new BN(amountIn).toArray("le", 8)),
    Buffer.from(new BN(minOut).toArray("le", 8)),
  ]);

  // === derive required PDAs ===
  const inputATA = getAssociatedTokenAddressSync(inputMint, userAuthority, false);
  const outputATA = getAssociatedTokenAddressSync(outputMint, userAuthority, false);
  const [inputVault] = await PublicKey.findProgramAddress(
    [Buffer.from("pool_vault"), poolId.toBuffer(), inputMint.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );
  const [outputVault] = await PublicKey.findProgramAddress(
    [Buffer.from("pool_vault"), poolId.toBuffer(), outputMint.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );
  const [authority] = await PublicKey.findProgramAddress(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    RAYDIUM_PROGRAM_ID
  );
  const [observationState] = await PublicKey.findProgramAddress(
    [Buffer.from("observation"), poolId.toBuffer()],
    RAYDIUM_PROGRAM_ID
  );

  console.log("🧩 Raydium Swap ATA check:");
  console.log("   Input ATA :", inputATA.toBase58());
  console.log("   Output ATA:", outputATA.toBase58());

  if (inputMint.toBase58() === "So11111111111111111111111111111111111111112") {
    console.log("⚡ Overriding native SOL → WSOL ATA for Raydium input");
  }

  // === accounts layout from IDL ===
  const keys: AccountMeta[] = [
    { pubkey: userAuthority, isSigner: true, isWritable: true }, // payer
    { pubkey: authority, isSigner: false, isWritable: false },
    { pubkey: ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolId, isSigner: false, isWritable: true },
    { pubkey: inputATA, isSigner: false, isWritable: true },
    { pubkey: outputATA, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // input_token_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // output_token_program
    { pubkey: inputMint, isSigner: false, isWritable: false },
    { pubkey: outputMint, isSigner: false, isWritable: false },
    { pubkey: observationState, isSigner: false, isWritable: true },
  ];

  if (inputMint.toBase58() === "So11111111111111111111111111111111111111112") {
    keys[4].pubkey = inputATA; // force replace slot input_token_account
    console.log("✅ Overriding input_token_account slot →", inputATA.toBase58());
  }

  return new TransactionInstruction({
    programId: RAYDIUM_PROGRAM_ID,
    keys,
    data,
  });
}

async function logAccountOwner(
  connection: Connection,
  label: string,
  pubkey: PublicKey
) {
  try {
    const info = await connection.getAccountInfo(pubkey);
    if (info?.owner) {
      console.log(`🔍 ${label}: ${pubkey.toBase58()} owner=${info.owner.toBase58()}`);
    } else {
      console.log(`🔍 ${label}: ${pubkey.toBase58()} (no owner or not found)`);
    }
  } catch (err: any) {
    console.log(`⚠️ Failed to fetch owner for ${label}:`, err.message);
  }
}

// ============================================================
// ✅ Explicit exports to ensure TypeScript compiler sees them
// ============================================================
export {
  validateUserBalances,
  loadProgramAndParseTransaction,
  getProgramDerivedAddresses,
  prepareTokenAccountsAndInstructions,
  buildSwapInstruction,
  buildFinalTransaction,
  buildDFlowSwap2Instruction,
  buildRaydiumCpmmswapInstruction,
};

