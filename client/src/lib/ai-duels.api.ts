import { api } from "./api";
import type { ai_duel_view, ai_duel_status, ai_duel_turn_view } from "../types/ai-duel";
import type { decision_side } from "@/types/round";

export const ai_duels_api = {
    list(params?: {
        status?: ai_duel_status;
        market_slug?: string;
        limit?: number;
        mine?: boolean;
    }) {
        const search = new URLSearchParams();
        if (params?.status) search.set("status", params.status);
        if (params?.market_slug) search.set("marketSlug", params.market_slug);
        if (params?.limit) search.set("limit", params.limit.toString());
        if (params?.mine) search.set("mine", "true");

        const qs = search.toString();
        const path = qs ? `/ai-duels?${qs}` : "/ai-duels";
        return api.get<{ success: true; data: ai_duel_view[] }>(path);
    },

    get_by_id(duel_record_id: string) {
        return api.get<{ success: true; data: ai_duel_view }>(`/ai-duels/${duel_record_id}`);
    },

    prepare_open_relay(
        round_id: string,
        player_side: decision_side,
        amount_lamports: number,
        session_token: string
    ) {
        return api.post<{
            success: true;
            data: {
                duelRecordId: string;
                transactionBase64: string;
                blockhash: string;
                lastValidBlockHeight: number;
                feePayer: string;
                marketPda: string;
                roundPda: string;
                houseBankrollPda: string;
                aiDuelPda: string;
            };
        }>(
            "/ai-duels/open/relay-prepare",
            { roundId: round_id, playerSide: player_side, amountLamports: amount_lamports },
            session_token
        );
    },

    confirm_open(
        duel_record_id: string,
        tx_signature: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: ai_duel_view }>(
            `/ai-duels/${duel_record_id}/open`,
            { txSignature: tx_signature },
            session_token
        );
    },

    prepare_append_turn_relay(
        duel_record_id: string,
        player_side: decision_side,
        amount_lamports: number,
        session_token: string
    ) {
        return api.post<{
            success: true;
            data: {
                turnIndex: number;
                transactionBase64: string;
                blockhash: string;
                lastValidBlockHeight: number;
                feePayer: string;
                marketPda: string;
                roundPda: string;
                houseBankrollPda: string;
                aiDuelPda: string;
            };
        }>(
            `/ai-duels/${duel_record_id}/turns/relay-prepare`,
            { playerSide: player_side, amountLamports: amount_lamports },
            session_token
        );
    },

    confirm_append_turn(
        duel_record_id: string,
        tx_signature: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: ai_duel_view }>(
            `/ai-duels/${duel_record_id}/turns`,
            { txSignature: tx_signature },
            session_token
        );
    },

    reveal_and_settle(
        duel_record_id: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: ai_duel_view }>(
            `/ai-duels/${duel_record_id}/reveal-settle`,
            {},
            session_token
        );
    },

    prepare_claim_relay(
        duel_record_id: string,
        session_token: string
    ) {
        return api.post<{
            success: true;
            data: {
                transactionBase64: string;
                blockhash: string;
                lastValidBlockHeight: number;
                feePayer: string;
                aiDuelPda: string;
            };
        }>(
            `/ai-duels/${duel_record_id}/claims/relay-prepare`,
            {},
            session_token
        );
    },

    confirm_claim(
        duel_record_id: string,
        tx_signature: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: ai_duel_view }>(
            `/ai-duels/${duel_record_id}/claims`,
            { txSignature: tx_signature },
            session_token
        );
    }
};
