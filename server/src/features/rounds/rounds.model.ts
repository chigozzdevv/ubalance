import type { market } from "@/features/markets/markets.model";

export type decision_side = "yes" | "no" | "skip";

export type round_status = "predicting" | "locked" | "resolved";

export type round_action = {
  wallet: string;
  side: decision_side;
  amount_lamports: number;
  updated_at_ms: number;
};

export type round_record = {
  id: string;
  market: market;
  market_pda: string;
  round_number: number;
  round_pda: string;
  status: round_status;
  reference_price: number;
  settlement_price: number | null;
  winning_side: decision_side | null;
  open_at_ms: number;
  close_at_ms: number;
  locked_at_ms: number | null;
  resolve_at_ms: number | null;
  open_tx_signature: string | null;
  lock_tx_signature: string | null;
  resolve_tx_signature: string | null;
  actions_by_wallet: Map<string, round_action>;
};

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
