import type { market } from "@/types/market";

export type decision_side = "yes" | "no" | "skip";

export type round_status = "predicting" | "locked" | "resolved";

export type round_view = {
  id: string;
  market: market;
  marketPda: string;
  roundNumber: number;
  roundPda: string;
  status: round_status;
  referencePrice: number;
  settlementPrice: number | null;
  winningSide: decision_side | null;
  openAtMs: number;
  closeAtMs: number;
  lockedAtMs: number | null;
  resolveAtMs: number | null;
  openTxSignature: string | null;
  lockTxSignature: string | null;
  resolveTxSignature: string | null;
  totals: {
    yesLamports: number;
    noLamports: number;
    skipCount: number;
    actionCount: number;
  };
};
