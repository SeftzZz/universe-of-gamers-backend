import express from "express";
import cors from "cors";
import path from "path";
import bodyParser from "body-parser";

import { loadSecretsToEnv } from "./loadSecrets";

import dotenv from "dotenv";
dotenv.config();

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

import { connectDB } from "./services/dbService";
import { startWalletStream } from "./services/walletStreamService";
import nftRoutes from "./routes/nft";
import walletRoutes from "./routes/wallet";
import authRoutes from "./routes/auth";
import solRoutes from "./routes/sol";
import characterRoutes from "./routes/character";
import gatchaRoutes from "./routes/gatcha";
import withdrawRoutes from "./routes/withdraw";
import referralRoutes from "./routes/referral";
import prizePoolRoutes from "./routes/prizepool";
import tournamentRoutes from "./routes/tournament";

import { authenticateJWT, requireAdmin, AuthRequest } from "./middleware/auth";

import { Types } from "mongoose";
import { Battle } from "./models/Battle";
import { DailyEarning } from "./models/DailyEarning";
import { MatchEarning } from "./models/MatchEarning";
import { Player } from "./models/Player";
import { ICharacter } from "./models/Character";
import { Team } from "./models/Team";
import { PlayerHero } from "./models/PlayerHero"; // ✅ wajib
import { Nft } from "./models/Nft";               // ✅ untuk verifikasi NFT

import battleRoutes, {
  calculateEconomicFragment,
  getRankModifier,
  saveDailyEarning,
  verifyNftIntegrity
} from "./routes/battle";

import { TournamentPack } from "./models/TournamentPack";
import { Tournament } from "./models/Tournament";
import { TournamentParticipant } from "./models/TournamentParticipant";
import { TournamentMatch } from "./models/TournamentMatch";

import battleSimulateRouter from "./routes/battleSimulate";

import mongoose from "mongoose";

const app = express();
app.set("trust proxy", 1);

/* 🌐 === CORS Configuration === */
const allowedOrigins = [
  "http://192.168.18.30:8100", // Dev Device
  "http://172.19.48.1:8100", // Dev Device WSL
  "http://localhost", // Dev
  "http://localhost:8100", // Ionic
  "http://localhost:4200", // Angular
  "http://localhost:5173", // Vite
  "https://localhost", // DEV SSL
  "https://play.unity.com", // Unity
  "https://play.unity.com/en/games/71c840ea-345a-422f-bf58-77c1e6b6a17d/world-of-monsters-webgl", // WebGL Game
  "https://universeofgamers.io", // Domain utama
  "https://api.universeofgamers.io", // API
  "https://worldofmonsters.universeofgamers.io", // Game World Of Monsters
  "https://marketplace.universeofgamers.io", // Marketplace Website
  "https://solscan.io", // SolScan
  "https://event.universeofgamers.io", // Event
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.some((o) =>
          origin.toLowerCase().startsWith(o.toLowerCase())
        )
      ) {
        callback(null, true);
      } else {
        console.warn("❌ Blocked CORS origin:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(bodyParser.json());
app.use(express.json());

/* === ROUTES === */
app.use("/api/nft", nftRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/gatcha", gatchaRoutes);
app.use("/api/withdraw", withdrawRoutes);
app.use("/api/referral", referralRoutes);
app.use("/api", battleRoutes);
app.use("/api", solRoutes);
app.use("/api", prizePoolRoutes);
app.use("/api", tournamentRoutes);
app.use("/api", battleSimulateRouter);

// app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
/* === STATIC ASSETS === */
// ✅ Allow Unity WebGL to fetch assets (textures/audio/etc.)
app.use(
  "/uploads",
  (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*"); // aman untuk asset statis
    res.header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept"
    );

    // Tangani preflight (OPTIONS)
    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  },
  express.static(path.join(process.cwd(), "uploads"))
);

/* === TEST PING === */
app.get("/api/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* === FORM JOIN EVENT === */
import multer from "multer";
import fs from "fs";
import { Request } from "express";

interface MulterRequest extends Request {
  files?: Express.Multer.File[];
}

// 🧱 Schema sederhana untuk form join (tambahkan attachments)
const joinSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    cryptoKnowledge: { type: String, required: true },
    infoSource: { type: String, required: true },
    attachments: [{ type: String }], // 🆕 file upload
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "event_joins" }
);

const EventJoin = mongoose.model("EventJoin", joinSchema);

// 📂 Folder penyimpanan file upload
const uploadPath = path.join(process.cwd(), "uploads/join_attachments");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

// ⚙️ Konfigurasi multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadPath),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

// Batasi format file agar aman
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
  fileFilter: (req, file, cb) => {
    const allowed = [".png", ".jpg", ".jpeg", ".pdf"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error("Only .png, .jpg, .jpeg, .pdf files are allowed"));
    }
    cb(null, true);
  },
});

