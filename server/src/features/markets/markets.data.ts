import type { market } from "@/features/markets/markets.model";

const primary_market_seed_data: market[] = [
  {
    slug: "btc-usdt-5m",
    display_name: "BTC / USDT 5m",
    base_symbol: "BTC",
    quote_symbol: "USDT",
    oracle_symbol: "Crypto.BTC/USD",
    timeframe_minutes: 5,
    category: "crypto-price-movement",
    active: true,
    market_index: 1,
    market_pda: ""
  },
  {
    slug: "eth-usdt-5m",
    display_name: "ETH / USDT 5m",
    base_symbol: "ETH",
    quote_symbol: "USDT",
    oracle_symbol: "Crypto.ETH/USD",
    timeframe_minutes: 5,
    category: "crypto-price-movement",
    active: true,
    market_index: 2,
    market_pda: ""
  },
  {
    slug: "sol-usdt-5m",
    display_name: "SOL / USDT 5m",
    base_symbol: "SOL",
    quote_symbol: "USDT",
    oracle_symbol: "Crypto.SOL/USD",
    timeframe_minutes: 5,
    category: "crypto-price-movement",
    active: true,
    market_index: 3,
    market_pda: ""
  },
  {
    slug: "bnb-usdt-5m",
    display_name: "BNB / USDT 5m",
    base_symbol: "BNB",
    quote_symbol: "USDT",
    oracle_symbol: "Crypto.BNB/USD",
    timeframe_minutes: 5,
    category: "crypto-price-movement",
    active: true,
    market_index: 4,
    market_pda: ""
  },
  {
    slug: "xrp-usdt-5m",
    display_name: "XRP / USDT 5m",
    base_symbol: "XRP",
    quote_symbol: "USDT",
    oracle_symbol: "Crypto.XRP/USD",
    timeframe_minutes: 5,
    category: "crypto-price-movement",
    active: true,
    market_index: 5,
    market_pda: ""
  }
];

const additional_timeframe_minutes = [1, 3, 15, 30];

const additional_market_seed_data: market[] = primary_market_seed_data.flatMap((market_item) => {
  return additional_timeframe_minutes.map((timeframe_minutes) => {
    const slug = `${market_item.base_symbol.toLowerCase()}-${market_item.quote_symbol.toLowerCase()}-${timeframe_minutes}m`;
    return {
      slug,
      display_name: `${market_item.base_symbol} / ${market_item.quote_symbol} ${timeframe_minutes}m`,
      base_symbol: market_item.base_symbol,
      quote_symbol: market_item.quote_symbol,
      oracle_symbol: market_item.oracle_symbol,
      timeframe_minutes,
      category: market_item.category,
      active: true,
      market_index: 0,
      market_pda: ""
    };
  });
});

export const market_seed_data: market[] = [
  ...primary_market_seed_data,
  ...additional_market_seed_data.map((market_item, market_index) => {
    return {
      ...market_item,
      market_index: primary_market_seed_data.length + market_index + 1
    };
  })
];
