import { Router, Request, Response } from "express";
import multer from "multer";
import { Nft } from "../models/Nft";
import { Character } from "../models/Character";
import { Skill } from "../models/Skill";
import { Rune } from "../models/Rune";
import { Team } from "../models/Team";
import { generateNftMetadata } from "../services/metadataGenerator";
import { authenticateJWT, requireAdmin, AuthRequest } from "../middleware/auth";
import Auth from "../models/Auth";
import battleRoutes, {
  calculateEconomicFragment,
  getRankModifier,
  saveDailyEarning,
  verifyNftIntegrity,
  calculateNftPower
} from "./battle";

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
  TransactionInstruction,
  ParsedAccountData,
  VersionedTransactionResponse,
  ParsedInstruction,
  ParsedTransactionWithMeta
} from "@solana/web3.js";
import { ComputeBudgetProgram, sendAndConfirmRawTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ACCOUNT_SIZE,
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createSyncNativeInstruction, 
  NATIVE_MINT,
  createCloseAccountInstruction,
  getAccount,
  createApproveInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TokenListProvider, ENV as ChainId } from "@solana/spl-token-registry";
import * as anchor from "@project-serum/anchor";
import { BN } from "bn.js";
import axios from "axios";
import { getTokenInfo } from "../services/priceService";
import { getMint } from "@solana/spl-token";

import fs from "fs";
import path from "path";

import Redis from "ioredis";
import pLimit from "p-limit";
import { broadcast } from "../index";

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata, fetchDigitalAsset } from "@metaplex-foundation/mpl-token-metadata";

async function loadMetadataFromPDA(connection: Connection, mint: string) {
  try {
    // kita tidak ambil metadata on-chain.
    // cukup kembalikan mint saja (metadata akan diambil dari Mongo)
    return {
      mint,
      name: null,
      symbol: null,
      uri: null,
      sellerFeeBasisPoints: null,
    };
  } catch {
    return null;
  }
}

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const router = Router();
const upload = multer(); // memory storage

// Program ID Metaplex Token Metadata (mainnet)
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// === Helper untuk SPL events ===
function handleSpl(parsed: any, sig: any, tx: any, history: any[]) {
  switch (parsed.type) {
    case "mintTo":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Mint",
        from: null,
        to: parsed.info?.account || null,
        amount: parsed.info?.amount || "1",
      });
      break;

    case "transfer":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Transfer",
        from: parsed.info?.source || null,
        to: parsed.info?.destination || null,
        amount: parsed.info?.amount || "1",
      });
      break;

    case "burn":
      history.push({
        signature: sig.signature,
        slot: sig.slot,
        blockTime: tx.blockTime
          ? new Date(tx.blockTime * 1000).toISOString()
          : null,
        event: "Burn",
        from: parsed.info?.account || null,
        to: null,
        amount: parsed.info?.amount || "1",
      });
      break;
  }
}

// 🔑 Redis client
const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

// ⏱️ Batas concurrency (misalnya max 5 request paralel ke RPC)
const limit = pLimit(5);

// TTL cache (dalam detik)
const CACHE_TTL = 60 * 1000; // 1 menit

// TTL (detik)
const TTL_METADATA = 86400; // 24 jam
const TTL_LISTING = 60;     // 1 menit
const NFT_CACHE_KEY = "fetch-nft:list";
const NFT_CACHE_TTL = 5; // 60 detik
const MYNFT_CACHE_TTL = 5; // 60 detik

// 🔹 Helper fetch dengan timeout
async function fetchWithTimeout(url: string, ms = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectMintAccurate(tx: any, connection: Connection) {
  const keys = tx.transaction.message.accountKeys.map((a: any) =>
    a.pubkey?.toBase58?.() ?? a.toBase58?.()
  );

  let mintAddress: string | null = null;
  let metadataAddress: string | null = null;

  // === Cari akun milik Token Program (pakai limiter)
  await Promise.all(
    keys.map((key: any) =>
      limit(async () => {
        if (mintAddress) return; // sudah ketemu, skip sisanya
        try {
          const info = await connection.getParsedAccountInfo(new PublicKey(key));
          const parsed: any = info?.value?.data;

          if (!parsed) return;
          if (parsed.program !== "spl-token") return;
          if (parsed.parsed?.type === "mint") {
            const supply = parsed.parsed.info.supply;
            const decimals = parsed.parsed.info.decimals;
            if (decimals === 0 && Number(supply) <= 1) {
              mintAddress = key;
            }
          }
        } catch {
          // skip invalid account
        }
      })
    )
  );

  // === Metadata program check (pakai limiter juga)
  const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

  await Promise.all(
    keys.map((key: any) =>
      limit(async () => {
        if (metadataAddress) return;
        try {
          const info = await connection.getAccountInfo(new PublicKey(key));
          if (info?.owner?.equals(METADATA_PROGRAM_ID)) {
            metadataAddress = key;
          }
        } catch {}
      })
    )
  );

  return {
    mint: mintAddress,
    metadata: metadataAddress,
    detectedVia: "parsed-check",
  };
}

async function withTimeout<T>(promise: Promise<T>, ms = 8000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("⏰ RPC timeout after " + ms + "ms")), ms)
    ),
  ]);
}

// Di atas file (global scope)
const myHistoryCache = new Map<
  string,
  { data: any; expires: number }
>();

// Helper untuk cek cache
function getCache(userId: string) {
  const cached = myHistoryCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  } else if (cached) {
    myHistoryCache.delete(userId); // expired
  }
  return null;
}

function setCache(userId: string, data: any, ttlMs = 5 * 60 * 1000) {
  myHistoryCache.set(userId, {
    data,
    expires: Date.now() + ttlMs,
  });
}

const mintCache = new Map<string, boolean>();