async function autoGenerateNextPhase(tournament: any, nextPhase: any) {
  console.log("⚙️ Auto-generating next phase:", nextPhase);

  const winners = await TournamentParticipant.find({
    tournamentId: tournament._id,
    eliminated: false
  });

  if (winners.length < 2) return;

  if (nextPhase === "semi") {
    // generate 2 matches
    await TournamentMatch.create({
      tournamentId: tournament._id,
      phase: "semi",
      player1: winners[0].walletAddress,
      player2: winners[1].walletAddress,
      team1: winners[0].team,
      team2: winners[1].team
    });

    await TournamentMatch.create({
      tournamentId: tournament._id,
      phase: "semi",
      player1: winners[2].walletAddress,
      player2: winners[3].walletAddress,
      team1: winners[2].team,
      team2: winners[3].team
    });
  }

  if (nextPhase === "final") {
    await TournamentMatch.create({
      tournamentId: tournament._id,
      phase: "final",
      player1: winners[0].walletAddress,
      player2: winners[1].walletAddress,
      team1: winners[0].team,
      team2: winners[1].team
    });
  }

  tournament.currentPhase = nextPhase;
  await tournament.save();

  broadcast({
    type: "tournament_phase_update",
    tournamentId: tournament._id,
    phase: nextPhase
  });

  console.log(`🎉 New phase generated: ${nextPhase}`);
}

