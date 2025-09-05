import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { connectDB } from "./services/dbService";
import nftRoutes from "./routes/nft";
import walletRoutes from "./routes/wallet";
import authRoutes from "./routes/auth";
import solRoutes from './routes/sol';
import dotenv from "dotenv";
import characterRoutes from "./routes/character"; // add by fpp 05/09/25
dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.use(express.json()); // add by fpp 05/09/25 untuk route character

app.use("/api/nft", nftRoutes);

app.use("/api/wallet", walletRoutes);

app.use("/api/auth", authRoutes);

app.use('/api', solRoutes);

app.use("/api/characters", characterRoutes); // add by fpp 05/09/25 untuk route character

const PORT = process.env.PORT || 3000;

(async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`🚀 NFT Backend running on http://localhost:${PORT}`);
  });
})();