// =========================
// 🧠 Fungsi Ekstraksi Mint
// =========================
export async function extractMintFromTx(
  tx: any,
  programId: PublicKey,
  walletAddresses: string[],
  connection: Connection
): Promise<string | null> {
  try {
    const messageKeys = tx.transaction.message.accountKeys.map((a: any) =>
      a.pubkey?.toBase58?.() ?? a.toBase58?.()
    );

    const innerKeys =
      tx.meta?.innerInstructions
        ?.flatMap((ix: any) =>
          ix.instructions?.map(
            (i: any) => i.parsed?.info?.mint || i.parsed?.info?.account
          )
        )
        .filter(Boolean) || [];

    const allKeys = Array.from(new Set([...messageKeys, ...innerKeys]));

    const blacklist = new Set([
      "11111111111111111111111111111111",
      "SysvarRent111111111111111111111111111111111",
      "SysvarC1ock11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "B6VWNAqRu2tZcYeBJ1i1raw4eaVP4GrkL2YcZLshbonk",
      programId.toBase58(),
      ...walletAddresses,
    ]);

    const candidates = allKeys.filter(
      (a: any) =>
        a &&
        !blacklist.has(a) &&
        /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
    );

    for (const acc of candidates) {
      try {
        const pubkey = new PublicKey(acc);

        if (mintCache.has(acc)) {
          if (mintCache.get(acc)) return acc;
          continue;
        }

        const info = await connection.getAccountInfo(pubkey);
        if (!info) continue;

        // ⚙️ Validasi owner = SPL Token Program
        if (!info.owner.equals(TOKEN_PROGRAM_ID)) continue;

        const len = info.data?.length ?? 0;

        // ✅ Mint account (82 bytes)
        if (len === 82) {
          mintCache.set(acc, true);
          console.log(`✅ Detected valid Mint: ${acc}`);
          return acc;
        }

        // ⚠️ Token Account (ATA) (165 bytes) → resolve mint dari data
        if (len === 165) {
          const mintPubkey = new PublicKey(info.data.slice(0, 32));
          console.log(`🔁 ATA detected: ${acc} → Resolving mint ${mintPubkey.toBase58()}`);

          const mintInfo = await connection.getAccountInfo(mintPubkey);
          if (
            mintInfo &&
            mintInfo.owner.equals(TOKEN_PROGRAM_ID) &&
            mintInfo.data.length === 82
          ) {
            console.log(`✅ Resolved Mint from ATA: ${mintPubkey.toBase58()}`);
            mintCache.set(mintPubkey.toBase58(), true);
            return mintPubkey.toBase58();
          }
        }
      } catch (err) {
        console.warn(`⚠️ extractMintFromTx inner error: ${err}`);
        continue;
      }
    }

    // 🪄 Fallback terakhir: InitializeMint di log
    const logs = tx.meta?.logMessages?.join(" ") || "";
    const mintFromLogs = logs.match(
      /InitializeMint.*?([1-9A-HJ-NP-Za-km-z]{30,44})/
    );
    if (mintFromLogs?.[1]) {
      const possibleMint = mintFromLogs[1];
      try {
        const info = await connection.getAccountInfo(new PublicKey(possibleMint));
        if (
          info &&
          info.owner.equals(TOKEN_PROGRAM_ID) &&
          info.data.length === 82
        ) {
          console.log(`✅ Detected Mint from logs: ${possibleMint}`);
          mintCache.set(possibleMint, true);
          return possibleMint;
        }
      } catch {}
    }

    return null;
  } catch (err) {
    console.warn("⚠️ extractMintFromTx error:", err);
    return null;
  }
}

