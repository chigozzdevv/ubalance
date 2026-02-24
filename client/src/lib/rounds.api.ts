import { api } from "@/lib/api";
import type { decision_side, round_view } from "@/types/round";

export const rounds_api = {
  list_active() {
    return api.get<{ success: true; data: round_view[] }>("/rounds/active");
  },

  list_history(limit = 20) {
    return api.get<{ success: true; data: round_view[] }>(`/rounds/history?limit=${limit}`);
  },

  prepare_relay_action(
    round_id: string,
    side: decision_side,
    amount_lamports: number,
    session_token: string
  ) {
    return api.post<{
      success: true;
      data: {
        transactionBase64: string;
        blockhash: string;
        lastValidBlockHeight: number;
        feePayer: string;
        amountLamports: number;
      };
    }>(
      `/rounds/${round_id}/actions/relay-prepare`,
      { side, amountLamports: amount_lamports },
      session_token
    );
  },

  prepare_relay_claim(round_id: string, session_token: string) {
    return api.post<{
      success: true;
      data: {
        transactionBase64: string;
        blockhash: string;
        lastValidBlockHeight: number;
        feePayer: string;
      };
    }>(
      `/rounds/${round_id}/claims/relay-prepare`,
      {},
      session_token
    );
  },

  submit_action(
    round_id: string,
    side: decision_side,
    amount_lamports: number,
    session_token: string,
    tx_signature: string | null
  ) {
    return api.post<{
      success: true;
      data: {
        action: {
          wallet: string;
          side: decision_side;
          amount_lamports: number;
          updated_at_ms: number;
        };
        round: round_view;
      };
    }>(
      `/rounds/${round_id}/actions`,
      { side, amountLamports: amount_lamports, txSignature: tx_signature },
      session_token
    );
  }
};
