import type { market } from "@/features/markets/markets.model";
import type { decision_side } from "@/features/rounds/rounds.model";

export type ai_duel_status = "prepared" | "open" | "revealed" | "settled" | "cancelled";

export type ai_duel_outcome = "player_win" | "house_win" | "push";

export type ai_duel_view = {
  id: string;
  market: market;
  marketPda: string;
  roundId: string;
  roundNumber: number;
  roundPda: string;
  playerWallet: string;
  duelId: number;
  aiDuelPda: string;
  houseBankrollPda: string;
  playerSide: decision_side;
  aiSide: decision_side;
  aiDecisionModel: string | null;
  aiDecisionConfidence: number | null;
  aiDecisionRationale: string | null;
  amountLamports: number;
  status: ai_duel_status;
  outcome: ai_duel_outcome | null;
  playerPayoutLamports: number | null;
  openTxSignature: string | null;
  revealTxSignature: string | null;
  settleTxSignature: string | null;
  claimTxSignature: string | null;
  claimedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
};