// =========================
// ⚙️ Fungsi Enrichment Mint
// =========================
async function enrichMintAddresses(
  results: any[],
  connection: Connection,
  programId: PublicKey,
  walletAddresses: string[]
) {
  console.log(`🧩 Enriching ${results.length} transactions with real mint addresses...`);
  const limit = pLimit(4);
  let enriched = 0;

  for (const item of results) {
    await limit(async () => {
      try {
        if (
          item.mintAddress &&
          ![
            "11111111111111111111111111111111",
            "So11111111111111111111111111111111111111111",
            "So11111111111111111111111111111111111111112",
          ].includes(item.mintAddress)
        )
          return;

        const tx = (await connection.getTransaction(item.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        })) as VersionedTransactionResponse | null;

        if (!tx?.meta?.logMessages) return;

        console.log(`\n🔍 Processing TX: ${item.signature}`);
        console.log(`📦 EventType: ${item.eventType}`);

        const keys = tx.transaction.message
          .getAccountKeys()
          .staticAccountKeys.map((k: PublicKey) => k.toBase58());
        console.log(`📜 Account Keys: ${keys.join(", ")}`);

        let detectedMint: string | null = null;

        // === Case 1: MintAndList (100% accurate mint detection) ===
        if (item.eventType === "MintAndList") {
          console.log("🪙 MintAndList → scanning parsed accounts for REAL mint");

          for (const key of keys) {
            try {
              const pk = new PublicKey(key);
              const acc = await connection.getParsedAccountInfo(pk);

              if (!acc.value) continue;

              // hanya SPL token program
              if (acc.value.owner.toBase58() !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
                continue;

              const info = (acc.value.data as any)?.parsed?.info;
              if (!info) continue;

              // REAL mint account: decimals === 0 AND no "owner" (owner only appears on token accounts)
              if (info.decimals === 0 && !info.owner) {
                detectedMint = key;
                console.log("🎯 REAL MINT FOUND:", detectedMint);
                break;
              }

            } catch (_) {}
          }
        }

        // === Case 2: BuyNft (improved, non-guessing search) ===
        if (item.eventType === "BuyNft") {
          console.log(`🛒 Inspecting BuyNft transaction ${item.signature} (strict search)`);

          // Prefer parsed transaction (gives parsed instructions + tokenBalances)
          const parsedTx = (await connection.getParsedTransaction(item.signature, "confirmed")) as ParsedTransactionWithMeta | null;

          if (!parsedTx?.meta) {
            console.log("⚠️ No parsed meta available for tx — cannot search reliably");
          } else {
            const meta = parsedTx.meta;
            let foundMint: string | null = null;

            // 1)  Look into innerInstructions (parsed) for transfer/transferChecked to buyer ATA
            try {
              const inner = meta.innerInstructions || [];
              for (const innerGroup of inner) {
                const ixList = (innerGroup.instructions as any[]) || [];
                for (const ix of ixList) {
                  // parsed instruction shape: { program: 'spl-token', parsed: { type: 'transfer'|..., info: { source, destination, mint, authority, amount, ... } } }
                  const parsed = ix.parsed;
                  if (parsed && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
                    const info = parsed.info || {};
                    const destination = info.destination;
                    const mintCandidate = info.mint || info.token; // some indexers vary
                    // destination could be an ATA or token account address. If it's an ATA owned by known wallet we can inspect it.
                    if (destination && mintCandidate) {
                      // if destination owner is one of known walletAddresses, we need to be sure destination is the token account (ATA)
                      try {
                        const parsedAcc = await connection.getParsedAccountInfo(new PublicKey(destination));
                        const parsedData = (parsedAcc.value?.data as any)?.parsed?.info;
                        const owner = parsedData?.owner;
                        const mintFromAcc = parsedData?.mint || mintCandidate;
                        if (owner && walletAddresses.includes(owner)) {
                          // verify decimals
                          const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintFromAcc));
                          const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
                          console.log(`💡 innerInstr -> found transfer to owner ${owner}, mint ${mintFromAcc}, decimals=${decimals}`);
                          if (decimals === 0) {
                            foundMint = mintFromAcc;
                            console.log(`✅ NFT mint found from innerInstructions: ${foundMint}`);
                            break;
                          } else {
                            console.log(`🚫 mint ${mintFromAcc} decimals=${decimals}, not NFT`);
                          }
                        }
                      } catch (e: any) {
                        // can't parse account info: log & continue
                        console.warn(`⚠️ Failed to parse destination account ${destination}: ${e?.message || e}`);
                      }
                    }
                  }
                }
                if (foundMint) break;
              }
            } catch (e: any) {
              console.warn("⚠️ Error while scanning innerInstructions:", e?.message || e);
            }

            // 2) If not found, use meta.postTokenBalances / preTokenBalances as a reliable source of minted/transferred token mints
            //    postTokenBalances contains array: { accountIndex, mint, uiTokenAmount: { decimals, uiAmountString }, owner }
            if (!foundMint) {
              try {
                const balances = (meta.postTokenBalances || []).concat(meta.preTokenBalances || []);
                // prefer postTokenBalances changes where owner is in walletAddresses
                for (const b of balances) {
                  const mint = b?.mint;
                  const owner = b?.owner; // some providers include owner
                  const decimals = b?.uiTokenAmount?.decimals;
                  if (!mint) continue;
                  // If owner is a known wallet OR the accountIndex maps to an account owned by walletAddresses
                  let ownerIsKnown = false;
                  if (owner && walletAddresses.includes(owner)) ownerIsKnown = true;

                  // Try to map accountIndex -> owner via transaction message accountKeys if needed
                  if (!ownerIsKnown && typeof b.accountIndex === "number" && parsedTx.transaction?.message?.accountKeys) {
                    const keyObj = parsedTx.transaction.message.accountKeys[b.accountIndex];
                    // keyObj might be { pubkey: '...' } or a PublicKey object/string depending on environment
                    const ownerCandidate = typeof keyObj === "string" ? keyObj : keyObj?.pubkey || keyObj?.toString?.();
                    // we can't know owner from accountKey alone; skip unless owner field exists
                  }

                  if (decimals === 0) {
                    // confirm on-chain decimals as double-check
                    try {
                      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
                      const confirmedDecimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? decimals;
                      console.log(`💡 balance-scan -> mint ${mint}, decimals(from meta)=${decimals}, confirmedDecimals=${confirmedDecimals}, owner=${owner}`);
                      if (confirmedDecimals === 0) {
                        // optionally check owner matches buyer wallet
                        if (ownerIsKnown || !owner) {
                          foundMint = mint;
                          console.log(`✅ NFT mint found from tokenBalances: ${foundMint}`);
                          break;
                        } else {
                          // Owner not known: still record but mark as uncertain
                          console.log(`ℹ️ mint ${mint} decimals=0 found but owner ${owner} not in known wallets`);
                          // you can choose to accept or skip — here we accept if owner matches walletAddresses
                        }
                      }
                    } catch (e: any) {
                      console.warn(`⚠️ Failed to confirm decimals for mint ${mint}: ${e?.message || e}`);
                    }
                  }
                }
              } catch (e: any) {
                console.warn("⚠️ Error while scanning token balances:", e?.message || e);
              }
            }

            // 3) If still not found, check top-level parsed instructions (transfer from escrow -> buyer token account)
            if (!foundMint) {
              try {
                const ixList = parsedTx.transaction.message.instructions || [];
                for (const ix of ixList) {
                  const parsed = (ix as any).parsed;
                  if (parsed && (parsed.type === "transfer" || parsed.type === "transferChecked")) {
                    const info = parsed.info || {};
                    const dest = info.destination;
                    const mintCandidate = info.mint || info.token;
                    if (dest && mintCandidate) {
                      try {
                        const parsedAcc = await connection.getParsedAccountInfo(new PublicKey(dest));
                        const parsedData = (parsedAcc.value?.data as any)?.parsed?.info;
                        const owner = parsedData?.owner;
                        if (owner && walletAddresses.includes(owner)) {
                          const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mintCandidate));
                          const decimals = (mintInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
                          console.log(`💡 top-level -> transfer to owner ${owner}, mint ${mintCandidate}, decimals=${decimals}`);
                          if (decimals === 0) {
                            foundMint = mintCandidate;
                            console.log(`✅ NFT mint found from top-level instructions: ${foundMint}`);
                            break;
                          }
                        }
                      } catch (e: any) {
                        console.warn(`⚠️ Failed to parse dest account ${dest}: ${e?.message || e}`);
                      }
                    }
                  }
                }
              } catch (e: any) {
                console.warn("⚠️ Error while scanning top-level instructions:", e?.message || e);
              }
            }

            // Finalize: set item.mintAddress only if foundMint is confirmed NFT
            if (foundMint) {
              item.mintAddress = foundMint;
              enriched++;
              console.log(`✅ Detected mint (BuyNft strict): ${foundMint}`);
            } else {
              console.log(`❌ No mint detected for BuyNft tx ${item.signature} (strict search)`);
            }
          } // end if parsedTx.meta
        } // end BuyNft block


        if (detectedMint) {
          item.mintAddress = detectedMint;
          enriched++;
          console.log(`✅ Detected mint: ${detectedMint}`);
          if (enriched % 5 === 0)
            console.log(`🔹 Enriched ${enriched}/${results.length}`);
        } else {
          console.log(`❌ No mint detected for TX ${item.signature}`);
        }
      } catch (err: any) {
        console.warn(`⚠️ Failed to enrich ${item.signature}: ${err.message}`);
      }
    });
  }

  console.log(`\n✅ Finished enrichment: ${enriched}/${results.length} updated`);
}

// ================================
// 🧠 Fungsi pencarian model NFT
// ================================
async function attachNftModel(results: any[]) {
  console.log(`🔍 Attaching NFT model data for ${results.length} entries...`);
  let found = 0;

  // Ambil semua mintAddress unik biar bisa batch query (lebih cepat)
  const mintList = results
    .map((r) => r.mintAddress)
    .filter(
      (mint): mint is string =>
        !!mint && mint !== "11111111111111111111111111111111"
    );

  if (mintList.length === 0) return;

  // Ambil semua NFT dari DB dalam 1 query
  const nftDocs = await Nft.find({ mintAddress: { $in: mintList } })
    .select("_id name image mintAddress owner character rune level isSell price")
    .lean();

  // Buat map biar pencarian cepat
  const nftMap = new Map(nftDocs.map((n) => [n.mintAddress, n]));

  // Pasangkan hasil ke tiap item
  for (const item of results) {
    const nftDoc = nftMap.get(item.mintAddress);
    if (!nftDoc) continue;

    item.model = {
      id: nftDoc._id,
      name: nftDoc.name,
      image: nftDoc.image,
      owner: nftDoc.owner,
      level: nftDoc.level,
      price: nftDoc.price || 0,
      isSell: nftDoc.isSell,
      type: nftDoc.character
        ? "Character"
        : nftDoc.rune
        ? "Rune"
        : "Unknown",
    };

    found++;
  }

  console.log(`✅ Model attached for ${found}/${results.length} entries`);
}

