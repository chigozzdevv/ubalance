import { market_seed_data } from "@/features/markets/markets.data";
import type { market } from "@/features/markets/markets.model";
import type { chain_admin_service } from "@/features/chain/chain-admin.service";
import type { oracle_service } from "@/features/oracle/oracle.service";
import type { market_document, mongo_service } from "@/shared/mongo";

export class markets_service {
  constructor(
    private readonly mongo: mongo_service,
    private readonly chain_admin: chain_admin_service,
    private readonly oracle: oracle_service
  ) {}

  async bootstrap(): Promise<void> {
    await this.seed_markets();
    await this.sync_chain_markets();
  }

  async seed_markets(): Promise<void> {
    await this.mongo.ensure_ready();
    const now = Date.now();
    for (const market_item of market_seed_data) {
      await this.mongo.markets_collection.updateOne(
        { slug: market_item.slug },
        {
          $set: {
            display_name: market_item.display_name,
            base_symbol: market_item.base_symbol,
            quote_symbol: market_item.quote_symbol,
            oracle_symbol: market_item.oracle_symbol,
            timeframe_minutes: market_item.timeframe_minutes,
            category: market_item.category,
            active: market_item.active,
            market_index: market_item.market_index,
            updated_at_ms: now
          },
          $setOnInsert: {
            _id: market_item.slug,
            slug: market_item.slug,
            market_pda: market_item.market_pda,
            created_at_ms: now
          }
        },
        { upsert: true }
      );
    }
  }

  async sync_chain_markets(): Promise<void> {
    await this.mongo.ensure_ready();
    const active_markets = await this.list(true);

    for (const market_item of active_markets) {
      const initialized = await this.chain_admin.ensure_market_initialized({
        market_index: market_item.market_index,
        display_name: market_item.display_name,
        timeframe_minutes: market_item.timeframe_minutes
      });
      const oracle_feed_id_hex = await this.oracle.get_feed_id(market_item.oracle_symbol);
      await this.chain_admin.ensure_market_oracle_initialized({
        market_index: market_item.market_index,
        oracle_feed_id_hex
      });
      await this.mongo.markets_collection.updateOne(
        { slug: market_item.slug },
        { $set: { market_pda: initialized.market_pda, updated_at_ms: Date.now() } }
      );
    }
  }

  async list(active_only = true): Promise<market[]> {
    await this.mongo.ensure_ready();
    const rows = await this.mongo.markets_collection
      .find(active_only ? { active: true } : {})
      .sort({ market_index: 1 })
      .toArray();
    return rows.map((row: market_document) => this.map_document_to_market(row));
  }

  async get_by_slug(slug: string): Promise<market | null> {
    await this.mongo.ensure_ready();
    const document = await this.mongo.markets_collection.findOne({ slug });
    if (!document) {
      return null;
    }
    return this.map_document_to_market(document);
  }

  private map_document_to_market(document: market_document): market {
    return {
      slug: document.slug,
      display_name: document.display_name,
      base_symbol: document.base_symbol,
      quote_symbol: document.quote_symbol,
      oracle_symbol: document.oracle_symbol,
      timeframe_minutes: Number(document.timeframe_minutes),
      category: document.category as market["category"],
      active: Boolean(document.active),
      market_index: Number(document.market_index),
      market_pda: document.market_pda
    };
  }
}
