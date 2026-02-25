"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { SwipeCard } from "./swipe-card";
import { auth_api } from "@/lib/auth.api";
import { ai_duels_api } from "@/lib/ai-duels.api";
import type { market } from "@/types/market";
import type { round_view, decision_side } from "@/types/round";
import type { ai_duel_view } from "@/types/ai-duel";

const decode_base64 = (value: string): Uint8Array => {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
};

type ai_duel_game_props = {
    markets: market[];
    rounds: round_view[];
    selected_timeframe: number | null;
    amount_sol: number;
};

export const AiDuelGame = ({
    markets,
    rounds,
    selected_timeframe,
    amount_sol
}: ai_duel_game_props) => {
    const wallet = useWallet();
    const { connection } = useConnection();
    const { setVisible } = useWalletModal();

    const [session_token, set_session_token] = useState("");
    const [active_duel, set_active_duel] = useState<ai_duel_view | null>(null);

    const [skipped_round_ids, set_skipped_round_ids] = useState<Set<string>>(new Set());
    const [status, set_status] = useState("ready");
    const [submitting, set_submitting] = useState(false);

    const active_queue = useMemo(() => {
        let filtered_markets = markets;
        if (selected_timeframe !== null) {
            filtered_markets = markets.filter((m: market) => m.timeframe_minutes === selected_timeframe);
        }
        const valid_slugs = new Set(filtered_markets.map((m: market) => m.slug));
        return rounds.filter((r: round_view) => valid_slugs.has(r.market.slug) && !skipped_round_ids.has(r.id));
    }, [rounds, markets, selected_timeframe, skipped_round_ids]);

    const active_round = active_queue.length > 0 ? active_queue[0] : null;

    const authenticate = useCallback(async () => {
        if (!wallet.publicKey || !wallet.signMessage) {
            set_status("wallet not connected");
            return null;
        }

        try {
            set_status("requesting challenge...");
            const wallet_address = wallet.publicKey.toBase58();
            const challenge_res = await auth_api.request_challenge(wallet_address);

            set_status("authenticating...");
            const message = new TextEncoder().encode(challenge_res.data.message);
            const signature_bytes = await wallet.signMessage(message);
            const signature = bs58.encode(signature_bytes);

            const verify_res = await auth_api.verify_challenge(wallet_address, signature);
            set_session_token(verify_res.data.token);
            set_status("authenticated");
            return verify_res.data.token;
        } catch (error: any) {
            set_status(error.message || "authentication failed");
            return null;
        }
    }, [wallet]);

    const ensure_wallet_and_auth = useCallback(async () => {
        if (!wallet.connected) {
            setVisible(true);
            return null;
        }
        if (!wallet.publicKey) {
            set_status("wallet not connected");
            return null;
        }
        if (session_token) return session_token;
        return authenticate();
    }, [wallet, session_token, authenticate, setVisible]);

    const is_retryable_relay_error = (error: unknown): boolean => {
        const message = error instanceof Error ? error.message : String(error ?? "");
        const normalized = message.toLowerCase();
        return (
            normalized.includes("blockhash not found") ||
            normalized.includes("transactionexpiredblockheightexceeded") ||
            normalized.includes("block height exceeded")
        );
    };

    const submit_decision = useCallback(
        async (side: decision_side): Promise<boolean> => {
            if (side === "skip") {
                set_status("skip not allowed in duels");
                return false;
            }
            if (!active_round) {
                set_status("no active round");
                return false;
            }

            set_submitting(true);
            try {
                const token = await ensure_wallet_and_auth();
                if (!token || !wallet.publicKey || !wallet.signTransaction) return false;

                const amount_lamports = Math.max(0, Math.round(amount_sol * 1_000_000_000));
                if (amount_lamports <= 0) {
                    set_status("amount must be > 0");
                    return false;
                }

                let tx_signature: string | null = null;
                let last_error: unknown = null;
                let duel_record_id = active_duel?.id;

                const relay_max_attempts = 2;
                for (let attempt = 1; attempt <= relay_max_attempts; attempt += 1) {
                    try {
                        set_status(`preparing ${!active_duel ? "opening" : "turn"} tx...`);
                        let prepared;
                        if (!active_duel) {
                            prepared = await ai_duels_api.prepare_open_relay(active_round.id, side, amount_lamports, token);
                            duel_record_id = prepared.data.duelRecordId;
                        } else {
                            prepared = await ai_duels_api.prepare_append_turn_relay(active_duel.id, side, amount_lamports, token);
                        }

                        set_status("awaiting wallet signature...");
                        const unsigned_tx = Transaction.from(decode_base64(prepared.data.transactionBase64));
                        const signed_tx = await wallet.signTransaction(unsigned_tx);

                        set_status("confirming on-chain...");
                        tx_signature = await connection.sendRawTransaction(signed_tx.serialize(), {
                            preflightCommitment: "confirmed",
                            maxRetries: 3
                        });

                        const confirmation = await connection.confirmTransaction(
                            {
                                signature: tx_signature,
                                blockhash: prepared.data.blockhash,
                                lastValidBlockHeight: prepared.data.lastValidBlockHeight
                            },
                            "confirmed"
                        );

                        if (confirmation.value.err) {
                            throw new Error(JSON.stringify(confirmation.value.err));
                        }

                        break;
                    } catch (error: unknown) {
                        last_error = error;
                        if (attempt < relay_max_attempts && is_retryable_relay_error(error)) {
                            continue;
                        }
                        throw error;
                    }
                }

                if (!tx_signature || !duel_record_id) {
                    throw (last_error instanceof Error ? last_error : new Error("failed to relay duel transaction"));
                }

                set_status("syncing with server...");
                let updated_duel;
                if (!active_duel) {
                    updated_duel = await ai_duels_api.confirm_open(duel_record_id, tx_signature, token);
                } else {
                    updated_duel = await ai_duels_api.confirm_append_turn(duel_record_id, tx_signature, token);
                }

                set_active_duel(updated_duel.data);

                // Simulating the "AI is thinking pause"
                set_status("AI is thinking...");
                await new Promise(r => setTimeout(r, 1500));
                set_status("turn recorded!");
                return true;
            } catch (error: any) {
                set_status(error.message || "duel turn failed");
                return false;
            } finally {
                set_submitting(false);
            }
        },
        [active_round, active_duel, amount_sol, connection, ensure_wallet_and_auth, wallet]
    );

    const process_reveal = useCallback(async () => {
        if (!active_duel) return;
        set_submitting(true);
        try {
            const token = await ensure_wallet_and_auth();
            if (!token) return;

            set_status("revealing ai decisions...");
            const updated_duel = await ai_duels_api.reveal_and_settle(active_duel.id, token);

            set_active_duel(updated_duel.data);
            set_status("duel revealed!");
        } catch (error: any) {
            set_status(error.message || "reveal failed");
        } finally {
            set_submitting(false);
        }
    }, [active_duel, ensure_wallet_and_auth]);

    useEffect(() => {
        if (active_duel?.status === "open" && active_duel.turns.length >= active_duel.turnCount && !submitting) {
            void process_reveal();
        }
    }, [active_duel, process_reveal, submitting]);

    return (
        <div className="flex flex-col gap-6 w-full items-center">
            <div className="text-center text-xs font-bold uppercase tracking-widest text-[#9eaba4] mb-2 flex flex-col gap-1 items-center">
                <span>PvAI Duel</span>
                <span className="text-[10px] text-[#89eeb0] bg-[#89eeb0]/10 px-2 py-0.5 rounded-full border border-[#89eeb0]/20">
                    {active_duel?.status === "revealed" ? "Complete" : `Turn ${active_duel ? (active_duel.turns.length + 1) : 1}`}
                </span>
            </div>

            {active_duel?.status === "revealed" ? (
                <div className="flex flex-col gap-4 w-full max-w-[360px] mx-auto p-6 rounded-[2rem] border border-[#1e2422] bg-[#111513] text-center">
                    <div className="text-4xl mb-2">
                        {active_duel.outcome === "player_win" ? "🏆" : active_duel.outcome === "house_win" ? "💀" : "🤝"}
                    </div>
                    <h2 className="text-xl font-bold text-[#e7efe9]">
                        {active_duel.outcome === "player_win" ? "You Win!" : active_duel.outcome === "house_win" ? "AI Wins" : "Push"}
                    </h2>
                    <div className="text-sm font-mono text-[#9eaba4] mt-4 space-y-2">
                        <p>AI Model: {active_duel.aiDecisionModel}</p>
                        <p>Confidence: {active_duel.aiDecisionConfidence?.toFixed(2)}%</p>
                        <p className="mt-2 text-xs opacity-70">"{active_duel.aiDecisionRationale}"</p>
                    </div>

                    <button
                        type="button"
                        className="mt-6 w-full h-12 rounded-xl bg-[#b9f6c9] text-[#0a1611] font-bold hover:bg-white transition-colors"
                        onClick={() => set_active_duel(null)}
                    >
                        Play Again
                    </button>
                </div>
            ) : active_round ? (
                <div className="relative w-full flex flex-col items-center">
                    <SwipeCard
                        key={`${active_round.id}-turn-${active_duel?.turns.length ?? 0}`}
                        round={active_round}
                        amount_sol={amount_sol}
                        on_decision={submit_decision}
                        disabled={submitting}
                    />

                    <div className="grid grid-cols-2 gap-4 mt-6 mx-auto w-[65%] max-w-[280px]">
                        <button
                            type="button"
                            className="flex h-14 w-full items-center justify-center rounded-2xl border-2 border-red-500/20 bg-[#111513] backdrop-blur-sm text-red-500 hover:border-red-500 hover:bg-red-500/10 hover:shadow-[0_0_15px_rgba(239,68,68,0.2)] hover:-translate-y-1 transition-all duration-300 disabled:opacity-50 disabled:pointer-events-none active:scale-95 group"
                            onClick={() => void submit_decision("no")}
                            disabled={submitting}
                        >
                            <span className="text-2xl group-hover:scale-125 transition-transform duration-300 font-black">✕</span>
                        </button>
                        <button
                            type="button"
                            className="flex h-14 w-full items-center justify-center rounded-2xl border-2 border-[#b9f6c9]/20 bg-[#111513] backdrop-blur-sm text-[#89eeb0] hover:border-[#89eeb0] hover:bg-[#b9f6c9]/10 hover:shadow-[0_0_15px_rgba(185,246,201,0.2)] hover:-translate-y-1 transition-all duration-300 disabled:opacity-50 disabled:pointer-events-none active:scale-95 group"
                            onClick={() => void submit_decision("yes")}
                            disabled={submitting}
                        >
                            <span className="text-2xl group-hover:scale-125 transition-transform duration-300 mt-1">❤️</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="grid min-h-[420px] w-full max-w-[360px] mx-auto place-items-center rounded-[2rem] border border-dashed border-[#1e2422] bg-[#111513] text-[#9eaba4] font-medium tracking-wide text-center px-6">
                    <p>no active rounds matching your timeframe</p>
                </div>
            )}

            <p className="text-xs font-mono text-[#9eaba4]/60 text-center">{status}</p>
        </div>
    );
};
