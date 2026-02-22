export type market = {
  slug: string;
  display_name: string;
  base_symbol: string;
  quote_symbol: string;
  oracle_symbol: string;
  timeframe_minutes: number;
  category: "crypto-price-movement";
  active: boolean;
  market_index: number;
  market_pda: string;
};
