import type { market } from "@/types/market";

export const to_market_options = (markets: market[], search_query: string): market[] => {
  const normalized_query = search_query.trim().toLowerCase();
  if (!normalized_query) {
    return markets;
  }

  return markets.filter((market_item) => {
    return (
      market_item.display_name.toLowerCase().includes(normalized_query) ||
      market_item.base_symbol.toLowerCase().includes(normalized_query) ||
      market_item.quote_symbol.toLowerCase().includes(normalized_query)
    );
  });
};