// 📥 POST /api/join
app.post("/api/join", upload.array("attachments", 5), async (req, res) => {
  try {
    const { name, email, phone, address, cryptoKnowledge, infoSource } = req.body;

    if (!name || !email || !phone || !address) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // simpan path file jika ada
    const files =
    (req.files as Express.Multer.File[] | undefined)?.map(
      (f) => `/uploads/join_attachments/${f.filename}`
    ) || [];

    const newJoin = await EventJoin.create({
      name,
      email,
      phone,
      address,
      cryptoKnowledge,
      infoSource,
      attachments: files,
    });

    console.log("✅ New Join Event:", newJoin);
    res.json({
      success: true,
      message: "Data saved successfully",
      data: newJoin,
    });
  } catch (err) {
    console.error("❌ Error saving join data:", err);
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});


/* === SERVER + WEBSOCKET === */
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

interface WSClient {
  id: string;
  ws: WebSocket;
}

const clients: WSClient[] = [];

// ✅ WebSocket Connection
wss.on("connection", (ws: WebSocket) => {
  const clientId = `client-${Date.now()}`;
  clients.push({ id: clientId, ws });
  console.log(`🔌 Client connected: ${clientId}`);

  ws.send(JSON.stringify({ type: "welcome", message: "Connected to NFT backend WebSocket" }));

  ws.on("message", async (msg: string) => {
    try {
      const data = JSON.parse(msg);
      console.log("📨 Message from client:", data);

      // ======================================================
      // ⚔️ UPDATE BATTLE RESULT (via WebSocket)
      // ======================================================
      if (data.message.type === "battle_updated") {
        const { battleId, result, players } = data.message;
        // console.log("──────────────────────────────────────────────");
        // console.log(`⚔️ [WS Battle Update] Processing → ${battleId}`);
        // console.log(`🧩 Result: ${result || "N/A"} | Players: ${players ? players.length : 0}`);
        // console.log("──────────────────────────────────────────────");

        const updateData: Record<string, any> = {};
        if (result) updateData.result = result;
        if (players) updateData.players = players;

        const battle = await Battle.findByIdAndUpdate(battleId, updateData, { new: true })
          .populate({
            path: "players.team",
            model: "Team",
            populate: {
              path: "members",
              model: "Nft",
              populate: {
                path: "character",
                model: "Character",
                select:
                  "name baseHp baseAtk baseDef baseSpd baseCritRate baseCritDmg basicAttack skillAttack ultimateAttack",
              },
            },
          });

        if (!battle) {
          ws.send(JSON.stringify({ type: "battle_error", error: "Battle not found" }));
          return;
        }

        // ✅ Anti-cheat verification
        for (const p of battle.players) {
          const walletAddress = p.user;
          console.log(`🔎 Verifying team integrity for player: ${walletAddress}`);

          const team =
            p.team && typeof p.team === "object" && "members" in p.team
              ? p.team
              : await Team.findById(p.team).populate({
                  path: "members",
                  model: "Nft",
                  populate: { path: "character", model: "Character" },
                });

          if (team?.members && Array.isArray(team.members)) {
            for (const nft of team.members) {
              console.log(`🧬 Verifying NFT integrity → ${nft.name} → ${nft.mintAddress}`);
              await verifyNftIntegrity(nft);
            }
          }
        }

        console.log("✅ All NFT integrity checks passed");
        console.log("──────────────────────────────────────────────");

        // ===================================================
        // Jika Battle selesai → Proses earning
        // ===================================================
        if (result === "end_battle") {
          console.log("🎯 Battle marked as END — processing rewards...");

          for (const p of battle.players) {
            const walletAddress = p.user;
            const isWinner = p.isWinner;

            console.log(`🏁 Player ${walletAddress} → ${isWinner ? "🏆 WINNER" : "💀 LOSER"}`);

            const teamId = p.team?._id || p.team;
            const economicFragment = await calculateEconomicFragment(teamId);
            console.log(`💰 Economic Fragment: ${economicFragment}`);

            const lastEarning = await DailyEarning.findOne({ walletAddress }).sort({ createdAt: -1 });
            const playerRank = lastEarning?.rank || "sentinel";

            const rawRankModifier = await getRankModifier(playerRank);
            const rankModifier = rawRankModifier || 1; // ✅ fallback default

            const winStreak = isWinner ? (lastEarning?.winStreak || 0) + 1 : 0;
            const WINRATE_MODIFIER: Record<number, number> = {
              1: 0.01, 2: 0.05, 3: 0.07, 4: 0.09, 5: 0.11,
              6: 0.13, 7: 0.15, 8: 0.17, 9: 0.21,
            };
            const skillFragment = (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0.21);
            const booster = winStreak >= 3 ? 2 : 1;

            const totalFragment = economicFragment * skillFragment * booster * rankModifier;
            const totalDaily = totalFragment * 10;

            console.log(`📈 WinStreak=${winStreak} | Booster=${booster}`);
            console.log(`⚙️ SkillFrag=${skillFragment} | RankMod=${rankModifier}`);
            console.log(`💎 TotalFrag=${totalFragment} | TotalDaily=${totalDaily}`);

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const lastGame = await MatchEarning.findOne({
              walletAddress,
              createdAt: { $gte: today },
            }).sort({ createdAt: -1 });
            const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

            const matchResult = await MatchEarning.updateOne(
              { walletAddress, gameNumber: nextGameNumber },
              {
                $setOnInsert: {
                  winCount: isWinner ? 1 : 0,
                  skillFragment,
                  economicFragment,
                  booster,
                  rankModifier,
                  totalFragment,
                  createdAt: new Date(),
                },
              },
              { upsert: true }
            );

            if (matchResult.upsertedCount > 0) {
              console.log(`✅ MatchEarning created: ${walletAddress} | Game #${nextGameNumber}`);
            } else {
              console.log(`⚠️ Skipped duplicate MatchEarning for ${walletAddress} | Game #${nextGameNumber}`);
            }

            await Player.findOneAndUpdate(
              { walletAddress: walletAddress },
              {
                $inc: { totalEarning: totalFragment },
                $set: { lastActive: new Date() },
              },
              { upsert: false }
            );

            console.log(`🧾 Player updated: ${walletAddress} (+${totalFragment} fragments)`);

            await saveDailyEarning(
              {
                rank: playerRank,
                winStreak,
                totalFragment,
                totalDaily,
                heroes:
                  p.team && typeof p.team === "object" && "members" in p.team
                    ? (p.team.members as any[])
                    : [],
              },
              walletAddress
            );

            console.log(`📅 DailyEarning updated for ${walletAddress}`);

            // ✅ Kirim pesan ke client pengirim
            ws.send(
              JSON.stringify({
                type: "battle_reward",
                battleId: battle._id,
                walletAddress,
                rank: playerRank,
                totalFragment,
                totalDaily,
                winStreak,
                booster,
                isWinner,
              })
            );

            // ✅ Broadcast ke semua client
            broadcast({
              type: "battle_reward_broadcast",
              walletAddress,
              rank: playerRank,
              totalFragment,
              totalDaily,
              winStreak,
              booster,
              isWinner,
              battleId: battle._id,
              time: new Date().toISOString(),
            });

            console.log(`📢 Broadcasted battle_reward to all clients for ${walletAddress}`);
            console.log("-----------------------------------");

            // ===================================================
            // 🏆 TOURNAMENT INTEGRATION — Update Tournament Match
            // ===================================================
            const tournamentMatch = await TournamentMatch.findOne({ battleId });

            if (tournamentMatch) {
              console.log("🎯 Tournament match detected → updating result...");

              // winner wallet
              const winnerPlayer = battle.players.find(p => p.isWinner);
              const winnerWallet = winnerPlayer?.user;

              if (winnerWallet) {
                tournamentMatch.winner = winnerWallet;
                tournamentMatch.completed = true;
                await tournamentMatch.save();

                console.log("🔥 TournamentMatch updated:", tournamentMatch._id);

                // tandai yang kalah
                const loserWallet =
                  battle.players.find(p => !p.isWinner)?.user;

                if (loserWallet) {
                  await TournamentParticipant.findOneAndUpdate(
                    { walletAddress: loserWallet, tournamentId: tournamentMatch.tournamentId },
                    { eliminated: true }
                  );
                  console.log("💀 Eliminated participant:", loserWallet);
                }

                // BROADCAST update match ke client frontend
                broadcast({
                  type: "tournament_match_update",
                  matchId: tournamentMatch._id,
                  tournamentId: tournamentMatch.tournamentId,
                  winner: winnerWallet,
                  loser: loserWallet,
                  battleId
                });

                // ===================================================
                // AUTO NEXT PHASE HANDLING
                // ===================================================
                const t = await Tournament.findById(tournamentMatch.tournamentId);
                if (t) {
                  const remaining = await TournamentParticipant.countDocuments({
                    tournamentId: t._id,
                    eliminated: false
                  });

                  console.log(`🎯 Tournament phase check: phase=${t.currentPhase} | remaining=${remaining}`);

                  // quarter → semi (4 left)
                  if (t.currentPhase === "quarter" && remaining === 4) {
                    await autoGenerateNextPhase(t, "semi");
                  }

                  // semi → final (2 left)
                  if (t.currentPhase === "semi" && remaining === 2) {
                    await autoGenerateNextPhase(t, "final");
                  }

                  // final → completed (1 left)
                  if (t.currentPhase === "final" && remaining === 1) {
                    const champion = await TournamentParticipant.findOne({
                      tournamentId: t._id,
                      eliminated: false
                    });

                    t.winner = champion?.walletAddress;
                    t.currentPhase = "completed";
                    await t.save();

                    broadcast({
                      type: "tournament_finished",
                      tournamentId: t._id,
                      winner: champion?.walletAddress
                    });

                    console.log("🏆 Tournament completed → Winner =", champion?.walletAddress);
                  }
                }
              }
            }

          }
        }

        // 🔊 Battle update global (1x saja, di luar loop)
        broadcast({
          type: "battle_updated",
          battleId,
          result,
          battle,
          time: new Date().toISOString(),
        });

        console.log(`✅ Battle updated & broadcasted: ${battle._id}`);
        console.log("──────────────────────────────────────────────");
      }

      // ======================================================
      // 🧩 APPEND VERIFIED BATTLE LOG
      // ======================================================
      else if (data.message.type === "battle_log") {
        console.log("🧩 APPEND VERIFIED BATTLE LOG");
        const { battleId, attacker, defender, skill, damage, isCrit } = data.message;

        try {
          // 1️⃣ Validasi input
          if (!battleId || !attacker || !defender || !skill || damage === undefined) {
            ws.send(JSON.stringify({
              type: "battle_error",
              error: "Missing required battle log fields",
            }));
            return;
          }

          // 2️⃣ Load battle + populate team + members (NFT)
          const battle = await Battle.findById(battleId)
            .populate({
              path: "players.team",
              populate: {
                path: "members",
                model: "Nft",
                select: "name owner",
              }
            });

          if (!battle) {
            ws.send(JSON.stringify({ type: "battle_error", error: "Battle not found" }));
            return;
          }

          // 3️⃣ Extract team membership
          const teamMembersMap: Record<string, string[]> = {};

          for (const player of battle.players) {
            const team = player.team as any;

            if (team && Array.isArray(team.members)) {
              teamMembersMap[player.user] = team.members.map((m: any) => m.name);
            }
          }

          // 4️⃣ Validasi attacker harus bagian dari team yang benar
          const attackerOwner = battle.players.find(p =>
            (teamMembersMap[p.user] || []).includes(attacker)
          )?.user;

          if (!attackerOwner) {
            throw new Error("Attacker NFT is not part of player's team (CHEAT!)");
          }

          // 5️⃣ Validasi defender harus bagian dari team yang benar
          const defenderOwner = battle.players.find(p =>
            (teamMembersMap[p.user] || []).includes(defender)
          )?.user;

          if (!defenderOwner) {
            throw new Error("Defender NFT is not part of player's team (CHEAT!)");
          }

          // 6️⃣ Ambil NFT attacker & defender berdasarkan name + owner
          const [attackerNft, defenderNft] = await Promise.all([
            Nft.findOne({ name: attacker, owner: attackerOwner })
              .populate({ path: "character", model: "Character" })
              .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),

            Nft.findOne({ name: defender, owner: defenderOwner })
              .populate({ path: "character", model: "Character" })
              .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
          ]);

          if (!attackerNft || !defenderNft) {
            throw new Error("Attacker or defender NFT not found (invalid owner or not in team)");
          }

          // 7️⃣ NFT integrity check
          await verifyNftIntegrity(attackerNft);
          await verifyNftIntegrity(defenderNft);

          // 8️⃣ Hitung base HP defender
          const char: any = defenderNft.character;
          const baseDefenderHp = defenderNft.hp ?? char?.baseHp ?? 100;

          // 9️⃣ Ambil HP terakhir dari log
          const prevLogs = battle.log.filter((l: any) => l.defender === defender);
          const lastHp =
            prevLogs.length > 0
              ? prevLogs[prevLogs.length - 1].remainingHp
              : baseDefenderHp;

          // 🔟 Hitung HP baru
          const remainingHp = Math.max(0, lastHp - damage);

          // 1️⃣1️⃣ Buat log
          const newLog = {
            attacker,
            defender,
            skill,
            damage,
            isCrit: !!isCrit,
            remainingHp,
            timestamp: new Date(),
          };

          // 1️⃣2️⃣ Simpan ke DB
          battle.log.push(newLog);
          battle.updatedAt = new Date();
          await battle.save();

          // 1️⃣3️⃣ Broadcast
          broadcast({
            type: "battle_log_broadcast",
            battleId,
            log: newLog,
          });

          // 1️⃣4️⃣ Response
          ws.send(JSON.stringify({
            type: "battle_log_saved",
            success: true,
            message: "Battle log appended safely",
            log: newLog,
          }));

        } catch (err: any) {
          console.error("🚫 Error appending battle log:", err.message);
          ws.send(JSON.stringify({
            type: "battle_error",
            error: "NFT integrity failed or invalid log data",
            details: err.message,
          }));
        }
      }

      // ======================================================
      // 🧭 Ping-Pong
      // ======================================================
      else if (data.message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: new Date().toISOString() }));
      }
    } catch (err: any) {
      console.error("🚫 WS Battle Error:", err.message);
      ws.send(
        JSON.stringify({
          type: "battle_error",
          error: err.message,
        })
      );
    }
  });

  ws.on("close", () => {
    console.log(`❌ Client disconnected: ${clientId}`);
  });
});

// ✅ Broadcast helper
export const broadcast = (data: any) => {
  const json = JSON.stringify(data);
  clients.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  });
};

// ✅ Start server
(async () => {
  await connectDB();
  await loadSecretsToEnv("universe-of-gamers-env"); // nama secret kamu di GCP
  startWalletStream();

  server.listen(PORT, () => {
    console.log(`📡 Program ID:${process.env.PROGRAM_ID}`);
    console.log(`   Backend version 23.11.2025`);
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket active on ws://localhost:${PORT}`);
    console.log("🌍 Allowed Origins:", allowedOrigins.join(", "));
  });
})();
