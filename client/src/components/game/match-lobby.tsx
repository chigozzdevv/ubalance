"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { auth_api } from "@/lib/auth.api";
import { matches_api } from "@/lib/matches.api";
import { rounds_api } from "@/lib/rounds.api";
import { format_sol } from "@/lib/format";
import { SwipeCard } from "@/components/game/swipe-card";
import type { market } from "@/types/market";
import type { round_view, decision_side } from "@/types/round";
import type { match_view } from "@/types/match";

const decode_base64 = (value: string): Uint8Array => {
    const raw = atob(value);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) {
        bytes[index] = raw.charCodeAt(index);
    }
    return bytes;
};

const get_relative_time = (target_ms: number): string => {
    const diff = target_ms - Date.now();
    if (diff <= 0) return "ended";
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    return `in ${Math.floor(hours / 24)}d`;
};

type match_lobby_props = {
    markets: market[];
    rounds: round_view[];
    selected_timeframe: number | null;
    amount_sol: number;
};

export const MatchLobby = ({
    markets,
    rounds,
    selected_timeframe,
    amount_sol
}: match_lobby_props) => {
    const wallet = useWallet();
    const { connection } = useConnection();
    const { setVisible } = useWalletModal();

    const [session_token, set_session_token] = useState("");
    const [matches, set_matches] = useState<match_view[]>([]);
    const [active_match, set_active_match] = useState<match_view | null>(null);
    const [status, set_status] = useState("ready");
    const [submitting, set_submitting] = useState(false);
    const [skipped_round_ids, set_skipped_round_ids] = useState<Set<string>>(new Set());

    const active_queue = active_match
        ? rounds
            .filter(r => !skipped_round_ids.has(r.id))
            .filter(r => r.status === "predicting")
            .filter(r => r.market.timeframe_minutes === active_match.market.timeframe_minutes)
        : [];

    const active_round = active_queue[0] || null;

    const load_matches = useCallback(async () => {
        try {
            set_status("fetching matches...");
            const res = await matches_api.list({ status: "open" });

            let filtered = res.data;
            if (selected_timeframe !== null) {
                filtered = filtered.filter(m => m.market.timeframe_minutes === selected_timeframe);
            }

            set_matches(filtered);

            // Auto-reconnect to a match if already joined
            if (wallet.publicKey) {
                const wallet_addr = wallet.publicKey.toBase58();
                const joined = filtered.find(m => m.entries.some(e => e.wallet === wallet_addr));
                if (joined) set_active_match(joined);
            }

            set_status("");
        } catch (error: any) {
            set_status(error.message || "failed to load matches");
        }
    }, [selected_timeframe, wallet.publicKey]);

    useEffect(() => {
        void load_matches();
    }, [load_matches]);

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

    const join_match = async (match: match_view) => {
        set_submitting(true);
        try {
            const token = await ensure_wallet_and_auth();
            if (!token || !wallet.publicKey || !wallet.signTransaction) return;

            let tx_signature: string | null = null;
            let last_error: unknown = null;
            const relay_max_attempts = 2;

            for (let attempt = 1; attempt <= relay_max_attempts; attempt += 1) {
                try {
                    set_status("preparing join tx...");
                    const prepared = await matches_api.prepare_join_relay(match.id, token);

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

            if (!tx_signature) {
                throw (last_error instanceof Error ? last_error : new Error("failed to relay join transaction"));
            }

            set_status("syncing with server...");
            const updated_match = await matches_api.confirm_join(match.id, tx_signature, token);

            set_active_match(updated_match.data);
            set_status("joined match!");
            await load_matches();
        } catch (error: any) {
            set_status(error.message || "join match failed");
        } finally {
            set_submitting(false);
        }
    };

    const submit_decision = async (side: decision_side): Promise<boolean> => {
        if (!active_round) {
            set_status("no active round for match");
            return false;
        }

        if (side === "skip") {
            set_skipped_round_ids(prev => new Set(prev).add(active_round.id));
            set_status("skipped round");
            return true;
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
            const relay_max_attempts = 2;

            for (let attempt = 1; attempt <= relay_max_attempts; attempt += 1) {
                try {
                    set_status("preparing match vote tx...");
                    const prepared = await rounds_api.prepare_relay_action(active_round.id, side, amount_lamports, token);

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

            if (!tx_signature) {
                throw (last_error instanceof Error ? last_error : new Error("failed to relay match vote transaction"));
            }

            set_status(`tx confirmed (${tx_signature.slice(0, 8)}...)`);
            await rounds_api.submit_action(active_round.id, side, amount_lamports, token, tx_signature);

            set_status("turn recorded!");
            return true;
        } catch (error: any) {
            set_status(error.message || "match vote failed");
            return false;
        } finally {
            set_submitting(false);
        }
    };

    return (
        <div className="flex flex-col gap-6 w-full items-center">
            <div className="text-center text-xs font-bold uppercase tracking-widest text-[#9eaba4] mb-2 flex flex-col gap-1 items-center">
                <span>PvP Match Lobby</span>
                {active_match && (
                    <span className="text-[10px] text-[#89eeb0] bg-[#89eeb0]/10 px-2 py-0.5 rounded-full border border-[#89eeb0]/20">
                        Active Match
                    </span>
                )}
            </div>

            {!active_match && (
                <div className="w-full flex-col flex gap-4">
                    {matches.map(match => {
                        const time_left = get_relative_time(match.endAtMs);
                        return (
                            <div key={match.id} className="flex flex-col gap-3 w-full max-w-[360px] mx-auto p-5 rounded-[1.5rem] border border-[#1e2422] bg-[#111513] transition-all hover:border-[#b9f6c9]/30">
                                <div className="flex justify-between items-start w-full">
                                    <div>
                                        <div className="text-[#e7efe9] font-bold text-lg">{format_sol(match.buyInLamports)} SOL</div>
                                        <div className="text-xs text-[#9eaba4]">Buy-in</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-[#b9f6c9] font-mono text-sm">{match.playerCount} / {match.maxPlayers}</div>
                                        <div className="text-xs text-[#9eaba4]">Players</div>
                                    </div>
                                </div>

                                <div className="flex justify-between items-center w-full mt-2">
                                    <div className="text-xs text-[#9eaba4] opacity-80">
                                        Ends {time_left}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void join_match(match)}
                                        disabled={submitting || match.playerCount >= match.maxPlayers}
                                        className="px-4 py-2 rounded-xl bg-[#b9f6c9] text-[#0a1611] font-bold text-sm hover:bg-white disabled:opacity-50 transition-colors"
                                    >
                                        {match.playerCount >= match.maxPlayers ? "Full" : "Join"}
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                    {matches.length === 0 && (
                        <div className="grid min-h-[120px] w-full max-w-[360px] mx-auto place-items-center rounded-[2rem] border border-dashed border-[#1e2422] text-[#9eaba4] font-medium tracking-wide text-center px-6">
                            <p>No open matches right now.</p>
                        </div>
                    )}
                </div>
            )}

            {active_match && (
                <div className="relative w-full flex flex-col items-center">
                    {active_round ? (
                        <>
                            <div className="text-center text-xs font-bold uppercase tracking-widest text-[#9eaba4] mb-2">
                                Match #{active_match.id.slice(0, 4)}: {active_queue.length} rounds left
                            </div>
                            <SwipeCard
                                key={active_round.id}
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
                        </>
                    ) : (
                        <div className="grid min-h-[420px] w-full max-w-[360px] mx-auto place-items-center rounded-[2rem] border border-dashed border-[#b9f6c9]/30 bg-[#111513] text-[#9eaba4] font-medium tracking-wide text-center px-6">
                            <div className="flex flex-col gap-2 items-center">
                                <p className="text-lg text-[#e7efe9] font-bold">You are in a Match!</p>
                                <p className="text-xs">Waiting for new rounds in the {active_match.market.timeframe_minutes}m timeframe...</p>
                            </div>
                        </div>
                    )}
                </div>
            )}

            <p className="text-xs font-mono text-[#9eaba4]/60 text-center">{status}</p>
        </div>
    );
};
