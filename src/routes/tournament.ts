import express from "express";
import { TournamentPack } from "../models/TournamentPack";
import { Tournament } from "../models/Tournament";
import { TournamentParticipant } from "../models/TournamentParticipant";
import { TournamentMatch } from "../models/TournamentMatch";
import { Team } from "../models/Team";
import { Battle } from "../models/Battle";

const router = express.Router();

/**
 * @route POST /tournament/create-pack
 * @desc Create a Tournament Pack
 * @body {
 *   name: string,
 *   description?: string,
 *   image?: string,
 *   priceUOG?: number,
 *   priceSOL?: number,
 *   maxParticipants?: number,
 *   rewards?: [{ rank: number, rewardUOG: number, description?: string }]
 * }
 */
router.post("/tournament/create-pack", async (req, res) => {
  try {
    const {
      name,
      description,
      image,
      priceUOG = 0,
      priceSOL = 0,
      maxParticipants = 8,
      rewards = [],
    } = req.body;

    // 1️⃣ Validasi dasar
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // 2️⃣ Auto-generate default rewards jika kosong
    let finalRewards = rewards;

    if (!rewards || rewards.length === 0) {
      finalRewards = [
        {
          rank: 1,
          rewardUOG: Math.round(priceUOG * 0.70),
          description: "Champion reward",
        },
        {
          rank: 2,
          rewardUOG: Math.round(priceUOG * 0.20),
          description: "Runner-up reward",
        },
        {
          rank: 3,
          rewardUOG: Math.round(priceUOG * 0.10),
          description: "3rd place reward",
        },
      ];
    }

    // 3️⃣ Simpan
    const pack = await TournamentPack.create({
      name,
      description,
      image,
      priceUOG,
      priceSOL,
      maxParticipants,
      rewards: finalRewards,
    });

    return res.json({
      success: true,
      data: pack,
    });
  } catch (err: any) {
    console.error("❌ Error creating TournamentPack:", err);

    return res.status(500).json({
      success: false,
      error: "Failed to create TournamentPack",
      details: err.message,
    });
  }
});

