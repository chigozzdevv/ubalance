"use client";

import type { market } from "@/types/market";
import { ConnectWalletButton } from "@/components/wallet/connect-wallet-button";

import { useState, useRef, useEffect } from "react";
import type { round_view } from "@/types/round";
import { format_price } from "@/lib/format";

type top_nav_props = {
  timeframes: number[];
  selected_timeframe: number | null;
  on_select_timeframe: (timeframe: number | null) => void;
  history: round_view[];
  amount_sol: number;
  on_amount_change: (value: number) => void;
};

export const TopNav = ({
  timeframes,
  selected_timeframe,
  on_select_timeframe,
  history,
  amount_sol,
  on_amount_change,
}: top_nav_props) => {
  const [history_open, set_history_open] = useState(false);
  const [amount_open, set_amount_open] = useState(false);
  const dropdown_ref = useRef<HTMLDivElement>(null);
  const amount_ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle_click_outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdown_ref.current && !dropdown_ref.current.contains(target)) {
        set_history_open(false);
      }
      if (amount_ref.current && !amount_ref.current.contains(target)) {
        set_amount_open(false);
      }
    };
    document.addEventListener("mousedown", handle_click_outside);
    return () => document.removeEventListener("mousedown", handle_click_outside);
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-[#1e2422] bg-[#0b0f0e]/80 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#b9f6c9] text-sm font-black text-[#0a1611] shadow-[0_0_15px_rgba(185,246,201,0.2)]">U</div>
          <div>
            <p className="text-sm font-bold text-[#e7efe9] tracking-tight">ubalance</p>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#9eaba4]">prediction market</p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-3 md:max-w-xl md:flex-row items-center justify-end">
          <select
            value={selected_timeframe === null ? "" : selected_timeframe.toString()}
            onChange={(event) => {
              const val = event.target.value;
              on_select_timeframe(val === "" ? null : Number(val));
            }}
            disabled={timeframes.length === 0}
            className="h-11 min-w-40 md:min-w-52 rounded-xl border border-[#1e2422] bg-[#111513] px-4 text-sm font-semibold text-[#e7efe9] outline-none transition duration-200 focus:border-[#89eeb0] focus:ring-1 focus:ring-[#89eeb0] flex-1 md:flex-none appearance-none cursor-pointer"
            style={{
              backgroundImage: 'url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%239eaba4\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3e%3cpolyline points=\'6 9 12 15 18 9\'%3e%3c/polyline%3e%3c/svg%3e")',
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 12px center",
              backgroundSize: "16px",
              paddingRight: "40px"
            }}
          >
            {timeframes.length === 0 ? <option value="">no markets</option> : null}
            <option value="">all markets</option>
            {timeframes.map((tf) => (
              <option key={tf} value={tf.toString()}>
                {tf}m markets
              </option>
            ))}
          </select>

          <div className="relative" ref={amount_ref}>
            <button
              onClick={() => {
                set_amount_open(!amount_open);
                set_history_open(false);
              }}
              className={`h-11 px-3 flex items-center justify-center gap-2 rounded-xl border border-[#1e2422] ${amount_open ? 'bg-[#171b19] border-[#89eeb0] text-[#b9f6c9]' : 'bg-[#111513] text-[#e7efe9]'} transition duration-200 hover:border-[#89eeb0] hover:text-[#b9f6c9] active:scale-95`}
              aria-label="Edit Stake Amount"
            >
              <span className="text-sm font-bold min-w-[3ch]">{amount_sol.toFixed(2)}</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-[#9eaba4]">SOL</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
            </button>

            {amount_open && (
              <div className="absolute right-0 top-[calc(100%+8px)] w-72 md:w-80 rounded-2xl border border-[#1e2422] bg-[#111513] p-4 shadow-2xl z-50">
                <div className="absolute inset-0 pointer-events-none opacity-20 bg-gradient-to-br from-[#b9f6c9] to-transparent mix-blend-overlay rounded-2xl"></div>
                <label className="relative z-10 text-[10px] font-bold uppercase tracking-widest text-[#9eaba4] mb-3 block border-b border-[#1e2422] pb-2">
                  stake amount (SOL)
                </label>

                <div className="relative z-10 flex items-center gap-2 mb-4">
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e2422] bg-[#171b19] font-medium text-[#e7efe9] transition duration-200 hover:border-[#89eeb0] hover:bg-[#b9f6c9]/10 hover:text-[#b9f6c9] active:scale-95"
                    onClick={() => {
                      const value = amount_sol - 0.05;
                      on_amount_change(Math.max(0, Number(value.toFixed(4))));
                    }}
                  >
                    -
                  </button>
                  <div className="relative flex-1">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={Number.isFinite(amount_sol) ? amount_sol : 0}
                      onChange={(event) => {
                        const value = Number(event.target.value || 0);
                        on_amount_change(Math.max(0, Number(value.toFixed(4))));
                      }}
                      className="h-10 w-full appearance-none rounded-xl border border-[#1e2422] bg-[#0b0f0e] px-3 text-center text-base font-bold text-[#b9f6c9] outline-none transition duration-200 focus:border-[#89eeb0] focus:ring-1 focus:ring-[#89eeb0]"
                    />
                  </div>
                  <button
                    type="button"
                    className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#1e2422] bg-[#171b19] font-medium text-[#e7efe9] transition duration-200 hover:border-[#89eeb0] hover:bg-[#b9f6c9]/10 hover:text-[#b9f6c9] active:scale-95"
                    onClick={() => {
                      const value = amount_sol + 0.05;
                      on_amount_change(Math.max(0, Number(value.toFixed(4))));
                    }}
                  >
                    +
                  </button>
                </div>

                <div className="relative z-10 grid grid-cols-3 gap-2">
                  {[0.05, 0.1, 0.25, 0.5, 1, 2].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => on_amount_change(preset)}
                      className={`flex items-center justify-center rounded-lg border px-2 py-2 text-xs font-semibold transition duration-200 active:scale-95 ${amount_sol === preset
                        ? "border-[#89eeb0] bg-[#b9f6c9]/15 text-[#b9f6c9] shadow-[0_0_15px_rgba(185,246,201,0.15)]"
                        : "border-[#1e2422] bg-[#171b19] text-[#9eaba4] hover:border-gray-600 hover:text-[#e7efe9]"
                        }`}
                    >
                      {preset.toFixed(2)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="relative" ref={dropdown_ref}>
            <button
              onClick={() => {
                set_history_open(!history_open);
                set_amount_open(false);
              }}
              className={`h-11 w-11 flex items-center justify-center rounded-xl border border-[#1e2422] ${history_open ? 'bg-[#171b19] border-[#89eeb0] text-[#b9f6c9]' : 'bg-[#111513] text-[#9eaba4]'} transition duration-200 hover:border-[#89eeb0] hover:text-[#b9f6c9] active:scale-95`}
              aria-label="Round History"
            >
              <svg xmlns="http://www.w3.org/-2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                <path d="M3 3v5h5"></path>
                <path d="M12 7v5l4 2"></path>
              </svg>
            </button>

            {history_open && (
              <div className="absolute right-0 top-[calc(100%+8px)] w-80 md:w-96 rounded-2xl border border-[#1e2422] bg-[#111513] p-4 shadow-2xl z-50 max-h-[70vh] overflow-y-auto custom-scrollbar">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-[#9eaba4] mb-3 sticky top-0 bg-[#111513] pb-2 border-b border-[#1e2422]">recent rounds</h3>

                {history.length > 0 ? (
                  <div className="grid gap-3">
                    {history.map((round_item) => (
                      <article key={round_item.id} className="relative overflow-hidden rounded-xl border border-[#1e2422]/60 bg-[#171b19]/50 p-4 group hover:border-[#b9f6c9]/30 transition-colors duration-300">
                        <div className="flex items-start justify-between gap-3 relative z-10">
                          <div>
                            <p className="text-sm font-bold text-[#e7efe9]">{round_item.market.display_name}</p>
                            <p className="text-xs text-[#9eaba4] mt-0.5">round #{round_item.roundNumber}</p>
                          </div>
                          <span className="rounded-md border border-[#1e2422] bg-[#0b0f0e] px-2 py-1 text-[10px] uppercase font-bold tracking-widest text-[#9eaba4]">
                            {round_item.status}
                          </span>
                        </div>

                        <div className="mt-3 grid gap-1.5 text-xs text-[#9eaba4] relative z-10">
                          <p className="flex justify-between border-b border-[#1e2422] pb-1.5"><span>ref price:</span> <span className="font-mono text-[#e7efe9]">${format_price(round_item.referencePrice)}</span></p>
                          <p className="flex justify-between border-b border-[#1e2422] pb-1.5 pt-1">
                            <span>settle:</span>
                            <span className="font-mono text-[#e7efe9]">
                              {round_item.settlementPrice === null
                                ? "pending"
                                : `$${format_price(round_item.settlementPrice)}`}
                            </span>
                          </p>
                          <p className="flex justify-between pt-1">
                            <span>winner:</span>
                            <span className={`font-bold ${round_item.winningSide === 'yes' ? 'text-[#89eeb0]' : round_item.winningSide === 'no' ? 'text-red-400' : 'text-[#e7efe9]'}`}>{round_item.winningSide ?? "pending"}</span>
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-[#1e2422] p-6 text-sm text-[#9eaba4] text-center font-medium">
                    no round history yet
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <ConnectWalletButton />
      </div>
    </header>
  );
};
