import { app_error } from "@/shared/app-error";
import { env } from "@/config/env";

type pyth_price_feed = {
  id: string;
  attributes?: {
    symbol?: string;
  };
};

type pyth_update = {
  parsed?: Array<{
    id: string;
    price?: {
      price: string;
      expo: number;
      publish_time: number;
    };
  }>;
};

const request_timeout_ms = 8_000;

const timed_fetch = (input: URL): Promise<Response> => {
  return fetch(input, {
    method: "GET",
    signal: AbortSignal.timeout(request_timeout_ms)
  });
};

const normalize_symbol = (symbol: string): string => symbol.trim().toUpperCase();

const to_decimal_price = (price: string, expo: number): number => {
  const raw = Number(price);
  return raw * 10 ** expo;
};

export class oracle_service {
  private feed_id_by_symbol = new Map<string, string>();

  constructor(private readonly base_url = env.PYTH_HERMES_URL) {}

  async get_latest_price(oracle_symbol: string): Promise<number> {
    const normalized = normalize_symbol(oracle_symbol);
    const feed_id = await this.resolve_feed_id(normalized);
    const latest = await this.fetch_price_update(`${this.base_url}/v2/updates/price/latest`, feed_id);
    return latest.price;
  }

  async get_feed_id(oracle_symbol: string): Promise<string> {
    return this.resolve_feed_id(normalize_symbol(oracle_symbol));
  }

  async get_price_near_timestamp(oracle_symbol: string, timestamp_ms: number): Promise<number> {
    const normalized = normalize_symbol(oracle_symbol);
    const feed_id = await this.resolve_feed_id(normalized);
    const unix_seconds = Math.max(1, Math.floor(timestamp_ms / 1000));

    try {
      const historical = await this.fetch_price_update(`${this.base_url}/v2/updates/price/${unix_seconds}`, feed_id);
      return historical.price;
    } catch {
      const latest = await this.fetch_price_update(`${this.base_url}/v2/updates/price/latest`, feed_id);
      return latest.price;
    }
  }

  private async resolve_feed_id(oracle_symbol: string): Promise<string> {
    const cached = this.feed_id_by_symbol.get(oracle_symbol);
    if (cached) {
      return cached;
    }

    const query = new URL(`${this.base_url}/v2/price_feeds`);
    query.searchParams.set("query", oracle_symbol);
    const response = await timed_fetch(query);
    if (!response.ok) {
      throw new app_error(`oracle feed lookup failed (${response.status})`, 502);
    }

    const feeds = (await response.json()) as pyth_price_feed[];
    if (!Array.isArray(feeds) || feeds.length === 0) {
      throw new app_error(`oracle feed not found for ${oracle_symbol}`, 404);
    }

    const match =
      feeds.find((item) => normalize_symbol(item.attributes?.symbol ?? "") === oracle_symbol) ??
      feeds.find((item) => normalize_symbol(item.attributes?.symbol ?? "").includes(oracle_symbol)) ??
      feeds[0];

    if (!match?.id) {
      throw new app_error(`oracle feed missing id for ${oracle_symbol}`, 502);
    }

    this.feed_id_by_symbol.set(oracle_symbol, match.id);
    return match.id;
  }

  private async fetch_price_update(endpoint: string, feed_id: string): Promise<{ price: number; publish_time: number }> {
    const query = new URL(endpoint);
    query.searchParams.append("ids[]", feed_id);
    const response = await timed_fetch(query);
    if (!response.ok) {
      throw new app_error(`oracle update request failed (${response.status})`, 502);
    }

    const body = (await response.json()) as pyth_update;
    const parsed = body.parsed?.find((item) => item.id === feed_id) ?? body.parsed?.[0];
    const price_value = parsed?.price;
    if (!price_value) {
      throw new app_error("oracle update missing price", 502);
    }

    const price = to_decimal_price(price_value.price, price_value.expo);
    if (!Number.isFinite(price) || price <= 0) {
      throw new app_error("oracle returned invalid price", 502);
    }
    return {
      price,
      publish_time: price_value.publish_time
    };
  }
}
