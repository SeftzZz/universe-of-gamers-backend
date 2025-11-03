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
app.use("/api", battleRoutes);
app.use("/api", solRoutes);
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
      if (data.type === "battle_updated") {
        const { battleId, result, players } = data;
        console.log("──────────────────────────────────────────────");
        console.log(`⚔️ [WS Battle Update] Processing → ${battleId}`);
        console.log(`🧩 Result: ${result || "N/A"} | Players: ${players ? players.length : 0}`);
        console.log("──────────────────────────────────────────────");

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
          const playerId = p.user;
          console.log(`🔎 Verifying team integrity for player: ${playerId}`);

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
              console.log(`🧬 Verifying NFT integrity → ${nft.name}`);
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
            const playerId = p.user;
            const isWinner = p.isWinner;

            console.log(`🏁 Player ${playerId} → ${isWinner ? "🏆 WINNER" : "💀 LOSER"}`);

            const teamId = p.team?._id || p.team;
            const economicFragment = await calculateEconomicFragment(teamId);
            console.log(`💰 Economic Fragment: ${economicFragment.toFixed(4)}`);

            const lastEarning = await DailyEarning.findOne({ playerId }).sort({ createdAt: -1 });
            const playerRank = lastEarning?.rank || "sentinel";

            const rawRankModifier = await getRankModifier(playerRank);
            const rankModifier = rawRankModifier || 1; // ✅ fallback default

            const winStreak = isWinner ? (lastEarning?.winStreak || 0) + 1 : 0;
            const WINRATE_MODIFIER: Record<number, number> = {
              1: 0.01, 2: 0.05, 3: 0.07, 4: 0.09, 5: 0.11,
              6: 0.13, 7: 0.15, 8: 0.17, 9: 0.21,
            };
            const skillFragment = (WINRATE_MODIFIER[Math.min(winStreak, 9)] || 0.21) * 100;
            const booster = winStreak >= 3 ? 2 : 1;

            const totalFragment = parseFloat(
              (economicFragment * skillFragment * booster * rankModifier).toFixed(4)
            );
            const totalDaily = parseFloat((totalFragment * 10).toFixed(4));

            console.log(`📈 WinStreak=${winStreak} | Booster=${booster}`);
            console.log(`⚙️ SkillFrag=${skillFragment} | RankMod=${rankModifier}`);
            console.log(`💎 TotalFrag=${totalFragment} | TotalDaily=${totalDaily}`);

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const lastGame = await MatchEarning.findOne({
              playerId,
              createdAt: { $gte: today },
            }).sort({ createdAt: -1 });
            const nextGameNumber = lastGame ? lastGame.gameNumber + 1 : 1;

            const matchResult = await MatchEarning.updateOne(
              { playerId, gameNumber: nextGameNumber },
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
              console.log(`✅ MatchEarning created: ${playerId} | Game #${nextGameNumber}`);
            } else {
              console.log(`⚠️ Skipped duplicate MatchEarning for ${playerId} | Game #${nextGameNumber}`);
            }

            await Player.findOneAndUpdate(
              { walletAddress: playerId },
              {
                $inc: { totalEarning: totalFragment },
                $set: { lastActive: new Date() },
              },
              { upsert: false }
            );

            console.log(`🧾 Player updated: ${playerId} (+${totalFragment} fragments)`);

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
              playerId
            );

            console.log(`📅 DailyEarning updated for ${playerId}`);

            // ✅ Kirim pesan ke client pengirim
            // ws.send(
            //   JSON.stringify({
            //     type: "battle_reward",
            //     battleId: battle._id,
            //     playerId,
            //     rank: playerRank,
            //     totalFragment,
            //     totalDaily,
            //     winStreak,
            //     booster,
            //     isWinner,
            //   })
            // );

            // ✅ Broadcast ke semua client
            broadcast({
              type: "battle_reward_broadcast",
              playerId,
              rank: playerRank,
              totalFragment,
              totalDaily,
              winStreak,
              booster,
              isWinner,
              battleId: battle._id,
              time: new Date().toISOString(),
            });

            console.log(`📢 Broadcasted battle_reward to all clients for ${playerId}`);
            console.log("-----------------------------------");
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
      else if (data.type === "battle_log") {
        const { battleId, attacker, defender, skill, damage, isCrit } = data;

        try {
          // 1️⃣ Validasi input dasar
          if (!battleId || !attacker || !defender || !skill || damage === undefined) {
            ws.send(JSON.stringify({
              type: "battle_error",
              error: "Missing required battle log fields (battleId, attacker, defender, skill, damage)",
            }));
            return;
          }

          // 2️⃣ Cek battle
          const battle = await Battle.findById(battleId);
          if (!battle) {
            ws.send(JSON.stringify({ type: "battle_error", error: "Battle not found" }));
            return;
          }

          // 3️⃣ Ambil attacker & defender NFT
          const [attackerNft, defenderNft] = await Promise.all([
            Nft.findOne({ name: attacker })
              .populate({ path: "character", model: "Character" })
              .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
            Nft.findOne({ name: defender })
              .populate({ path: "character", model: "Character" })
              .populate({ path: "equipped", populate: { path: "rune", model: "Rune" } }),
          ]);

          if (!attackerNft || !defenderNft) {
            ws.send(JSON.stringify({
              type: "battle_error",
              error: "Attacker or defender NFT not found",
            }));
            return;
          }

          // 4️⃣ Verifikasi integritas NFT attacker & defender
          await verifyNftIntegrity(attackerNft);
          await verifyNftIntegrity(defenderNft);

          // 5️⃣ Hitung HP dasar defender
          const baseDefenderHp = defenderNft.hp ?? (defenderNft.character as ICharacter)?.baseHp ?? 100;

          // 6️⃣ Cari HP terakhir defender di log sebelumnya
          const prevLogs = battle.log.filter(l => l.defender === defender);
          const lastHp =
            prevLogs.length > 0
              ? prevLogs[prevLogs.length - 1].remainingHp
              : baseDefenderHp;

          // 7️⃣ Hitung HP baru server-side (tanpa input client)
          const remainingHp = Math.max(0, lastHp - damage);

          // 8️⃣ Buat log baru
          const newLog = {
            attacker,
            defender,
            skill,
            damage,
            isCrit: !!isCrit,
            remainingHp,
            timestamp: new Date(),
          };

          // 9️⃣ Simpan log ke DB
          battle.log.push(newLog);
          battle.updatedAt = new Date();
          await battle.save();

          // 🔟 Logging real-time di server
          console.log("🧩 [BATTLE LOG VERIFIED]");
          console.log(`BattleID=${battle._id}`);
          console.log(`🕹️ ${attacker} ➜ ${defender}`);
          console.log(`⚔️ Skill=${skill} | Damage=${damage} | Crit=${!!isCrit}`);
          console.log(`❤️ HP: ${lastHp} → ${remainingHp}`);
          console.log("-----------------------------------");

          // 11️⃣ Broadcast hasil ke semua client
          broadcast({
            type: "battle_log_broadcast",
            battleId,
            log: newLog,
          });

          // 12️⃣ Kirim respon ke pengirim
          ws.send(JSON.stringify({
            type: "battle_log_saved",
            success: true,
            message: "Battle log appended (HP computed server-side)",
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
      else if (data.type === "ping") {
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
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket active on ws://localhost:${PORT}`);
    console.log("🌍 Allowed Origins:", allowedOrigins.join(", "));
  });
})();