async function getUsdPrice(mint: string): Promise<number> {
  const url = `https://data.solanatracker.io/tokens/${mint}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-api-key": process.env.SOLANATRACKER_API_KEY || "",
  };

  const res = await fetch(url, { headers });
  if (!res.ok) return 0;

  const data = await res.json();
  const pools = Array.isArray(data.pools) ? data.pools : [];
  const best = pools.sort(
    (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
  )[0];

  return best?.price?.usd ?? 0;
}

// Route harga token by mint
router.get("/price/:mint", async (req: Request, res: Response) => {
  try {
    const mint = req.params.mint;
    const price = await getUsdPrice(mint);
    res.json({ mint, priceUsd: price });
  } catch (err) {
    console.error("❌ Failed to fetch token price", err);
    res.status(500).json({ error: "Failed to fetch token price" });
  }
});

// Route rates SOL ↔ USDC dari SolanaTracker
router.get("/rates", async (_req: Request, res: Response) => {
  try {
    // Mint address SOL & USDC di Solana
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    const solToUsd = await getUsdPrice(SOL_MINT);
    const usdcToUsd = await getUsdPrice(USDC_MINT);

    const solToUsdcRate = solToUsd / usdcToUsd;
    const usdcToSolRate = 1 / solToUsdcRate;

    res.json({
      solToUsd,
      usdcToUsd,
      solToUsdcRate,
      usdcToSolRate,
    });
  } catch (err) {
    console.error("❌ Failed to fetch SolanaTracker rates", err);
    res.status(500).json({ error: "Failed to fetch SolanaTracker rates" });
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const { name, description, image, price, royalty, character, owner, txSignature } = req.body;

    if (!owner || !txSignature) throw new Error("Owner & txSignature required");

    const char = await Character.findById(character);
    if (!char) throw new Error("Character not found");

    // assign base stats
    const nft = await Nft.create({
      name,
      description,
      image,
      price,
      royalty,
      character,
      owner,
      txSignature,
      hp: char.baseHp,
      atk: char.baseAtk,
      def: char.baseDef,
      spd: char.baseSpd,
      critRate: char.baseCritRate,
      critDmg: char.baseCritDmg,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.json({ success: true, nft });
  } catch (err: any) {
    console.error("❌ save NFT error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all NFTs langsung dari DB tanpa validasi on-chain
router.get("/fetch-nft", async (req: Request, res: Response) => {
  try {
    console.time("⏱ fetch-nft-total");

    // === 1️⃣ Cek cache Redis lebih dulu ===
    const cached = await redis.get(NFT_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(`⚡ [Redis] Returning cached NFT list (${parsed.length} items)`);
      console.timeEnd("⏱ fetch-nft-total");
      return res.json(parsed); // 👈 langsung kirim array, bukan object wrapper
    }

    // === 2️⃣ Query ke MongoDB ===
    console.time("⏱ DB-find");
    const nfts = await Nft.find({
      isSell: true,
      txSignature: { $exists: true, $ne: "" },
    })
      .populate("character", "name rarity element")
      .populate("rune", "name rarity");
    console.timeEnd("⏱ DB-find");

    console.log(`📦 Total NFT for sale (with txSignature): ${nfts.length}`);

    // === 3️⃣ Simpan hasil ke Redis ===
    await redis.set(
      NFT_CACHE_KEY,
      JSON.stringify(nfts),
      "EX",
      NFT_CACHE_TTL
    );
    console.log(`💾 [Redis] Cached ${nfts.length} NFTs for ${NFT_CACHE_TTL}s`);

    // === 4️⃣ Broadcast ke client (tetap sama) ===
    broadcast({
      type: "collection-update",
      data: { nfts },
      timestamp: new Date().toISOString(),
    });

    // === 5️⃣ Kirim hasil langsung (array mentah) ===
    res.json(nfts);

    console.timeEnd("⏱ fetch-nft-total");
  } catch (err) {
    console.error("❌ Fetch NFT error (DB only):", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// GET NFTs by owner (only owner can access)
router.get("/my-nfts", authenticateJWT, async (req: AuthRequest, res) => {
  const userId = req.user.id;
  const cacheKey = `my-nfts:${userId}`;

  // 🟣 Wallet special yang boleh melihat pending NFT
  const SPECIAL_OWNERS = [
    "2N1jWWZrhpQL1c2MkBJ5WsnE9UnsPEuud8fEspTRouHz",
    "EMc9sS4NV9e7fHdP8RyQzvZiBgskcfXkt6HkLB3v8QqC",
    "77wvMmB1vyDFsr77S4KWJkZDzoUN3c4XDxfL3f5NbDys",
    "FfV1kmfGmf3dLxpEmZzMs14QNtcnyms2Rbvs9hPXjfW5"
  ];

  try {
    console.time("⏱ my-nfts-total");
    console.log(`\n🚀 Fetching /my-nfts for user: ${userId}`);

    const forceRefresh = req.query.force === "true";

    // 1️⃣ Redis cache
    if (!forceRefresh) {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log(`⚡ [Redis] Returning cached NFTs for user ${userId}`);
        console.timeEnd("⏱ my-nfts-total");
        return res.json(JSON.parse(cached));
      }
    } else {
      console.log("♻️ Force refresh cache for /my-nfts");
    }

    // 2️⃣ Ambil wallet user
    const user = await Auth.findById(userId).select("wallets custodialWallets");
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    if (walletAddresses.length === 0) return res.json([]);

    // 🟣 Tentukan apakah user adalah special owner
    const isSpecialOwner = walletAddresses.some((addr) =>
      SPECIAL_OWNERS.includes(addr)
    );

    // 3️⃣ Query NFT dari database
    console.time("⏱ DB-find");

    // 🔥 Query berbeda untuk special owner vs user biasa
    let query: any = {
      owner: { $in: walletAddresses }
    };

    if (!isSpecialOwner) {
      // User biasa → hanya nft minted
      query.status = "minted";
    }

    const nfts = await Nft.find(query)
      .populate("character", "name rarity element")
      .populate("rune", "name rarity")
      .sort({ updatedAt: -1 })
      .lean();

    console.timeEnd("⏱ DB-find");

    console.log(
      `📦 Found ${nfts.length} NFTs owned by user ${userId} (special=${isSpecialOwner})`
    );

    // 4️⃣ Save Redis cache
    await redis.set(cacheKey, JSON.stringify(nfts), "EX", MYNFT_CACHE_TTL);
    console.log(`💾 [Redis] Cached ${nfts.length} NFTs for user ${userId}`);

    // 5️⃣ Return tanpa modifikasi struktur
    res.json(nfts);

    console.timeEnd("⏱ my-nfts-total");
  } catch (err) {
    console.error("❌ Error fetching my NFTs:", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

/**
 * Equip Rune to a Character NFT
 */
router.post("/:characterId/equip-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { runeId } = req.body;

    if (!runeId) return res.status(400).json({ error: "runeId is required" });

    const character = await Nft.findById(characterId);
    if (!character) return res.status(404).json({ error: "Character not found" });

    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    const runeNft = await Nft.findById(runeId).populate("rune");
    if (!runeNft || !runeNft.rune) return res.status(404).json({ error: "Rune not found" });
    if (runeNft.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your rune" });
    }
    if (runeNft.isEquipped) {
      return res.status(400).json({ error: "Rune already equipped" });
    }

    const runeData: any = runeNft.rune;

    // Tambah ke array equipped
    character.equipped.push(runeNft._id);

    // Apply bonus stats
    character.hp += runeData.hpBonus ?? 0;
    character.atk += runeData.atkBonus ?? 0;
    character.def += runeData.defBonus ?? 0;
    character.spd += runeData.spdBonus ?? 0;

    runeNft.isEquipped = true;
    runeNft.equippedTo = character._id;

    await runeNft.save();
    await character.save();

    res.json({ message: "✅ Rune equipped successfully", character });
  } catch (err: any) {
    console.error("❌ Error equipping rune:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Unequip Rune to a Character NFT
 */
router.post("/:characterId/unequip-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { runeId } = req.body;

    if (!runeId) return res.status(400).json({ error: "runeId is required" });

    const character = await Nft.findById(characterId).populate("character");
    if (!character) return res.status(404).json({ error: "Character not found" });

    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    // cek rune ada di equipped array
    if (!character.equipped?.includes(runeId)) {
      return res.status(400).json({ error: "This rune is not equipped on this character" });
    }

    const runeNft = await Nft.findById(runeId).populate("rune");
    if (!runeNft || !runeNft.rune) return res.status(404).json({ error: "Rune not found" });

    const runeData: any = runeNft.rune;

    // Kurangi stats
    character.hp -= runeData.hpBonus ?? 0;
    character.atk -= runeData.atkBonus ?? 0;
    character.def -= runeData.defBonus ?? 0;
    character.spd -= runeData.spdBonus ?? 0;

    // Hapus rune dari equipped array
    character.equipped = character.equipped.filter(
      (id: any) => id.toString() !== runeId
    );

    runeNft.isEquipped = false;
    runeNft.equippedTo = null;

    await runeNft.save();
    await character.save();

    res.json({ message: "✅ Rune unequipped successfully", character });
  } catch (err: any) {
    console.error("❌ Error unequipping rune:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Edit (replace) a Rune on a Character NFT
 */
router.post("/:characterId/edit-rune", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const { characterId } = req.params;
    const { oldRuneId, newRuneId } = req.body;

    if (!oldRuneId || !newRuneId) {
      return res.status(400).json({ error: "oldRuneId and newRuneId are required" });
    }

    // Ambil character
    const character = await Nft.findById(characterId).populate("character");
    if (!character) return res.status(404).json({ error: "Character not found" });
    if (character.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your character" });
    }

    // Pastikan oldRune sedang dipakai
    if (!character.equipped?.includes(oldRuneId)) {
      return res.status(400).json({ error: "Old rune is not equipped on this character" });
    }

    // Ambil rune lama
    const oldRuneNft = await Nft.findById(oldRuneId).populate("rune");
    if (!oldRuneNft || !oldRuneNft.rune) return res.status(404).json({ error: "Old rune not found" });

    // Ambil rune baru
    const newRuneNft = await Nft.findById(newRuneId).populate("rune");
    if (!newRuneNft || !newRuneNft.rune) return res.status(404).json({ error: "New rune not found" });
    if (newRuneNft.owner !== req.user.walletAddress) {
      return res.status(403).json({ error: "Not your rune" });
    }
    if (newRuneNft.isEquipped) {
      return res.status(400).json({ error: "New rune is already equipped" });
    }

    const oldRuneData: any = oldRuneNft.rune;
    const newRuneData: any = newRuneNft.rune;

    // 1. Hapus bonus rune lama
    character.hp  -= oldRuneData.hpBonus ?? 0;
    character.atk -= oldRuneData.atkBonus ?? 0;
    character.def -= oldRuneData.defBonus ?? 0;
    character.spd -= oldRuneData.spdBonus ?? 0;

    // 2. Apply bonus rune baru
    character.hp  += newRuneData.hpBonus ?? 0;
    character.atk += newRuneData.atkBonus ?? 0;
    character.def += newRuneData.defBonus ?? 0;
    character.spd += newRuneData.spdBonus ?? 0;

    // 3. Update array equipped
    character.equipped = character.equipped.map((id: any) =>
      id.toString() === oldRuneId ? newRuneNft._id : id
    );

    // 4. Update status rune
    oldRuneNft.isEquipped = false;
    oldRuneNft.equippedTo = null;
    newRuneNft.isEquipped = true;
    newRuneNft.equippedTo = character._id;

    // 5. Save semua perubahan
    await oldRuneNft.save();
    await newRuneNft.save();
    await character.save();

    res.json({ message: "✅ Rune replaced successfully", character });
  } catch (err: any) {
    console.error("❌ Error editing rune:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all NFTs from DB
router.get("/fetch-nftDB", async (req, res) => {
  try {
    const nftdb = await Nft.find();
    res.json(nftdb);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch nft" });
  }
});

// GET NFT by ID
router.get("/nft/:id", async (req, res) => {
  try {
    const nft = await Nft.findById(req.params.id);
    if (!nft) return res.status(404).json({ error: "NFT not found" });
    res.json(nft);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch NFT" });
  }
});

// =====================
// Character Routes
// =====================

// POST Character
router.post("/character", async (req, res) => {
  try {
    const char = await Character.create(req.body);
    res.json({ success: true, data: char });
  } catch (err: any) {
    console.error("❌ Error creating character:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all Characters
router.get("/fetch-character", async (req, res) => {
  try {
    const chars = await Character.find();
    res.json(chars);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch characters" });
  }
});

// GET Character by ID
router.get("/character/:id", async (req, res) => {
  try {
    const char = await Character.findById(req.params.id).populate("runes");
    if (!char) return res.status(404).json({ error: "Character not found" });
    res.json(char);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch character" });
  }
});

// =====================
// Rune Routes
// =====================

// POST Rune
router.post("/rune", async (req, res) => {
  try {
    const rune = await Rune.create(req.body);
    res.json({ success: true, data: rune });
  } catch (err: any) {
    console.error("❌ Error creating rune:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET all Runes
router.get("/rune", async (req, res) => {
  try {
    const runes = await Rune.find();
    res.json(runes);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch runes" });
  }
});

// GET Rune by ID
router.get("/rune/:id", async (req, res) => {
  try {
    const rune = await Rune.findById(req.params.id);
    if (!rune) return res.status(404).json({ error: "Rune not found" });
    res.json(rune);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch rune" });
  }
});

// =====================
// Team Routes
// =====================

/**
 * INIT Teams for all users
 * POST /nft/team/init
 */
router.post("/team/init", async (req: Request, res: Response) => {
  try {
    const users = await Auth.find().select("_id wallets custodialWallets");

    let createdTeams: any[] = [];

    for (const user of users) {
      // ambil alamat wallet utama (kalau punya lebih dari satu, pakai yang pertama)
      const wallet =
        user.wallets?.[0]?.address || user.custodialWallets?.[0]?.address;

      if (!wallet) continue; // skip user tanpa wallet

      for (let i = 1; i <= 8; i++) {
        const teamName = `TEAM#${i}`;

        // cek apakah team ini sudah ada
        const exists = await Team.findOne({ owner: wallet, name: teamName });
        if (exists) continue;

        // buat team baru
        const team = await Team.create({
          name: teamName,
          owner: wallet,
          members: [], // default kosong
        });

        createdTeams.push(team);
      }
    }

    res.json({
      message: "✅ Init teams completed",
      createdCount: createdTeams.length,
      createdTeams,
    });
  } catch (err: any) {
    console.error("❌ Error initializing teams:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * CREATE Team
 * Body: { name: string, owner: string, members: [nftId1, nftId2, nftId3] }
 */
router.post("/team", async (req, res) => {
  try {
    const { name, owner, members } = req.body;

    if (!members || members.length !== 3) {
      return res.status(400).json({ error: "A team must have exactly 3 NFTs" });
    }

    // Validate all NFT IDs exist
    const nfts = await Nft.find({ _id: { $in: members }, owner });
    if (nfts.length !== 3) {
      return res.status(400).json({ error: "Some NFTs are invalid or not owned by this user" });
    }

    const team = new Team({ name, owner, members });
    await team.save();

    res.status(201).json(team);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create team", details: err.message });
  }
});

/**
 * READ My Teams (hanya tim milik user login)
 */
router.get("/team", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const user = await Auth.findById(req.user.id).select(
      "wallets custodialWallets"
    );

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    if (walletAddresses.length === 0) return res.json([]);

    const teams = await Team.find({ owner: { $in: walletAddresses } })
      .populate({
        path: "members",
        populate: [
          { path: "character", model: "Character" },
          { 
            path: "equipped",
            populate: { path: "rune", model: "Rune" }
          }
        ]
      })
      .lean(); // ← recommended, hasil lebih bersih

    // FIX UTAMA ⬇️
    const result = await Promise.all(
      teams.map(async (team: any) => {
        let teamPower = 0;

        for (const nft of team.members) {
          teamPower += await calculateNftPower(nft);
        }

        return {
          ...team,
          power: teamPower
        };
      })
    );

    return res.json(result);

  } catch (err: any) {
    console.error("❌ Failed to fetch teams:", err);
    res.status(500).json({ error: "Failed to fetch teams" });
  }
});

