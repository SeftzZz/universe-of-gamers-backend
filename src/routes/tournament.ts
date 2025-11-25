import express from "express";
import mongoose from "mongoose";
import { TournamentPack } from "../models/TournamentPack";
import { Tournament } from "../models/Tournament";
import { TournamentParticipant } from "../models/TournamentParticipant";
import { TournamentMatch } from "../models/TournamentMatch";

const router = express.Router();

function getPhaseName(count: number) {
  switch (count) {
    case 32: return "round32";
    case 16: return "round16";
    case 8:  return "quarter";
    case 4:  return "semi";
    case 2:  return "final";
    case 1:  return "completed";
    default: return "unknown";
  }
}

/* ============================================================
   🧩 1. CREATE TOURNAMENT PACK
============================================================ */
router.post("/tournament/create-pack", async (req, res) => {
  try {
    const {
      name,
      description,
      image,
      priceUOG = 0,
      priceSOL = 0,
      priceUSD = 0,
      maxParticipants = 8,
      rewards,
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    /* ============================================================
       🧩 AUTO-GENERATE REWARDS IF EMPTY
    ============================================================= */
    let finalRewards = rewards;

    if (!rewards || rewards.length === 0) {
      finalRewards = [
        {
          rank: 1,
          percent: 70,
          rewardUOG: Math.round(priceUOG * 0.7),
          rewardSOL: Number((priceSOL * 0.7).toFixed(6)),
          rewardUSD: Number((priceUSD * 0.7).toFixed(2)),
          description: "Champion reward",
        },
        {
          rank: 2,
          percent: 20,
          rewardUOG: Math.round(priceUOG * 0.2),
          rewardSOL: Number((priceSOL * 0.2).toFixed(6)),
          rewardUSD: Number((priceUSD * 0.2).toFixed(2)),
          description: "Runner-up reward",
        },
        {
          rank: 3,
          percent: 10,
          rewardUOG: Math.round(priceUOG * 0.1),
          rewardSOL: Number((priceSOL * 0.1).toFixed(6)),
          rewardUSD: Number((priceUSD * 0.1).toFixed(2)),
          description: "3rd place reward",
        }
      ];
    } else {
      /* ============================================================
         🧩 SANITIZE MANUAL REWARDS (pastikan field wajib ada)
      ============================================================= */
      finalRewards = rewards.map((r: any) => ({
        rank: r.rank,
        percent: r.percent ?? null,
        rewardUOG: r.rewardUOG ?? 0,
        rewardSOL: r.rewardSOL ?? 0,
        rewardUSD: r.rewardUSD ?? 0,
        description: r.description ?? "",
      }));
    }

    /* ============================================================
       🧩 SAVE PACK
    ============================================================= */
    const pack = await TournamentPack.create({
      name,
      description,
      image,
      priceUOG,
      priceSOL,
      priceUSD,
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
   🧩 2. CREATE TOURNAMENT
============================================================ */
router.post("/tournament/create", async (req, res) => {
  try {
    const { name, packId, paymentSymbol, rarity } = req.body;

    if (!name)
      return res.status(400).json({ error: "Name is required" });

    if (!packId)
      return res.status(400).json({ error: "PackId is required" });

    if (!paymentSymbol || !["USD", "UOG", "SOL"].includes(paymentSymbol))
      return res.status(400).json({ error: "Invalid paymentSymbol (USD | UOG | SOL)" });

    if (!rarity || !["common", "rare", "epic", "legendary"].includes(rarity))
      return res.status(400).json({ error: "Invalid rarity" });

    // Validate pack
    const pack = await TournamentPack.findById(packId);
    if (!pack)
      return res.status(404).json({ error: "Pack not found" });

    // Create tournament
    const tournament = await Tournament.create({
      name,
      pack: packId,
      paymentSymbol,
      rarity,
      currentPhase: "quarter",
    });

    res.json({
      success: true,
      tournament,
    });

  } catch (err: any) {
    console.error("❌ Create Tournament Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 3. GET ALL TOURNAMENT PACKS
============================================================ */
router.get("/tournament/packs", async (req, res) => {
  const packs = await TournamentPack.find().sort({ createdAt: -1 });
  res.json({ success: true, data: packs });
});

/* ============================================================
   🧩 4. GET ALL TOURNAMENTS
============================================================ */
router.get("/tournament", async (_req, res) => {
  const tournaments = await Tournament.find().populate("pack");
  res.json({ success: true, data: tournaments });
});

/* ============================================================
   🧩 4b. GET ACTIVE TOURNAMENT (THE LATEST RUNNING ONE)
============================================================ */
router.get("/tournament/active", async (req, res) => {
  try {
    const active = await Tournament.find({
      currentPhase: { $in: ["quarter", "semi", "final"] }
    })
      .populate("pack")
      .sort({ createdAt: -1 });

    return res.json({
      success: true,
      data: active
    });

  } catch (err: any) {
    console.error("❌ Error fetching active tournaments:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 5. GET TOURNAMENT DETAIL
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

    res.json({ success: true, tournament: t, participants, matches });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 5b. GET TOURNAMENT STATUS JOIN
============================================================ */
router.get("/tournament/:id/status", async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id).populate("pack");
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    const totalParticipants = await TournamentParticipant.countDocuments({
      tournamentId: t._id,
    });

    res.json({
      success: true,
      data: {
        tournament: t,
        filled: totalParticipants >= (t.pack as any).maxParticipants,
        count: totalParticipants,
        max: (t.pack as any).maxParticipants
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 6. JOIN TOURNAMENT
============================================================ */
router.post("/tournament/:id/join", async (req, res) => {
  try {
    const { walletAddress, teamId } = req.body;

    const tournament = await Tournament.findById(req.params.id)
      .populate("pack");

    if (!tournament) return res.status(404).json({ error: "Tournament not found" });

    const count = await TournamentParticipant.countDocuments({
      tournamentId: tournament._id,
    });

    // fix: cast pack after populate
    const pack: any = tournament.pack;

    if (count >= pack.maxParticipants)
      return res.status(400).json({ error: "Tournament is full" });

    const exists = await TournamentParticipant.findOne({
      tournamentId: tournament._id,
      walletAddress,
    });

    if (exists) return res.status(400).json({ error: "Already joined" });

    if (tournament.currentPhase !== "quarter") {
      return res.status(400).json({ error: "Join is closed" });
    }

    const participant = await TournamentParticipant.create({
      tournamentId: tournament._id,
      walletAddress,
      team: teamId,
    });

    res.json({ success: true, participant });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 7. GENERATE START MATCHES (with 1-minute spacing)
============================================================ */
router.post("/tournament/:id/generate-phase", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const t = await Tournament.findById(req.params.id).populate("pack").session(session);
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    const pack: any = t.pack;
    const max = pack.maxParticipants;

    const initialPhase = getPhaseName(max);
    if (initialPhase === "unknown")
      return res.status(400).json({ error: "Invalid participants size" });

    const participants = await TournamentParticipant.find({
      tournamentId: t._id,
      eliminated: false,
    }).session(session);

    if (participants.length !== max)
      return res.status(400).json({ error: `Need ${max} participants` });

    const shuffled = [...participants].sort(() => Math.random() - 0.5);

    const matches = [];
    const startTime = new Date();

    for (let i = 0; i < max; i += 2) {
      const p1 = shuffled[i];
      const p2 = shuffled[i + 1];

      const matchTime = new Date(startTime.getTime() + (i/2) * 60 * 1000);

      const m = await TournamentMatch.create(
        [{
          tournamentId: t._id,
          phase: initialPhase,
          player1: p1.walletAddress,
          player2: p2.walletAddress,
          team1: p1.team,
          team2: p2.team,
          matchTime,
          completed: false,
        }],
        { session }
      );

      matches.push(m[0]);
    }

    t.currentPhase = initialPhase;
    await t.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({ success: true, phase: initialPhase, matches });

  } catch (err: any) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 8. RECORD MATCH RESULT
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
   🧩 9. NEXT PHASE
============================================================ */
router.post("/tournament/:id/next-phase", async (req, res) => {
  try {
    const t = await Tournament.findById(req.params.id);
    if (!t) return res.status(404).json({ error: "Tournament not found" });

    const currentPhase = t.currentPhase;

    const matches = await TournamentMatch.find({
      tournamentId: t._id,
      phase: currentPhase
    }).sort({ matchTime: 1 });

    if (matches.length === 0)
      return res.status(400).json({ error: "Matches not found for phase" });

    // Semua match harus selesai
    for (const m of matches) {
      if (!m.completed)
        return res.status(400).json({ error: `${currentPhase} not finished` });
    }

    // Ambil winners
    const winners = matches.map(m => ({
      walletAddress: m.winner,
      team: m.player1 === m.winner ? m.team1 : m.team2
    }));

    const nextCount = winners.length;
    const nextPhase = getPhaseName(nextCount);

    // Tournament selesai
    if (nextPhase === "completed") {
      t.winner = winners[0].walletAddress;
      t.currentPhase = "completed";
      await t.save();

      return res.json({
        success: true,
        tournamentWinner: winners[0].walletAddress
      });
    }

    if (nextPhase === "unknown")
      return res.status(400).json({ error: "Invalid next phase size" });

    // ============================
    // FIX: lastMatchTime undefined
    // ============================
    const lastMatch = matches[matches.length - 1];

    if (!lastMatch || !lastMatch.matchTime) {
      return res.status(500).json({ error: "Missing matchTime for previous phase" });
    }

    const lastMatchTime = lastMatch.matchTime;
    const nextStart = new Date(lastMatchTime.getTime() + 5 * 60 * 1000);

    // Generate next matches
    const nextMatches = [];

    for (let i = 0; i < winners.length; i += 2) {
      const p1 = winners[i];
      const p2 = winners[i + 1];

      const matchTime = new Date(nextStart.getTime() + (i / 2) * 60 * 1000);

      const m = await TournamentMatch.create({
        tournamentId: t._id,
        phase: nextPhase,
        player1: p1.walletAddress,
        player2: p2.walletAddress,
        team1: p1.team,
        team2: p2.team,
        matchTime,
        completed: false
      });

      nextMatches.push(m);
    }

    t.currentPhase = nextPhase;
    await t.save();

    res.json({ success: true, phase: nextPhase, matches: nextMatches });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   🧩 10. DELETE TOURNAMENT
============================================================ */
router.delete("/tournament/:id", async (req, res) => {
  await Tournament.findByIdAndDelete(req.params.id);
  await TournamentParticipant.deleteMany({ tournamentId: req.params.id });
  await TournamentMatch.deleteMany({ tournamentId: req.params.id });

  res.json({ success: true });
});

router.get("/tournament/:id/participant/:wallet", async (req, res) => {
  try {
    const { id, wallet } = req.params;

    const exists = await TournamentParticipant.findOne({
      tournamentId: id,
      walletAddress: wallet,
    });

    return res.json({
      joined: !!exists,
      participant: exists || null,
    });
  } catch (err) {
    console.error("❌ Check participant error:", err);
    res.status(500).json({ error: "Failed checking participant" });
  }
});

export default router;
