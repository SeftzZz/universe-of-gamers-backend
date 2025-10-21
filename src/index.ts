import express from "express";
import cors from "cors";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

import { connectDB } from "./services/dbService";
import nftRoutes from "./routes/nft";
import walletRoutes from "./routes/wallet";
import authRoutes from "./routes/auth";
import solRoutes from "./routes/sol";
import characterRoutes from "./routes/character";
import gatchaRoutes from "./routes/gatcha";
import battleRoutes from "./routes/battle";
import battleSimulateRouter from "./routes/battleSimulate";
import { authenticateJWT, requireAdmin, AuthRequest } from "./middleware/auth";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

/* 🌐 === CORS Configuration === */
const allowedOrigins = [
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

  ws.on("message", (msg: string) => {
    try {
      const data = JSON.parse(msg);
      console.log("📨 Message from client:", data);

      if (data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: new Date().toISOString() }));
      }
    } catch (err) {
      console.error("❌ Invalid WS message:", err);
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
  server.listen(PORT, () => {
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket active on ws://localhost:${PORT}`);
    console.log("🌍 Allowed Origins:", allowedOrigins.join(", "));
  });
})();