/**
 * Get Active Team
 */
router.get("/team/active", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const user = await Auth.findById(req.user.id).select("wallets custodialWallets");
    if (!user) return res.status(401).json({ error: "User not found" });

    const walletAddresses = [
      ...user.wallets.map((w) => w.address),
      ...user.custodialWallets.map((c) => c.address),
    ];

    const team = await Team.findOne({ owner: { $in: walletAddresses }, isActive: true })
      .populate("members");

    if (!team) return res.status(404).json({ error: "No active team" });

    res.json(team);
  } catch (err: any) {
    console.error("❌ Error fetching active team:", err);
    res.status(500).json({ error: "Failed to fetch active team" });
  }
});

/**
 * READ Team by ID
 */
router.get("/team/:id", async (req, res) => {
  try {
    const team = await Team.findById(req.params.id).populate("members");
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.json(team);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch team" });
  }
});

/**
 * UPDATE Team
 * Body: { name?: string, members?: string[] }
 */
router.put("/team/:id", async (req, res) => {
  try {
    const { name, members } = req.body;

    // ✅ Validasi: minimal 0, maksimal 3 anggota
    if (members && (members.length < 0 || members.length > 3)) {
      return res
        .status(400)
        .json({ error: "A team must have between 0 and 3 NFTs" });
    }

    // ✅ Siapkan data update
    const updateData: Record<string, any> = {};
    if (name) updateData.name = name;
    if (members) updateData.members = members;

    // ✅ Update dan populate anggota tim
    const team = await Team.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    }).populate("members");

    if (!team) {
      console.warn(`⚠️ [TEAM] Update failed — Team not found.`);
      return res.status(404).json({ error: "Team not found" });
    }

    // ✅ Log perubahan ke console
    console.log("========================================");
    console.log(`🛠️ [TEAM UPDATED]`);
    console.log(`🆔 Team ID   : ${team._id}`);
    console.log(`🏷️ Name      : ${team.name}`);
    console.log(`👥 Members   : ${team.members?.length || 0}`);
    console.log(`🕓 Timestamp : ${new Date().toISOString()}`);
    console.log("========================================");

    res.json({
      success: true,
      message: "✅ Team updated successfully",
      team,
    });
  } catch (err: any) {
    console.error("❌ Error updating team:", err.message);
    res.status(500).json({ error: "Failed to update team" });
  }
});

