import { Router } from "express";
import path from "path";

const router = Router();
const idlPath = path.join(process.cwd(), "public/idl/uog_marketplace.json");

console.log("📂 Serving IDL from:", idlPath);

// ✅ Terima GET/POST/PUT/DELETE sekalian
router.all("/uog_marketplace", (req, res) => {
  res.sendFile(idlPath, (err) => {
    if (err) {
      console.error("❌ Error kirim IDL:", err);
      res.status(500).json({ error: "Failed to load IDL" });
    }
  });
});

export default router;
