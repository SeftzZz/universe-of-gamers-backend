import express from "express";
import cors from "cors";
import path from "path";
import bodyParser from "body-parser";
import dotenv from "dotenv";
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
import battleRoutes from "./routes/battle";
import battleSimulateRouter from "./routes/battleSimulate";
import { authenticateJWT, requireAdmin, AuthRequest } from "./middleware/auth";

import mongoose from "mongoose";

dotenv.config();

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
  startWalletStream();

  server.listen(PORT, () => {
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
    console.log(`📡 WebSocket active on ws://localhost:${PORT}`);
    console.log("🌍 Allowed Origins:", allowedOrigins.join(", "));
  });
})();
