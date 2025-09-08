// === add by fpp 05/09/25 ===
import { Router } from "express";
import { Character } from "../models/Character"; // pakai named import

const router = Router();

// contoh endpoint GET semua character
router.get("/", async (req, res) => {
  try {
    const characters = await Character.find();
    res.json(characters);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch characters" });
  }
});

// contoh endpoint POST tambah character
router.post("/", async (req, res) => {
  try {
    const newChar = new Character(req.body);
    await newChar.save();
    res.status(201).json(newChar);
  } catch (err) {
    res.status(400).json({ error: "Failed to create character" });
  }
});

export default router;

// ===========================
