"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import bs58 from "bs58";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { TopNav } from "@/components/layout/top-nav";
import { AmountInput } from "@/components/game/amount-input";
import { SwipeCard } from "@/components/game/swipe-card";
import { auth_api } from "@/lib/auth.api";
import { markets_api } from "@/lib/markets.api";
import { rounds_api } from "@/lib/rounds.api";
import { env } from "@/lib/env";
import { format_price } from "@/lib/format";
import { to_market_options } from "@/lib/markets";
import {
  create_place_prediction_instruction,
  derive_position_pda,
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

  const [selected_market_slug, set_selected_market_slug] = useState<string | null>(null);
  const [search_query, set_search_query] = useState("");
  const [amount_sol, set_amount_sol] = useState(0.1);

  const [session_token, set_session_token] = useState("");

  const [status, set_status] = useState("ready");
  const [submitting, set_submitting] = useState(false);

  const visible_markets = useMemo(() => to_market_options(markets, search_query), [markets, search_query]);

  useEffect(() => {
    if (visible_markets.length === 0) {
      return;
    }

    if (!selected_market_slug || !visible_markets.some((market_item) => market_item.slug === selected_market_slug)) {
      set_selected_market_slug(visible_markets[0].slug);
    }
  }, [visible_markets, selected_market_slug]);

  const active_round = useMemo(() => {
    if (!selected_market_slug) {
      return null;
    }

    return rounds.find((round) => round.market.slug === selected_market_slug) ?? null;
  }, [rounds, selected_market_slug]);

  const selected_history = useMemo(() => {
    if (!selected_market_slug) {
      return history_rounds;
    }
    return history_rounds.filter((round) => round.market.slug === selected_market_slug);
  }, [history_rounds, selected_market_slug]);

  const load_data = useCallback(async () => {
    const [markets_response, rounds_response, history_response] = await Promise.all([
      markets_api.list(),
      rounds_api.list_active(),
      rounds_api.list_history(8)
    ]);

    set_markets(markets_response.data);
    set_rounds(rounds_response.data);
    set_history_rounds(history_response.data);

    if (!selected_market_slug && markets_response.data.length > 0) {
      set_selected_market_slug(markets_response.data[0].slug);
    }
  }, [selected_market_slug]);

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
        const position_pda = derive_position_pda(program_id, round_pda, wallet.publicKey);

        const place_prediction_ix = create_place_prediction_instruction({
          program_id,
          user: wallet.publicKey,
          market_pda,
          round_pda,
          position_pda,
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
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_10%,#dbeafe_0%,#f8fafc_40%,#fef3c7_100%)] pb-10">
      <TopNav
        markets={visible_markets.length > 0 ? visible_markets : markets}
        selected_market_slug={selected_market_slug}
        on_select_market_slug={set_selected_market_slug}
        search_query={search_query}
        on_search_query={set_search_query}
      />

      <main className="mx-auto grid w-full max-w-6xl gap-6 px-4 pt-6 md:grid-cols-[1.2fr,0.8fr] md:px-6">
        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${session_token ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"}`}>
              {session_token ? "session ready" : "not authenticated"}
            </span>
            <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-sky-800">
              public er endpoint
            </span>
          </div>

          <AmountInput amount_sol={amount_sol} on_change={set_amount_sol} />

          {active_round ? (
            <>
              <SwipeCard round={active_round} amount_sol={amount_sol} on_decision={submit_decision} disabled={submitting} />

              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  className="h-11 rounded-xl border border-rose-200 bg-rose-50 text-sm font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                  onClick={() => void submit_decision("no")}
                  disabled={submitting}
                >
                  no
                </button>
                <button
                  type="button"
                  className="h-11 rounded-xl border border-amber-200 bg-amber-50 text-sm font-semibold text-amber-700 transition hover:bg-amber-100 disabled:opacity-50"
                  onClick={() => void submit_decision("skip")}
                  disabled={submitting}
                >
                  skip
                </button>
                <button
                  type="button"
                  className="h-11 rounded-xl border border-emerald-200 bg-emerald-50 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                  onClick={() => void submit_decision("yes")}
                  disabled={submitting}
                >
                  yes
                </button>
              </div>

              <p className="text-xs font-medium text-slate-500">desktop shortcuts: ← no, → yes, ↓ skip</p>
            </>
          ) : (
            <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white text-slate-500">
              no active round for this market
            </div>
          )}
        </section>

        <aside className="grid gap-3 self-start">
          <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-slate-700">recent rounds</h2>

          {selected_history.length > 0 ? (
            <div className="grid gap-2">
              {selected_history.map((round_item) => (
                <article key={round_item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-slate-900">{round_item.market.display_name}</p>
                      <p className="text-xs text-slate-500">round #{round_item.roundNumber}</p>
                    </div>
                    <span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                      {round_item.status}
                    </span>
                  </div>

                  <div className="mt-3 grid gap-1 text-xs text-slate-600">
                    <p>ref: ${format_price(round_item.referencePrice)}</p>
                    <p>
                      settle:{" "}
                      {round_item.settlementPrice === null
                        ? "pending"
                        : `$${format_price(round_item.settlementPrice)}`}
                    </p>
                    <p>winner: {round_item.winningSide ?? "pending"}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
              no round history for this market yet
            </div>
          )}
        </aside>
      </main>

      <footer className="mx-auto mt-6 w-full max-w-6xl px-4 text-sm text-slate-600 md:px-6">{status}</footer>
    </div>
  );
};
