import mongoose, { Schema, Document } from "mongoose";

// Reward structure
export interface IReward {
  rank: number;
  rewardUOG: number;
  rewardSOL: number;
  rewardUSD: number;
  percent?: number;
  description?: string;
}

export interface ITournamentPack extends Document {
  name: string;
  description?: string;
  image?: string;

  priceUOG: number;
  priceSOL: number;
  priceUSD: number;

  maxParticipants: number;

  rewards: IReward[];

  createdAt: Date;
  updatedAt: Date;
}

const RewardSchema = new Schema<IReward>(
  {
    rank: { type: Number, required: true },
    rewardUOG: { type: Number, required: true },
    rewardSOL: { type: Number, required: true },
    rewardUSD: { type: Number, required: true },
    percent: { type: Number },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const TournamentPackSchema = new Schema<ITournamentPack>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" },

    priceUOG: { type: Number, default: 0 },
    priceSOL: { type: Number, default: 0 },
    priceUSD: { type: Number, default: 0 },

    maxParticipants: { type: Number, default: 8 },

    rewards: { type: [RewardSchema], default: [] },
  },
  { timestamps: true, collection: "tournament_packs" }
);

export const TournamentPack = mongoose.model<ITournamentPack>("TournamentPack", TournamentPackSchema);