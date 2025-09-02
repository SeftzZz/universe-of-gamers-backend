import { Router, Request, Response } from "express";
import { 
  Connection, 
  PublicKey,
  LAMPORTS_PER_SOL, 
  Keypair, 
  Transaction, 
  SystemProgram, 
  sendAndConfirmTransaction,
  VersionedTransaction,
  TransactionMessage,
  LoadedAddresses,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import dotenv from "dotenv";
import { getPriceInfo } from "../services/priceService";
import { getMint } from "@solana/spl-token";

import WalletBalance from "../models/WalletBalance";
import WalletToken from "../models/WalletToken";
import { Nft } from "../models/Nft";
const fs = require("fs");

dotenv.config();
const router = Router();

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UOG_MINT = "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk";
const CUSTOM_TOKENS: Record<string, { id: string, symbol: string, name: string, logoURI: string }> = {
  "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk": {
    id: "universe-of-gamers",
    symbol: "UOG",
    name: "Universe Of Gamers",
    logoURI: "https://assets.coingecko.com/coins/images/68112/standard/IMG_0011.jpeg" // link resmi coingecko
  }
};
// 🔑 Registry default (phantom-like)
const REGISTRY: Record<
  string,
  { name: string; symbol: string; logoURI: string; decimals: number }
> = {
  [SOL_MINT]: {
    name: "Solana",
    symbol: "SOL",
    logoURI:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/info/logo.png",
    decimals: 9,
  },
  [USDC_MINT]: {
    name: "USD Coin",
    symbol: "USDC",
    logoURI:
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/solana/assets/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
    decimals: 6,
  },
  [UOG_MINT]: {
    name: "Universe Of Gamers",
    symbol: "UOG",
    logoURI:
      "https://assets.coingecko.com/coins/images/68112/standard/IMG_0011.jpeg",
    decimals: 9,
  },
};

const AMM_PROGRAMS: Record<string, string> = {
  // Raydium AMM v4
  "HevUp4n4swwEWLvPVxrVey8cnKB8PBFRNTBb5BJ9dxiW": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  // Raydium CLMM
  "CAMMCzo5YLs9gDSPJkM2kN1U79hgXaqvC8mqwpRooS4q": "Raydium CLMM",
  // Lifinity
  "Lifinityj111111111111111111111111111111111111": "Lifinity AMM",
  // Meteora DLMM
  "DLMM11111111111111111111111111111111111111111": "Meteora DLMM",
};

// const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const DUMMY = "11111111111111111111111111111111";

const makeAcc = (pubkey: string | null, isSigner = false, isWritable = false) =>
  pubkey
    ? { pubkey, isSigner, isWritable }
    : { pubkey: DUMMY, isSigner: false, isWritable: false };

export async function buildOrderedAccounts(
  connection: Connection,
  user: PublicKey,
  fromMint: PublicKey,
  toMint: PublicKey,
) {
  const userPk = new PublicKey(user);

  // ✅ resolve ATA WSOL & UOG
  const wsolATA = await getAssociatedTokenAddress(new PublicKey(fromMint), userPk, false, TOKEN_PROGRAM_ID);
  const uogATA  = await getAssociatedTokenAddress(new PublicKey(toMint), userPk, false, TOKEN_PROGRAM_ID);

  // Cari PDA programAuthority Jupiter
  const [programAuthority] = await PublicKey.findProgramAddress(
    [Buffer.from("authority")],
    new PublicKey(JUPITER_PROGRAM)
  );
  console.log("🔑 Jupiter programAuthority PDA:", programAuthority.toBase58());

  // Resolve ATA untuk WSOL dan UOG (punya programAuthority)
  const wsolATA_program = await getAssociatedTokenAddress(
    new PublicKey("So11111111111111111111111111111111111111112"),
    programAuthority,
    true,
    TOKEN_PROGRAM_ID
  );

  const uogATA_program = await getAssociatedTokenAddress(
    new PublicKey("B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk"),
    programAuthority,
    true,
    TOKEN_PROGRAM_ID
  );

  console.log("🔎 ProgramAuthority WSOL ATA:", wsolATA_program.toBase58());
  console.log("🔎 ProgramAuthority UOG  ATA:", uogATA_program.toBase58());

  // convert ke string
  const wsolATAstr = wsolATA.toBase58();
  const uogATAstr = uogATA.toBase58();

  const ordered = [
    makeAcc(TOKEN_PROGRAM_ID.toBase58()),       // [0] token_program
    makeAcc(JUPITER_PROGRAM),                   // [1] program_authority
    makeAcc(user.toBase58(), true, true),       // [2] user_transfer_authority
    makeAcc(wsolATA.toBase58(), false, true),   // [3] source_token_account
    makeAcc(wsolATA_program.toBase58(), false, true),   // [4] program_source_token_account
    makeAcc(uogATA_program.toBase58(), false, true),    // [5] program_destination_token_account
    makeAcc(uogATA.toBase58(), false, true),    // [6] destination_token_account
    makeAcc(fromMint.toBase58()),               // [7] source_mint
    makeAcc(toMint.toBase58()),                 // [8] destination_mint
    makeAcc(null, false, true),                 // [9] platform_fee_account
    makeAcc(null),                              // [10] token_2022_program
    makeAcc(EVENT_AUTHORITY),                   // [11] event_authority
    makeAcc(JUPITER_PROGRAM),                   // [12] program
  ];

  // 🔍 Debug output
  const labels = [
    "token_program",
    "program_authority",
    "user_transfer_authority",
    "source_token_account",
    "program_source_token_account",
    "program_destination_token_account",
    "destination_token_account",
    "source_mint",
    "destination_mint",
    "platform_fee_account",
    "token_2022_program",
    "event_authority",
    "program",
  ];

  console.log("🔎 OrderedAccounts (auto resolved ATA):");
  ordered.forEach((acc, i) => {
    console.log(
      `[${i}] ${labels[i]} ${acc.pubkey} (signer=${acc.isSigner}, writable=${acc.isWritable})`
    );
  });

  return ordered;
}

const rpc = process.env.SOLANA_CLUSTER;
console.log("⚙️ [wallet.ts] RPC   =", rpc);

function formatError(err: any) {
  let logs: string[] = [];
  let message = err.message || "Unexpected error";

  // Tangkap logs dari SendTransactionError (web3.js)
  if (err.logs) {
    logs = err.logs;
  } else if (typeof err.message === "string" && err.message.includes("Logs:")) {
    // Extract logs array dari string message
    const match = err.message.match(/\[([\s\S]*)\]/m);
    if (match) {
      try {
        logs = JSON.parse(match[0]);
      } catch {
        logs = match[0].split("\n").map(l => l.trim()).filter(Boolean);
      }
    }
  }

  // Bersihkan message utama (hilangkan block Logs:)
  if (message.includes("Logs:")) {
    message = message.split("Logs:")[0].trim();
  }

  return {
    success: false,
    error: {
      message,
      logs,
      details: err.response?.data ?? null,
    },
  };
}

// Helper konversi UI amount -> raw integer amount
async function toRawAmount(mintAddress: string, uiAmount: number): Promise<bigint> {
  const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");

  const mintInfo = await getMint(connection, new PublicKey(mintAddress));
  const decimals = mintInfo.decimals;
  const raw = BigInt(Math.floor(uiAmount * 10 ** decimals));
  return raw;
}

//
// GET /wallet/balance/:address
//
router.get("/balance/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address) return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const pubkey = new PublicKey(address);
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / LAMPORTS_PER_SOL;

    // ambil harga SOL dari CoinGecko
    const solInfo = await getPriceInfo("solana");

    const usdValue =
      solInfo.priceUsd !== null ? sol * solInfo.priceUsd : null;

    const percentChange = solInfo.percentChange ?? 0;
    const trend =
      percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

    // Simpan ke MongoDB (upsert biar update kalau sudah ada)
    await WalletBalance.findOneAndUpdate(
      { address },
      {
        address,
        lamports,
        sol,
        solPriceUsd: solInfo.priceUsd,
        usdValue,
        percentChange,
        trend,
        lastUpdated: new Date(),
      },
      { upsert: true, new: true }
    );

    res.json({
      address,
      lamports,
      sol,
      solPriceUsd: solInfo.priceUsd,
      usdValue,
      percentChange,
      trend,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("❌ Error fetching balance:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/tokens/:address
//
router.get("/tokens/:address", async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    if (!address)
      return res.status(400).json({ error: "Missing wallet address" });

    const connection = new Connection(
      process.env.SOLANA_CLUSTER as string,
      "confirmed"
    );
    const pubkey = new PublicKey(address);

    // ambil SPL token accounts dari wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubkey,
      {
        programId: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ),
      }
    );

    const tokens = tokenAccounts.value.map((acc) => {
      const info: any = acc.account.data.parsed.info;
      return {
        mint: info.mint,
        owner: info.owner,
        amount: parseFloat(info.tokenAmount.uiAmountString),
        decimals: info.tokenAmount.decimals,
      };
    });

    // ambil native SOL balance
    const lamports = await connection.getBalance(pubkey);
    const solBalance = lamports / LAMPORTS_PER_SOL;

    // ambil metadata token list resmi
    const tokenListProvider = new TokenListProvider();
    const tokenList = await tokenListProvider.resolve();
    const list = tokenList.filterByChainId(ChainId.MainnetBeta).getList();

    // enrich SPL tokens
    const enriched = tokens.map((t) => {
      const meta = list.find((tk) => tk.address === t.mint);
      return {
        ...t,
        name: meta?.name || null,
        symbol: meta?.symbol || "Unknown",
        logoURI: meta?.logoURI || null,
      };
    });

    // 🔥 Registry fallback (phantom-like) → selalu include
    const registryTokens = Object.keys(REGISTRY).map((mint) => {
      const meta = REGISTRY[mint];
      const exist = enriched.find((e) => e.mint === mint);

      return {
        mint,
        owner: address,
        amount:
          mint === SOL_MINT
            ? solBalance // pakai native balance untuk SOL
            : exist?.amount || 0, // fallback 0 kalau ATA belum ada
        decimals: meta.decimals,
        name: meta.name,
        symbol: meta.symbol,
        logoURI: meta.logoURI,
      };
    });

    // gabungkan → registry defaults + semua token lain
    const allTokens = [
      ...registryTokens,
      ...enriched.filter((e) => !REGISTRY[e.mint]), // hanya token lain di wallet
    ];

    // ambil harga dari CoinGecko
    const [solInfo, usdcInfo, uogInfo] = await Promise.all([
      getPriceInfo("solana"),
      getPriceInfo("usd-coin"),
      getPriceInfo("universe-of-gamers"),
    ]);

    const final = allTokens.map((t) => {
      let priceUsd = 0;
      let percentChange = 0;

      if (t.mint === SOL_MINT) {
        priceUsd = solInfo.priceUsd ?? 0;
        percentChange = solInfo.percentChange ?? 0;
      } else if (t.mint === USDC_MINT) {
        priceUsd = usdcInfo.priceUsd ?? 1;
        percentChange = usdcInfo.percentChange ?? 0;
      } else if (t.mint === UOG_MINT) {
        priceUsd = uogInfo.priceUsd ?? 0;
        percentChange = uogInfo.percentChange ?? 0;
      }

      const trend = percentChange > 0 ? 1 : percentChange < 0 ? -1 : 0;

      const usdValue = priceUsd
        ? parseFloat((t.amount * priceUsd).toFixed(2))
        : 0;

      return {
        ...t,
        priceUsd: parseFloat(priceUsd.toFixed(2)),
        usdValue,
        percentChange: parseFloat(percentChange.toFixed(2)),
        trend,
      };
    });

    // Simpan ke DB (opsional)
    await Promise.all(
      final.map(async (t) => {
        await WalletToken.findOneAndUpdate(
          { address, mint: t.mint },
          { ...t, address, lastUpdated: new Date() },
          { upsert: true, new: true }
        );
      })
    );

    res.json({ address, tokens: final });
  } catch (err: any) {
    console.error("❌ Error fetching tokens:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// GET /wallet/nft/:address
//
router.get("/nfts/:address", async (req, res) => {
  try {
    const { address } = req.params;
    const nfts = await Nft.find({ "metadata.owner": address });

    // convert lamports → SOL sebelum kirim ke frontend
    const formatted = nfts.map(nft => ({
      ...nft.toObject(),
      price: nft.price ? nft.price / LAMPORTS_PER_SOL : 0
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

//
// GET /wallet/nft/:id
//
router.get("/nfts/id/:id", async (req, res) => {
  try {
    const nft = await Nft.findById(req.params.id);
    if (!nft) return res.status(404).json({ error: "NFT not found" });

    // konversi lamports → SOL
    const formatted = {
      ...nft.toObject(),
      price: nft.price ? nft.price / LAMPORTS_PER_SOL : 0,
    };

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFT" });
  }
});

//
// POST /wallet/send/build (pakai program sendToken)
//
router.post("/send/build", async (req: Request, res: Response) => {
  try {
    const { from, to, amount } = req.body;
    if (!from || !to || !amount) {
      return res.status(400).json({ error: "from, to, and amount are required" });
    }

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const fromPubkey = new PublicKey(from);
    const toPubkey = new PublicKey(to);

    // --- setup Anchor provider & program ---
    const provider = new anchor.AnchorProvider(
      connection,
      {} as any, // signer kosong, biar tx tetap unsigned
      { preflightCommitment: "confirmed" }
    );
    const idl = require("../../public/idl/uog_marketplace.json");
    const programId = new PublicKey(process.env.PROGRAM_ID as string);
    const program = new anchor.Program(idl, programId, provider);

    // --- derive PDA ---
    const [marketConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_config")],
      program.programId
    );
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("treasury")],
      program.programId
    );

    // --- build ix ---
    const lamports = Math.floor(amount * 1e9);
    const ix = await program.methods
      .sendToken(new anchor.BN(lamports))
      .accounts({
        sender: fromPubkey,
        recipient: toPubkey,
        treasuryPda,
        marketConfig: marketConfigPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    tx.feePayer = fromPubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // balikin unsigned tx ke frontend
    const serialized = tx.serialize({ requireAllSignatures: false });
    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error("❌ build sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/send/submit (tetap sama)
//
router.post("/send/submit", async (req: Request, res: Response) => {
  try {
    const { signedTx } = req.body;
    if (!signedTx) return res.status(400).json({ error: "signedTx required" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");
    const sig = await connection.sendRawTransaction(txBuffer, { skipPreflight: false });

    res.json({
      signature: sig,
      explorer: `https://solscan.io/tx/${sig}?cluster=mainnet`
    });
  } catch (err: any) {
    console.error("❌ submit sendToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/quote
//
router.post("/swap/quote", async (req: Request, res: Response) => {
  try {
    const { from, fromMint, toMint, amount } = req.body;
    if (!from || !fromMint || !toMint || !amount) {
      return res.status(400).json({ error: "from, fromMint, toMint, amount required" });
    }

    console.log("🔍 [DFLOW QUOTE] payload", { from, fromMint, toMint, amount });

    const { data: quote } = await axios.get("https://quote-api.dflow.net/intent", {
      params: {
        userPublicKey: from,
        inputMint: fromMint,
        outputMint: toMint,
        amount,
        slippageBps: 50,
        wrapAndUnwrapSol: true,
      },
    });

    if (!quote?.openTransaction) throw new Error("❌ Missing openTransaction");

    res.json({
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      minOutAmount: quote.minOutAmount,
      openTransaction: quote.openTransaction,
    });
  } catch (err: any) {
    console.error("❌ dflow/quote error:", err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/build
//
router.post("/swap/build", async (req: Request, res: Response) => {
  try {
    const { from, openTransaction } = req.body;
    if (!from || !openTransaction) {
      return res.status(400).json({ error: "from, openTransaction required" });
    }

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const fromPubkey = new PublicKey(from);
    const provider = new anchor.AnchorProvider(connection, {} as any, { preflightCommitment: "confirmed" });

    // load UOG marketplace IDL
    const idlUog = require("../../public/idl/uog_marketplace.json");
    const programUog = new anchor.Program(
      idlUog,
      new PublicKey(process.env.PROGRAM_ID as string),
      provider
    );

    // parse DFLOW transaction
    const tx = Transaction.from(Buffer.from(openTransaction, "base64"));
    const ixIndex = tx.instructions.findIndex(ix => ix.programId.toBase58() === "DF1ow4tspfHX9JwWJsAb9epbkA8hmpSEAtxXy1V27QBH");
    if (ixIndex < 0) throw new Error("❌ DFLOW instruction not found");

    const aggIx = tx.instructions[ixIndex];
    const metas = aggIx.keys.map(k => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    }));
    const ixData = aggIx.data;

    // build instruction for UOG program
    const ix = await programUog.methods
      .swapToken(ixData, new anchor.BN(0)) // amount opsional, bisa pakai inAmount dari quote
      .accounts({
        user: fromPubkey,
        dexProgram: aggIx.programId,
        marketConfig: (await PublicKey.findProgramAddressSync([Buffer.from("market_config")], programUog.programId))[0],
        treasuryPda: (await PublicKey.findProgramAddressSync([Buffer.from("treasury")], programUog.programId))[0],
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(metas)
      .instruction();

    const { ComputeBudgetProgram } = require("@solana/web3.js");
    const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 });

    const txOut = new Transaction().add(modifyComputeUnits, addPriorityFee, ix);
    txOut.feePayer = fromPubkey;
    txOut.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const serialized = txOut.serialize({ requireAllSignatures: false });
    res.json({ tx: serialized.toString("base64") });
  } catch (err: any) {
    console.error("❌ swap build error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

//
// POST /wallet/swap/submit
//
router.post("/swap/submit", async (req: Request, res: Response) => {
  try {
    const { signedTx } = req.body;
    if (!signedTx) return res.status(400).json({ error: "signedTx required" });

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const txBuffer = Buffer.from(signedTx, "base64");
    const sig = await connection.sendRawTransaction(txBuffer, { skipPreflight: false });

    await connection.confirmTransaction(sig, "confirmed");

    res.json({
      signature: sig,
      explorer: `https://solscan.io/tx/${sig}?cluster=mainnet`,
    });
  } catch (err: any) {
    console.error("❌ swap submit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


export default router;
