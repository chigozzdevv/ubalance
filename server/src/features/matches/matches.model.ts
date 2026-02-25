import type { market } from "@/features/markets/markets.model";

export type match_status = "open" | "locked" | "resolved" | "cancelled";
export type match_access_mode = "public" | "private";

export type match_entry_view = {
  wallet: string;
  matchEntryPda: string;
  buyInLamports: number;
  joined: boolean;
  score: number | null;
  isWinner: boolean | null;
  resultRecorded: boolean;
  claimed: boolean;
  joinedAtMs: number;
  claimedAtMs: number | null;
};

export type match_view = {
  id: string;
  createdByWallet: string | null;
  accessMode: match_access_mode;
  requiresJoinCode: boolean;
  market: market;
  marketPda: string;
  matchId: number;
  matchPda: string;
  buyInLamports: number;
  maxPlayers: number;
  playerCount: number;
  potLamports: number;
  winnerCount: number;
  highestScore: number;
  startAtMs: number;
  endAtMs: number;
  status: match_status;
  createTxSignature: string | null;
  lockTxSignature: string | null;
  finalizeTxSignature: string | null;
  cancelTxSignature: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  entries: match_entry_view[];
};
