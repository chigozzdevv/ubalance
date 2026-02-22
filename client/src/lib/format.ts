export const format_price = (value: number): string =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value > 10 ? 2 : 4,
    maximumFractionDigits: value > 10 ? 2 : 4
  }).format(value);

export const format_sol = (lamports: number): string => (lamports / 1_000_000_000).toFixed(2);

export const truncate_wallet = (wallet: string): string => `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
