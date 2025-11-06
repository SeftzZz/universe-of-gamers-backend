import fs from "fs";
import dotenv from "dotenv";
import { loadSecretsToEnv } from "./loadSecrets";

(async () => {
  const envPath = ".env";

  if (fs.existsSync(envPath)) {
    console.log("📦 .env file found → using local environment");
    dotenv.config();
  } else {
    console.log("☁️ No .env found → loading from Google Secret Manager...");
    try {
      await loadSecretsToEnv("universe-of-gamers-env");
      console.log("✅ Secrets loaded successfully");
    } catch (err) {
      console.error("❌ Failed to load secrets:", err);
      process.exit(1);
    }
  }

  console.log("🚀 Starting main app...");
  require("./index.js"); // ketika di-compile, otomatis jadi ./index.js
})();
