"use client";

import { useEffect } from "react";
import { motion, useMotionValue, useTransform, useAnimation } from "framer-motion";
import type { decision_side, round_view } from "@/types/round";
import { format_price, format_sol } from "@/lib/format";

type swipe_card_props = {
  round: round_view;
  amount_sol: number;
  on_decision: (side: decision_side) => void;
  disabled: boolean;
};

export const SwipeCard = ({ round, amount_sol, on_decision, disabled }: swipe_card_props) => {
  const x_mv = useMotionValue(0);
  const rotate = useTransform(x_mv, [-200, 200], [-15, 15]);
  const controls = useAnimation();

  const handle_drag_end = async (_: any, info: any) => {
    if (disabled) return;

    const threshold = 140;
    const velocity_threshold = 500;
    const x = info.offset.x;
    const v_x = info.velocity.x;
    const y = info.offset.y;

    if (x > threshold || v_x > velocity_threshold) {
      await controls.start({ x: 500, opacity: 0, transition: { duration: 0.3 } });
      on_decision("yes");
    } else if (x < -threshold || v_x < -velocity_threshold) {
      await controls.start({ x: -500, opacity: 0, transition: { duration: 0.3 } });
      on_decision("no");
    } else if (y > 120) {
      await controls.start({ y: 500, opacity: 0, transition: { duration: 0.3 } });
      on_decision("skip");
    } else {
      controls.start({ x: 0, y: 0, transition: { type: "spring", stiffness: 300, damping: 20 } });
    }
  };

  useEffect(() => {
    const on_key_down = async (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }
      if (target?.isContentEditable) {
        return;
      }
      if (disabled) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        await controls.start({ x: -500, opacity: 0, transition: { duration: 0.3 } });
        on_decision("no");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        await controls.start({ x: 500, opacity: 0, transition: { duration: 0.3 } });
        on_decision("yes");
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        await controls.start({ y: 500, opacity: 0, transition: { duration: 0.3 } });
        on_decision("skip");
      }
    };

    window.addEventListener("keydown", on_key_down);
    return () => window.removeEventListener("keydown", on_key_down);
  }, [disabled, controls, on_decision]);

  return (
    <motion.div
      drag={!disabled}
      dragDirectionLock={false}
      dragElastic={0.4}
      style={{ x: x_mv, rotate }}
      animate={controls}
      onDragEnd={handle_drag_end}
      whileDrag={disabled ? undefined : { scale: 1.05, cursor: "grabbing" }}
      className="relative flex flex-col justify-between overflow-hidden rounded-[2rem] border border-[#1e2422] bg-[#111513] p-6 shadow-2xl h-[420px] w-full max-w-[360px] mx-auto cursor-grab"
    >
      <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-[#0b0f0e] via-transparent to-transparent opacity-80 z-0"></div>

      <div className="relative z-10 flex items-start justify-between">
        <span className="inline-flex rounded-full border border-[#b9f6c9]/20 bg-[#b9f6c9]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-[#b9f6c9] backdrop-blur-sm">
          crypto market
        </span>
        <span className="text-xs font-bold text-[#9eaba4]">#{round.roundNumber}</span>
      </div>

      <div className="relative z-10 mt-auto drop-shadow-md">
        <h2 className="text-3xl font-black text-[#e7efe9] tracking-tight">{round.market.display_name}</h2>

        <div className="mt-3 grid gap-1 text-sm font-medium text-[#9eaba4]">
          <p className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#89eeb0]"></span> ref price: <span className="text-[#e7efe9]">${format_price(round.referencePrice)}</span></p>
          <p className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-[#62df98]/50"></span> timeframe: <span className="text-[#e7efe9]">{round.market.timeframe_minutes}m</span></p>
          <p className="flex items-center gap-2"><span className="w-2 h-2 rounded-full border border-[#9eaba4]"></span> your stake: <span className="text-[#e7efe9]">{amount_sol.toFixed(2)} SOL</span></p>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-[#b9f6c9]/30 bg-[#b9f6c9]/10 p-3 backdrop-blur-md">
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#89eeb0]">yes pool</p>
            <p className="mt-1 text-lg font-black text-[#e7efe9]">{format_sol(round.totals.yesLamports)} <span className="text-xs text-[#89eeb0]">SOL</span></p>
          </div>
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-3 backdrop-blur-md">
            <p className="text-[10px] font-bold uppercase tracking-widest text-red-400">no pool</p>
            <p className="mt-1 text-lg font-black text-[#e7efe9]">{format_sol(round.totals.noLamports)} <span className="text-xs text-red-400">SOL</span></p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-8 text-[11px] font-bold uppercase tracking-widest text-[#9eaba4]/60">
          <span className="flex flex-col items-center gap-1"><span className="text-red-400/80 text-lg">←</span> no</span>
          <span className="flex flex-col items-center gap-1"><span className="text-[#9eaba4]/80 text-lg">↓</span> skip</span>
          <span className="flex flex-col items-center gap-1"><span className="text-[#89eeb0]/80 text-lg">→</span> yes</span>
        </div>
      </div>
    </motion.div>
  );
};
