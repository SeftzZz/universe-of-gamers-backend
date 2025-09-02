import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { connectDB } from "./services/dbService";
import nftRoutes from "./routes/nft";
import walletRoutes from "./routes/wallet";
import authRoutes from "./routes/auth";
import solRoutes from './routes/sol';
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use("/api/nft", nftRoutes);

app.use("/api/wallet", walletRoutes);

app.use("/api/auth", authRoutes);

app.use('/api', solRoutes);

const PORT = process.env.PORT || 3000;

(async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
  });
})();