/**
 * Activate a Team (hanya 1 yang boleh aktif)
 */
router.post("/team/:id/activate", authenticateJWT, async (req: AuthRequest, res) => {
  try {
    const teamId = req.params.id;

    // 1️⃣ Ambil user login
    const user = await Auth.findById(req.user.id).select("wallets custodialWallets name email");
    if (!user) return res.status(401).json({ error: "User not found" });

    const walletAddresses = [
      ...(user.wallets?.map((w) => w.address) || []),
      ...(user.custodialWallets?.map((c) => c.address) || []),
    ];

    // 2️⃣ Nonaktifkan semua tim milik user
    await Team.updateMany(
      { owner: { $in: walletAddresses } },
      { $set: { isActive: false } }
    );

    // 3️⃣ Aktifkan tim yang dipilih
    const team = await Team.findOneAndUpdate(
      { _id: teamId, owner: { $in: walletAddresses } },
      { $set: { isActive: true } },
      { new: true }
    ).populate("members");

    if (!team) {
      console.warn(`⚠️ [TEAM] Activation failed — not found or not owned by user.`);
      return res.status(404).json({ error: "Team not found or not owned" });
    }

    // 4️⃣ Catat log ke console
    console.log("========================================");
    console.log(`✅ [TEAM ACTIVATED]`);
    console.log(`👤 User       : ${user.name || user._id}`);
    console.log(`📬 Wallets    : ${walletAddresses.join(", ")}`);
    console.log(`🆔 Team ID    : ${team._id}`);
    console.log(`🏷️ Team Name  : ${team.name}`);
    console.log(`👥 Members    : ${team.members?.length || 0}`);
    console.log(`🕓 Timestamp  : ${new Date().toISOString()}`);
    console.log("========================================");

    // 5️⃣ (opsional) Kirim response ke client
    res.json({
      success: true,
      message: "✅ Team activated successfully",
      team,
    });
  } catch (err: any) {
    console.error("❌ Error activating team:", err.message);
    res.status(500).json({ error: "Failed to activate team" });
  }
});

/**
 * DELETE Team
 */
router.delete("/team/:id", async (req, res) => {
  try {
    const team = await Team.findByIdAndDelete(req.params.id);
    if (!team) return res.status(404).json({ error: "Team not found" });
    res.json({ message: "Team deleted successfully" });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete team" });
  }
});

/**
 * Generate metadata JSON for a given NFT
 * POST /nft/:id/metadata
 * Body (optional): { outputDir: string }
 */
router.post("/:id/metadata", async (req, res) => {
  try {
    const nftId = req.params.id;
    const outputDir = process.env.METADATA_DIR || "uploads/metadata/nft";

    const result = await generateNftMetadata(nftId, outputDir);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    res.status(201).json({
      message: "Metadata generated successfully",
      file: result.path,
      metadata: result.metadata,
    });
  } catch (err: any) {
    console.error("❌ Error generating metadata:", err.message);
    res.status(500).json({ error: "Failed to generate metadata" });
  }
});

/**
 * GET all NFT metadata
 * GET /metadata
 */
