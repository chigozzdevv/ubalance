"use client";

import type { market } from "@/types/market";
import { ConnectWalletButton } from "@/components/wallet/connect-wallet-button";

type top_nav_props = {
  markets: market[];
  selected_market_slug: string | null;
  on_select_market_slug: (slug: string) => void;
  search_query: string;
  on_search_query: (value: string) => void;
};

export const TopNav = ({
  markets,
  selected_market_slug,
  on_select_market_slug,
  search_query,
  on_search_query
}: top_nav_props) => {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-slate-900 text-sm font-black text-white">U</div>
          <div>
            <p className="text-sm font-bold text-slate-900">ubalance</p>
            <p className="text-xs text-slate-500">prediction market</p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 md:max-w-xl md:flex-row">
          <input
            type="search"
            value={search_query}
            onChange={(event) => on_search_query(event.target.value)}
            placeholder="search markets"
            className="h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none ring-slate-900/20 transition focus:ring"
          />

          <select
            value={selected_market_slug ?? ""}
            onChange={(event) => on_select_market_slug(event.target.value)}
            disabled={markets.length === 0}
            className="h-10 min-w-52 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none ring-slate-900/20 transition focus:ring"
          >
            {markets.length === 0 ? <option value="">no markets</option> : null}
            {markets.map((market_item) => (
              <option key={market_item.slug} value={market_item.slug}>
                {market_item.display_name}
              </option>
            ))}
          </select>
        </div>

        <ConnectWalletButton />
      </div>
    </header>
  );
};
