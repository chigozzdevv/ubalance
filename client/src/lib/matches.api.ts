import { api } from "./api";
import type { match_view, match_status } from "@/types/match";

export const matches_api = {
    list(params?: {
        status?: match_status;
        market_slug?: string;
        limit?: number;
    }) {
        const search = new URLSearchParams();
        if (params?.status) search.set("status", params.status);
        if (params?.market_slug) search.set("marketSlug", params.market_slug);
        if (params?.limit) search.set("limit", params.limit.toString());

        const qs = search.toString();
        const path = qs ? `/matches?${qs}` : "/matches";
        return api.get<{ success: true; data: match_view[] }>(path);
    },

    get_by_id(match_id: string) {
        return api.get<{ success: true; data: match_view }>(`/matches/${match_id}`);
    },

    create_match(
        market_slug: string,
        buy_in_lamports: number,
        max_players: number,
        start_at_ms: number,
        end_at_ms: number,
        session_token: string,
        options?: {
            access_mode?: "public" | "private";
            join_code?: string;
        }
    ) {
        return api.post<{ success: true; data: match_view }>(
            "/matches",
            {
                marketSlug: market_slug,
                buyInLamports: buy_in_lamports,
                maxPlayers: max_players,
                startAtMs: start_at_ms,
                endAtMs: end_at_ms,
                accessMode: options?.access_mode ?? "public",
                joinCode: options?.join_code
            },
            session_token
        );
    },

    prepare_join_relay(
        match_id: string,
        session_token: string,
        options?: {
            join_code?: string;
        }
    ) {
        return api.post<{
            success: true;
            data: {
                transactionBase64: string;
                blockhash: string;
                lastValidBlockHeight: number;
                feePayer: string;
                matchPda: string;
                matchEntryPda: string;
            };
        }>(
            `/matches/${match_id}/join/relay-prepare`,
            { joinCode: options?.join_code },
            session_token
        );
    },

    confirm_join(
        match_id: string,
        tx_signature: string,
        session_token: string,
        options?: {
            join_code?: string;
        }
    ) {
        return api.post<{ success: true; data: match_view }>(
            `/matches/${match_id}/join`,
            {
                txSignature: tx_signature,
                joinCode: options?.join_code
            },
            session_token
        );
    },

    finalize_match(
        match_id: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: match_view }>(
            `/matches/${match_id}/finalize`,
            {},
            session_token
        );
    },

    cancel_match(
        match_id: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: match_view }>(
            `/matches/${match_id}/cancel`,
            {},
            session_token
        );
    },

    prepare_claim_relay(
        match_id: string,
        session_token: string
    ) {
        return api.post<{
            success: true;
            data: {
                transactionBase64: string;
                blockhash: string;
                lastValidBlockHeight: number;
                feePayer: string;
                matchPda: string;
                matchEntryPda: string;
            };
        }>(
            `/matches/${match_id}/claims/relay-prepare`,
            {},
            session_token
        );
    },

    confirm_claim(
        match_id: string,
        tx_signature: string,
        session_token: string
    ) {
        return api.post<{ success: true; data: match_view }>(
            `/matches/${match_id}/claims`,
            { txSignature: tx_signature },
            session_token
        );
    }
};