router.get("/metadata", async (req, res) => {
  try {
    const outputDir: string = path.resolve(
      process.env.METADATA_DIR || "uploads/metadata/nft"
    );

    if (!fs.existsSync(outputDir)) {
      return res.status(404).json({ error: "Metadata directory not found" });
    }

    const files: string[] = fs
      .readdirSync(outputDir)
      .filter((f: string) => f.endsWith(".json"));

    if (files.length === 0) {
      return res.status(404).json({ error: "No metadata files found" });
    }

    const allMetadata = files.map((file: string) => {
      const filePath: string = path.join(outputDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return { id: path.basename(file, ".json"), ...content };
    });

    res.status(200).json(allMetadata);
  } catch (err: any) {
    console.error("❌ Error reading all metadata:", err.message);
    res.status(500).json({ error: "Failed to read metadata files" });
  }
});

/**
 * GET NFT metadata
 * GET /:mintAddress/metadata
 */
router.get("/:mintAddress/metadata", async (req: Request, res: Response) => {
  try {
    const { mintAddress } = req.params;

    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const mintPk = new PublicKey(mintAddress);
    
    const filePath = path.join(
      process.cwd(),
      "uploads/metadata/nft",
      `${mintAddress}.json`
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Metadata not found" });
    }

    // Baca & kirim sebagai JSON
    const raw = fs.readFileSync(filePath, "utf-8");
    const metadata = JSON.parse(raw);

    // ✅ Fetch PDA listing (marketplace program)
    const provider = new anchor.AnchorProvider(connection, {} as any, {
      preflightCommitment: "confirmed",
    });
    const program = new anchor.Program(
      require("../../public/idl/universe_of_gamers.json"),
      new anchor.web3.PublicKey(process.env.PROGRAM_ID!),
      provider
    );

    const [listingPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("listing"), mintPk.toBuffer()],
      program.programId
    );

    let priceSol: number | null = null;
    try {
      const listing: any = await program.account.listing.fetch(listingPda);
      priceSol = listing.price.toNumber() / anchor.web3.LAMPORTS_PER_SOL;
      console.log("💰 Price fetched from listing:", priceSol);
    } catch (e: any) {
      console.warn("⚠️ Listing not found on chain, price not available");
    }

    res.setHeader("Content-Type", "application/json");
    return res.json({
      ...metadata,
      price: priceSol, // tambahin field price
    });
  } catch (err: any) {
    console.error("❌ Metadata fetch error:", err.message);
    res.status(500).json({ error: "Failed to load metadata" });
  }
});

/**
 * GET NFT onchain
 * GET /:mintAddress/onchain
 */
// GET detail NFT by mintAddress (on-chain validation + history)
router.get("/:mintAddress/onchain", async (req: Request, res: Response) => {
  const { mintAddress } = req.params;
  console.time(`⏱ onchain-${mintAddress}`);

  try {
    // 🔹 Cari NFT dari DB
    const nft = await Nft.findOne({ mintAddress });
    if (!nft) {
      return res.status(404).json({ error: "NFT not found in DB" });
    }

    // Konversi ke object biasa
    const obj = nft.toObject();

    // === 🧠 Ambil minPrice dari chain ===
    let minPrice = 0; // default fallback
    // try {
    //   const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    //   const provider = new anchor.AnchorProvider(connection, {} as any, {});
    //   const program = new anchor.Program(
    //     require("../../public/idl/universe_of_gamers.json"),
    //     new PublicKey(process.env.PROGRAM_ID!),
    //     provider
    //   );

    //   // ⚙️ Ambil PDA konfigurasi market (contoh: "listing_config")
    //   const programId = new PublicKey(process.env.PROGRAM_ID!);
    //   // ⚙️ PDA untuk account Listing sesuai struct #[account] Listing
    //   const [listingPda] = PublicKey.findProgramAddressSync(
    //     [Buffer.from("listing"), new PublicKey(mintAddress).toBuffer()],
    //     programId
    //   );

    //   const listingAccount: any = await program.account.listing.fetch(listingPda);

    //   if (listingAccount && listingAccount.price) {
    //     minPrice = Number(listingAccount.price) / anchor.web3.LAMPORTS_PER_SOL;
    //   }

    //   console.log(`✅ Min price (on-chain): ${minPrice} SOL for ${mintAddress}`);
    // } catch (chainErr: any) {
    //   console.warn(`⚠️ Cannot fetch minPrice from chain: ${chainErr.message}`);
    // }

    // --- Hasil final ke frontend ---
    const result = {
      ...obj,
      price: obj.price ? Number(obj.price) : 0,
      minPrice, // ✅ kirim nilai dari chain
      onChain: true,
      metadata: null,
      history: [],
    };

    console.timeEnd(`⏱ onchain-${mintAddress}`);
    return res.json(result);
  } catch (err: any) {
    console.error("❌ DB fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch NFT from DB" });
  }
});

/**
 * GET NFT list history
 * GET /nft/history
 */
router.get("/history", async (req, res) => {
  console.time("⏱ onchain-total");
  try {
    const connection = new Connection(
      process.env.SOLANA_CLUSTER as string,
      "confirmed"
    );

    const nfts = await Nft.find({ isSell: true });
    console.log(`📦 Total NFT (DB only, isSell=true): ${nfts.length}`);

    const results: any[] = [];

    for (const nft of nfts) {
      const mintPk = new PublicKey(nft.mintAddress);

      try {
        // === Cari metadata PDA ===
        const [metadataPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
          METADATA_PROGRAM_ID
        );
        const accountInfo = await connection.getAccountInfo(metadataPda);

        let metadata: any = null;
        if (accountInfo) {
          let uri = accountInfo.data
            .slice(115, 315)
            .toString("utf-8")
            .replace(/\0/g, "")
            .trim();
          uri = uri.replace(/[^\x20-\x7E]+/g, "");

          if (uri && uri.startsWith("http")) {
            try {
              const resp = await fetchWithTimeout(uri, 5000);
              if (resp.ok) metadata = await resp.json();
            } catch (err) {
              console.warn(`⚠️ Failed fetch metadata ${nft.mintAddress}`, err);
            }
          }
        }

        // === Cek listing PDA hanya jika env true ===
        let priceSol: number | null = null;
        if (process.env.USE_ONCHAIN_LISTING === "true") {
          try {
            const provider = new anchor.AnchorProvider(connection, {} as any, {
              preflightCommitment: "confirmed",
            });
            const program = new anchor.Program(
              require("../../public/idl/universe_of_gamers.json"),
              new PublicKey(process.env.PROGRAM_ID!),
              provider
            );

            const [listingPda] = PublicKey.findProgramAddressSync(
              [Buffer.from("listing"), mintPk.toBuffer()],
              program.programId
            );

            const listing: any = await program.account.listing.fetch(listingPda);
            priceSol = listing.price.toNumber() / anchor.web3.LAMPORTS_PER_SOL;
          } catch {
            // kalau USE_ONCHAIN_LISTING true tapi PDA gak ada → skip
            console.log(`⚠️ No onchain listing for ${nft.mintAddress}`);
          }
        }

        results.push({
          _id: nft._id,
          name: nft.name,
          mintAddress: nft.mintAddress,
          image: nft.image,
          owner: nft.owner,
          price: priceSol ?? Number(nft.price) ?? 0,
          updatedAt: nft.updatedAt,
          metadata,
          onChain: true,
        });
      } catch (err) {
        console.warn(`⚠️ Failed fetch onchain for ${nft.mintAddress}`, err);
        results.push({
          _id: nft._id,
          name: nft.name,
          mintAddress: nft.mintAddress,
          image: nft.image,
          owner: nft.owner,
          price: Number(nft.price) ?? 0,
          updatedAt: nft.updatedAt,
          metadata: null,
          onChain: false,
        });
      }
    }

    console.timeEnd("⏱ onchain-total");
    return res.json({ history: results });
  } catch (err) {
    console.error("❌ onchain error:", err);
    return res.status(500).json({ error: "Failed to fetch NFTs (onchain)" });
  }
});

