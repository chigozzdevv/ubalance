"use client";

import { motion } from "framer-motion";
import type { decision_side, round_view } from "@/types/round";
import { format_price, format_sol } from "@/lib/format";

type swipe_card_props = {
  round: round_view;
  amount_sol: number;
  on_decision: (side: decision_side) => void;
  disabled: boolean;
};

export const SwipeCard = ({ round, amount_sol, on_decision, disabled }: swipe_card_props) => {
  return (
    <motion.div
      drag={!disabled}
      dragElastic={0.2}
      onDragEnd={(_, info) => {
        if (disabled) {
          return;
        }

        if (info.offset.x > 140) {
          on_decision("yes");
          return;
        }
        if (info.offset.x < -140) {
          on_decision("no");
          return;
        }
        if (info.offset.y > 120) {
          on_decision("skip");
        }
      }}
      whileDrag={disabled ? undefined : { scale: 1.02 }}
      className="rounded-3xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 p-5 shadow-lg"
    >
      <p className="inline-flex rounded-full bg-sky-100 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-sky-700">
        crypto market
      </p>

      <h2 className="mt-3 text-2xl font-bold text-slate-900">{round.market.display_name}</h2>
      <p className="mt-1 text-sm text-slate-600">round #{round.roundNumber}</p>

      <div className="mt-4 grid gap-2 text-sm text-slate-700">
        <p>reference price: ${format_price(round.referencePrice)}</p>
        <p>timeframe: {round.market.timeframe_minutes}m</p>
        <p>your amount: {amount_sol.toFixed(2)} SOL</p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-emerald-700">yes pool</p>
          <p className="mt-1 text-lg font-bold text-emerald-900">{format_sol(round.totals.yesLamports)} SOL</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-rose-700">no pool</p>
          <p className="mt-1 text-lg font-bold text-rose-900">{format_sol(round.totals.noLamports)} SOL</p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>← no</span>
        <span>→ yes</span>
        <span>↓ skip</span>
      </div>
    </motion.div>
  );
};
