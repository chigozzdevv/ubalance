"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import bs58 from "bs58";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { TopNav } from "@/components/layout/top-nav";

import { SwipeCard } from "@/components/game/swipe-card";
import { auth_api } from "@/lib/auth.api";
import { markets_api } from "@/lib/markets.api";
import { rounds_api } from "@/lib/rounds.api";
import { env } from "@/lib/env";
import { format_price } from "@/lib/format";
import { to_market_options } from "@/lib/markets";
import {
  create_place_prediction_instruction,
  resolve_program_id
} from "@/lib/ubalance-program";
import type { market } from "@/types/market";
import type { decision_side, round_view } from "@/types/round";

export const SingleGame = () => {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { setVisible } = useWalletModal();

  const [markets, set_markets] = useState<market[]>([]);
  const [rounds, set_rounds] = useState<round_view[]>([]);
  const [history_rounds, set_history_rounds] = useState<round_view[]>([]);

  const [selected_timeframe, set_selected_timeframe] = useState<number | null>(null);
  const [search_query, set_search_query] = useState("");
  const [amount_sol, set_amount_sol] = useState(0.1);

  const [session_token, set_session_token] = useState("");

  const [status, set_status] = useState("ready");
  const [submitting, set_submitting] = useState(false);

  const available_timeframes = useMemo(() => {
    if (markets.length === 0) return [];
    const timeframes = new Set(markets.map((m: market) => m.timeframe_minutes));
    return Array.from(timeframes).sort((a: number, b: number) => a - b);
  }, [markets]);

  const active_queue = useMemo(() => {
    let filtered_markets = markets;
    if (selected_timeframe !== null) {
      filtered_markets = markets.filter((m: market) => m.timeframe_minutes === selected_timeframe);
    }
    const valid_slugs = new Set(filtered_markets.map((m: market) => m.slug));
    return rounds.filter((r: round_view) => valid_slugs.has(r.market.slug));
  }, [rounds, markets, selected_timeframe]);

  const active_round = active_queue.length > 0 ? active_queue[0] : null;

  const selected_history = useMemo(() => {
    let filtered_markets = markets;
    if (selected_timeframe !== null) {
      filtered_markets = markets.filter((m: market) => m.timeframe_minutes === selected_timeframe);
    }
    const valid_slugs = new Set(filtered_markets.map((m: market) => m.slug));
    return history_rounds.filter((r: round_view) => valid_slugs.has(r.market.slug));
  }, [history_rounds, markets, selected_timeframe]);

  const load_data = useCallback(async () => {
    const [markets_response, rounds_response, history_response] = await Promise.all([
      markets_api.list(),
      rounds_api.list_active(),
      rounds_api.list_history(8)
    ]);

    set_markets(markets_response.data);
    set_rounds(rounds_response.data);
    set_history_rounds(history_response.data);
  }, []);

  useEffect(() => {
    load_data().catch((error: Error) => set_status(error.message));

    const interval = window.setInterval(() => {
      load_data().catch(() => undefined);
    }, 7_500);

    return () => window.clearInterval(interval);
  }, [load_data]);

  const authenticate = useCallback(async (): Promise<string | null> => {
    if (!wallet.publicKey || !wallet.signMessage) {
      set_status("wallet must support sign-message");
      return null;
    }

    try {
      const wallet_address = wallet.publicKey.toBase58();
      const challenge = await auth_api.request_challenge(wallet_address);
      const message_bytes = new TextEncoder().encode(challenge.data.message);
      const signature = await wallet.signMessage(message_bytes);
      const verification = await auth_api.verify_challenge(wallet_address, bs58.encode(signature));

      set_session_token(verification.data.token);
      set_status("session active on er endpoint");

      return verification.data.token;
    } catch (error: any) {
      set_status(error.message || "authentication failed");
      return null;
    }
  }, [wallet]);

  const ensure_wallet_and_auth = useCallback(async (): Promise<string | null> => {
    if (!wallet.connected) {
      if (!wallet.wallet) {
        setVisible(true);
        set_status("select and connect a wallet to continue");
        return null;
      }

      set_status("connect wallet to continue");
      try {
        await wallet.connect();
      } catch {
        set_status("wallet connection was canceled");
        return null;
      }
    }

    if (!wallet.publicKey) {
      set_status("wallet not connected");
      return null;
    }

    if (session_token) {
      return session_token;
    }

    return authenticate();
  }, [wallet, session_token, authenticate, setVisible]);

  const submit_decision = useCallback(
    async (side: decision_side) => {
      if (!active_round) {
        set_status("no active round");
        return;
      }

      set_submitting(true);
      try {
        const token = await ensure_wallet_and_auth();
        if (!token || !wallet.publicKey || !wallet.sendTransaction) {
          return;
        }

        const base_amount_lamports = Math.max(0, Math.round(amount_sol * 1_000_000_000));
        const amount_lamports = side === "skip" ? 0 : base_amount_lamports;

        if (side !== "skip" && amount_lamports <= 0) {
          set_status("amount must be greater than zero for yes/no");
          return;
        }

        const program_id = resolve_program_id(env.ubalanceProgramId);
        const market_pda = new PublicKey(active_round.marketPda);
        const round_pda = new PublicKey(active_round.roundPda);

        const place_prediction_ix = create_place_prediction_instruction({
          program_id,
          user: wallet.publicKey,
          market_pda,
          round_pda,
          side,
          amount_lamports
        });

        const transaction = new Transaction().add(place_prediction_ix);
        const tx_signature = await wallet.sendTransaction(transaction, connection, {
          preflightCommitment: "confirmed"
        });

        const latest = await connection.getLatestBlockhash("confirmed");
        await connection.confirmTransaction(
          {
            signature: tx_signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight
          },
          "confirmed"
        );

        await rounds_api.submit_action(active_round.id, side, amount_lamports, token, tx_signature);
        set_status(`submitted ${side} (${tx_signature.slice(0, 8)}...)`);
        await load_data();
      } catch (error: any) {
        set_status(error.message || "submit failed");
      } finally {
        set_submitting(false);
      }
    },
    [active_round, amount_sol, connection, ensure_wallet_and_auth, load_data, wallet]
  );

  useEffect(() => {
    const on_key_down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (target?.isContentEditable) {
        return;
      }

      if (!active_round || submitting) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        void submit_decision("no");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void submit_decision("yes");
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        void submit_decision("skip");
      }
    };

    window.addEventListener("keydown", on_key_down);
    return () => window.removeEventListener("keydown", on_key_down);
  }, [active_round, submitting, submit_decision]);

  return (
    <div className="min-h-screen bg-[#0b0f0e] text-[#e7efe9] pb-10 selection:bg-[#b9f6c9] selection:text-[#0a1611]">
      <TopNav
        timeframes={available_timeframes}
        selected_timeframe={selected_timeframe}
        on_select_timeframe={set_selected_timeframe}
        history={selected_history}
        amount_sol={amount_sol}
        on_amount_change={set_amount_sol}
      />

      <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 pt-10 md:px-6 relative z-10">
        <section className="flex flex-col gap-6 w-full">
          <div className="flex flex-wrap items-center gap-3">
          </div>

          {active_round ? (
            <>
              <div className="text-center text-xs font-bold uppercase tracking-widest text-[#9eaba4] mb-2">
                round 1 of {active_queue.length}
              </div>
              <SwipeCard round={active_round} amount_sol={amount_sol} on_decision={submit_decision} disabled={submitting} />

              <div className="grid grid-cols-3 gap-4 mx-auto w-full max-w-[360px]">
                <button
                  type="button"
                  className="flex h-16 w-full items-center justify-center rounded-2xl border-2 border-red-500/20 bg-[#111513] backdrop-blur-sm text-red-500 hover:border-red-500 hover:bg-red-500/10 hover:shadow-[0_0_15px_rgba(239,68,68,0.2)] hover:-translate-y-1 transition-all duration-300 disabled:opacity-50 disabled:pointer-events-none active:scale-95 group"
                  onClick={() => void submit_decision("no")}
                  disabled={submitting}
                >
                  <span className="text-2xl group-hover:scale-125 transition-transform duration-300 font-black">✕</span>
                </button>
                <button
                  type="button"
                  className="flex h-16 w-full items-center justify-center rounded-2xl border-2 border-[#9eaba4]/20 bg-[#111513] backdrop-blur-sm text-[#9eaba4] hover:border-[#9eaba4]/50 hover:bg-[#171b19] hover:-translate-y-1 transition-all duration-300 disabled:opacity-50 disabled:pointer-events-none active:scale-95 group"
                  onClick={() => void submit_decision("skip")}
                  disabled={submitting}
                >
                  <span className="text-xl font-black uppercase tracking-widest text-[10px] group-hover:scale-110 transition-transform duration-300">skip</span>
                </button>
                <button
                  type="button"
                  className="flex h-16 w-full items-center justify-center rounded-2xl border-2 border-[#b9f6c9]/20 bg-[#111513] backdrop-blur-sm text-[#89eeb0] hover:border-[#89eeb0] hover:bg-[#b9f6c9]/10 hover:shadow-[0_0_15px_rgba(185,246,201,0.2)] hover:-translate-y-1 transition-all duration-300 disabled:opacity-50 disabled:pointer-events-none active:scale-95 group"
                  onClick={() => void submit_decision("yes")}
                  disabled={submitting}
                >
                  <span className="text-2xl group-hover:scale-125 transition-transform duration-300 mt-1">❤️</span>
                </button>
              </div>

            </>
          ) : (
            <div className="grid min-h-[420px] w-full max-w-[360px] mx-auto place-items-center rounded-[2rem] border border-dashed border-[#1e2422] bg-[#111513] text-[#9eaba4] font-medium tracking-wide text-center px-6">
              <p>no active rounds matching your timeframe</p>
            </div>
          )}
        </section>
      </main>

      <footer className="mx-auto mt-8 w-full max-w-md px-4 text-xs font-mono text-[#9eaba4]/60 text-center md:px-6">{status}</footer>
    </div>
  );
};