/**
 * GET NFT list history milik user login
 * GET /nft/my-history
 */
router.get("/my-history", authenticateJWT, async (req: AuthRequest, res: Response) => {
  console.time("⏱ my-history-total");
  const userId = req.user.id;

  try {
    console.log("\n🚀 Starting /my-history fetch for user:", userId);
    const walletQuery = (req.query.wallet as string)?.trim();
    if (walletQuery) console.log(`🧩 Wallet override detected: ${walletQuery}`);

    // === 1️⃣ Ambil wallet addresses ===
    let walletAddresses: string[] = [];
    if (walletQuery) {
      walletAddresses = [walletQuery];
    } else {
      const user = await Auth.findById(userId).select("wallets");
      if (!user) return res.status(401).json({ error: "User not found" });
      walletAddresses = user.wallets?.map((w) => w.address) || [];
      if (!walletAddresses.length) return res.json({ history: [] });
    }
    console.log(`👛 Wallets: ${walletAddresses.join(", ")}`);

    // === 2️⃣ Setup connection ===
    const connection = new Connection(process.env.SOLANA_CLUSTER as string, "confirmed");
    const programId = new PublicKey(process.env.PROGRAM_ID!);
    const results: any[] = [];
    const signatures: any[] = [];

    // === 3️⃣ Ambil signatures ===
    console.time("⏱ FetchSignatures");
    for (const address of walletAddresses) {
      const walletPk = new PublicKey(address);
      const sigs = await connection.getSignaturesForAddress(walletPk, { limit: 50 });
      sigs.forEach((s) => signatures.push({ ...s, wallet: address }));
    }
    console.timeEnd("⏱ FetchSignatures");
    console.log(`🧮 Total signatures: ${signatures.length}`);

    // === 4️⃣ Filter transaksi MintAndList / BuyNft ===
    console.time("⏱ FilterTransactions");
    await Promise.all(
      signatures.map((sig) =>
        limit(async () => {
          try {
            const tx = await connection.getTransaction(sig.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0,
            });
            if (!tx?.meta?.logMessages) return;

            const logs = tx.meta.logMessages;
            const hasMintAndList = logs.some((l) => l.includes("Instruction: MintAndList"));
            const hasBuyNft = logs.some((l) => l.includes("Instruction: BuyNft"));
            if (!hasMintAndList && !hasBuyNft) return;

            const eventType = hasMintAndList ? "MintAndList" : "BuyNft";

            const accountKeys = tx.transaction.message.getAccountKeys().staticAccountKeys;
            const walletIndex = accountKeys.findIndex((k) => k.toBase58() === sig.wallet);

            let amountFrom = null;
            let amountTo = null;

            if (walletIndex >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
              const pre = tx.meta.preBalances[walletIndex] || 0;
              const post = tx.meta.postBalances[walletIndex] || 0;
              const diff = (post - pre) / anchor.web3.LAMPORTS_PER_SOL;

              if (diff < 0) amountFrom = Math.abs(diff);
              if (diff > 0) amountTo = diff;
            }

            results.push({
              signature: sig.signature,
              wallet: sig.wallet,
              slot: sig.slot,
              blockTime: sig.blockTime ? new Date(sig.blockTime * 1000) : null,
              eventType,
              amount_from: amountFrom,
              amount_to: amountTo,
            });
          } catch (err: any) {
            console.warn(`⚠️ Skip TX ${sig.signature}: ${err.message || err}`);
          }
        })
      )
    );
    console.timeEnd("⏱ FilterTransactions");
    console.log(`📊 Filtered ${results.length} MintAndList/BuyNft transactions`);

    // === 5️⃣ Enrich mint addresses ===
    console.time("⏱ EnrichMint");
    await enrichMintAddresses(results, connection, programId, walletAddresses);
    console.timeEnd("⏱ EnrichMint");

    // === 6️⃣ Attach NFT model ===
    console.time("⏱ AttachModels");
    await attachNftModel(results);
    console.timeEnd("⏱ AttachModels");

    // === 7️⃣ Final response
    const responseData = {
      cached: false,
      totalWallets: walletAddresses.length,
      totalSignatures: signatures.length,
      totalFromProgram: results.length,
      history: results,
      source: "onchain",
    };

    // 🔔 Broadcast real-time
    broadcast({
      type: "history-update",
      userId,
      data: responseData,
      timestamp: new Date().toISOString(),
    });

    console.timeEnd("⏱ my-history-total");
    console.log(`✅ Returning ${results.length} entries\n`);

    return res.json(responseData);

  } catch (err: any) {
    console.error("❌ my-history error:", err);
    console.timeEnd("⏱ my-history-total");
    return res.status(500).json({ error: "Failed to fetch my-history NFTs" });
  }
});

// GET /nft/top-creators
router.get("/top-creators", async (req, res) => {
  try {
    // ambil semua NFT minted dari DB
    const nfts = await Nft.find({ status: "minted" }).select("owner");

    if (!nfts || nfts.length === 0) {
      return res.json([]);
    }

    // hitung jumlah NFT per owner
    const ownerMap: Record<string, number> = {};
    nfts.forEach((nft) => {
      if (!nft.owner) return;
      ownerMap[nft.owner] = (ownerMap[nft.owner] || 0) + 1;
    });

    // ambil semua user (name + avatar + wallets)
    const users = await Auth.find({})
      .select("name avatar wallets.address custodialWallets.address")
      .lean();

    // gabungkan data
    const creators = Object.entries(ownerMap).map(([owner, count]) => {
      const user = users.find(
        (u: any) =>
          u.wallets?.some((w: any) => w.address === owner) ||
          u.custodialWallets?.some((c: any) => c.address === owner)
      );

      return {
        owner,
        count,
        name: user?.name,
        avatar: user?.avatar
          ? `${process.env.BASE_URL}/${
              user.avatar.startsWith("/") ? user.avatar.slice(1) : user.avatar
            }`
          : "/uploads/avatars/default.png",
      };
    });

    // urutkan dari terbanyak → ambil top 5
    const topCreators = creators
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return res.json(topCreators);
  } catch (err: any) {
    console.error("❌ Error fetching top creators:", err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;