/* ============================================================
   🧩 1. CREATE TOURNAMENT
   - Admin memilih pack
   - Tournament masih kosong (belum ada player)
============================================================ */
router.post("/tournament/create", async (req, res) => {
  try {
    const { name, packId } = req.body;

    const pack = await TournamentPack.findById(packId);
    if (!pack) return res.status(404).json({ error: "Pack not found" });

    const t = new Tournament({
      name,
      pack: packId,
      currentPhase: "quarter",
    });

    await t.save();

    res.json({ success: true, tournament: t });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 2. GET ALL TOURNAMENTS
============================================================ */
router.get("/tournament", async (_req, res) => {
  const tournaments = await Tournament.find().populate("pack");
  res.json(tournaments);
});

/* ============================================================
   🧩 3. GET TOURNAMENT DETAIL
============================================================ */
router.get("/tournament/:id", async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id).populate("pack");
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    const participants = await TournamentParticipant.find({
      tournamentId: t._id,
    }).populate("team");

    const matches = await TournamentMatch.find({
      tournamentId: t._id,
    }).populate("battleId");

    res.json({ tournament: t, participants, matches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 4. JOIN TOURNAMENT (PAID ENTRY)
============================================================ */
router.post("/tournament/:id/join", async (req, res) => {
  try {
    const { walletAddress, teamId } = req.body;

    const tournament = await Tournament.findById(req.params.id).populate("pack");
    if (!tournament) return res.status(404).json({ error: "Tournament not found" });

    // Check peserta < 8
    const count = await TournamentParticipant.countDocuments({
      tournamentId: tournament._id,
    });
    if (count >= 8) return res.status(400).json({ error: "Tournament is full" });

    // Check sudah join
    const exists = await TournamentParticipant.findOne({
      tournamentId: tournament._id,
      walletAddress,
    });
    if (exists) return res.status(400).json({ error: "Already joined" });

    // TODO: Proses pembayaran berdasarkan priceUOG / priceSOL / priceUSD
    // (Integrasi Phantom / UOG smart contract)

    const participant = new TournamentParticipant({
      tournamentId: tournament._id,
      walletAddress,
      team: teamId,
    });

    await participant.save();

    res.json({ success: true, participant });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 5. GENERATE QUARTER-FINAL MATCHES (8 PLAYER)
============================================================ */
router.post("/tournament/:id/generate-quarter", async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    const participants = await TournamentParticipant.find({
      tournamentId: t._id,
      eliminated: false,
    });

    if (participants.length !== 8)
      return res.status(400).json({ error: "Exactly 8 players required" });

    // Random shuffle participants
    const shuffled = participants.sort(() => Math.random() - 0.5);

    const pairs = [];
    for (let i = 0; i < 8; i += 2) {
      pairs.push([shuffled[i], shuffled[i + 1]]);
    }

    const createdMatches = [];

    for (const [p1, p2] of pairs) {
      const match = new TournamentMatch({
        tournamentId: t._id,
        phase: "quarter",
        player1: p1.walletAddress,
        player2: p2.walletAddress,
        team1: p1.team,
        team2: p2.team,
        completed: false,
      });

      await match.save();
      createdMatches.push(match);
    }

    res.json({ success: true, matches: createdMatches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 6. RECORD MATCH RESULT (AFTER BATTLE)
============================================================ */
router.post("/tournament/match/:matchId/finish", async (req, res) => {
  try {
    const { winner, battleId } = req.body;

    const match = await TournamentMatch.findById(req.params.matchId);
    if (!match) return res.status(404).json({ error: "Match not found" });

    match.winner = winner;
    match.battleId = battleId;
    match.completed = true;
    await match.save();

    // Mark loser eliminated
    const loser = match.player1 === winner ? match.player2 : match.player1;

    await TournamentParticipant.findOneAndUpdate(
      {
        tournamentId: match.tournamentId,
        walletAddress: loser,
      },
      { eliminated: true }
    );

    res.json({ success: true, match });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 7. PROCEED TO NEXT PHASE (quarter → semi → final → completed)
============================================================ */
router.post("/tournament/:id/next-phase", async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    if (t.currentPhase === "quarter") {
      // Generate semi-final
      const winners = await TournamentParticipant.find({
        tournamentId: t._id,
        eliminated: false,
      });

      if (winners.length !== 4)
        return res.status(400).json({ error: "Quarter not completed" });

      // Pair for semi-final
      const pairs = [
        [winners[0], winners[1]],
        [winners[2], winners[3]],
      ];

      for (const [p1, p2] of pairs) {
        const m = new TournamentMatch({
          tournamentId: t._id,
          phase: "semi",
          player1: p1.walletAddress,
          player2: p2.walletAddress,
          team1: p1.team,
          team2: p2.team,
          completed: false,
        });
        await m.save();
      }

      t.currentPhase = "semi";
      await t.save();
      return res.json({ success: true, phase: "semi" });
    }

    if (t.currentPhase === "semi") {
      const winners = await TournamentParticipant.find({
        tournamentId: t._id,
        eliminated: false,
      });

      if (winners.length !== 2)
        return res.status(400).json({ error: "Semi-final not completed" });

      const finalMatch = new TournamentMatch({
        tournamentId: t._id,
        phase: "final",
        player1: winners[0].walletAddress,
        player2: winners[1].walletAddress,
        team1: winners[0].team,
        team2: winners[1].team,
        completed: false,
      });

      await finalMatch.save();

      t.currentPhase = "final";
      await t.save();

      return res.json({ success: true, phase: "final" });
    }

    if (t.currentPhase === "final") {
      // final winner is participant who is not eliminated
      const winner = await TournamentParticipant.findOne({
        tournamentId: t._id,
        eliminated: false,
      });

      if (!winner)
        return res.status(400).json({ error: "Final not completed" });

      t.winner = winner.walletAddress;
      t.currentPhase = "completed";
      await t.save();

      return res.json({ success: true, tournamentWinner: winner.walletAddress });
    }

    res.json({ message: "Tournament already completed" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 8. DELETE TOURNAMENT
============================================================ */
router.delete("/tournament/:id", async (req, res) => {
  await Tournament.findByIdAndDelete(req.params.id);
  await TournamentParticipant.deleteMany({ tournamentId: req.params.id });
  await TournamentMatch.deleteMany({ tournamentId: req.params.id });

  res.json({ success: true });
});

export default router;
