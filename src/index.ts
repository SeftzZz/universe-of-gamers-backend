import express from "express";
import cors from "cors";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import http from "http"; // ⬅️ tambahkan
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
app.use(cors());
app.use(bodyParser.json());
app.use(express.json());

app.use("/api/nft", nftRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/gatcha", gatchaRoutes);
app.use("/api", battleRoutes);
app.use("/api", solRoutes);
app.use("/api", battleSimulateRouter);

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.get("/api/ping", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

// === HTTP SERVER + WEBSOCKET SETUP ===
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Hapus deklarasi ganda, gunakan hanya yang ini:
interface WSClient {
  id: string;
  ws: WebSocket;
}

const clients: WSClient[] = [];

// Ketika client terhubung
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

// Fungsi helper broadcast
export const broadcast = (data: any) => {
  const json = JSON.stringify(data);
  clients.forEach(({ ws }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  });
};

(async () => {
  await connectDB();
  server.listen(PORT, () => {
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket active on ws://localhost:${PORT}`);
  });
})();
