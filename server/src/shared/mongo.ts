import { MongoClient, type Collection, type Db } from "mongodb";
import { env } from "@/config/env";

export type market_document = {
  _id: string;
  slug: string;
  display_name: string;
  base_symbol: string;
  quote_symbol: string;
  oracle_symbol: string;
  timeframe_minutes: number;
  category: string;
  active: boolean;
  market_index: number;
  market_pda: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type round_document = {
  _id: string;
  id: string;
  market_slug: string;
  market_pda: string;
  round_number: number;
  round_pda: string;
  status: "predicting" | "locked" | "resolved";
  reference_price: number;
  settlement_price: number | null;
  winning_side: "yes" | "no" | "skip" | null;
  open_at_ms: number;
  close_at_ms: number;
  locked_at_ms: number | null;
  resolve_at_ms: number | null;
  open_tx_signature: string | null;
  lock_tx_signature: string | null;
  resolve_tx_signature: string | null;
  totals: {
    yes_lamports: number;
    no_lamports: number;
    skip_count: number;
    action_count: number;
  };
  created_at_ms: number;
  updated_at_ms: number;
};

export type round_action_document = {
  _id: string;
  round_id: string;
  wallet: string;
  side: "yes" | "no" | "skip";
  amount_lamports: number;
  tx_signature: string | null;
  updated_at_ms: number;
};

export class mongo_service {
  readonly client: MongoClient;
  db!: Db;
  markets_collection!: Collection<market_document>;
  rounds_collection!: Collection<round_document>;
  round_actions_collection!: Collection<round_action_document>;
  private readonly init_promise: Promise<void>;

  constructor() {
    this.client = new MongoClient(env.MONGODB_URI);
    this.init_promise = this.initialize();
  }

  async ensure_ready(): Promise<void> {
    await this.init_promise;
  }

  private async initialize(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(env.MONGODB_DB_NAME);
    this.markets_collection = this.db.collection<market_document>("markets");
    this.rounds_collection = this.db.collection<round_document>("rounds");
    this.round_actions_collection = this.db.collection<round_action_document>("round_actions");
    await this.ensure_indexes();
  }

  private async ensure_indexes(): Promise<void> {
    await this.markets_collection.createIndex({ slug: 1 }, { unique: true, name: "idx_markets_slug_unique" });
    await this.markets_collection.createIndex({ market_index: 1 }, { unique: true, name: "idx_markets_index_unique" });

    await this.rounds_collection.createIndex({ id: 1 }, { unique: true, name: "idx_rounds_id_unique" });
    await this.rounds_collection.createIndex(
      { market_slug: 1, round_number: 1 },
      { unique: true, name: "idx_rounds_market_round_unique" }
    );
    await this.rounds_collection.createIndex({ market_slug: 1, status: 1 }, { name: "idx_rounds_market_status" });
    await this.rounds_collection.createIndex({ status: 1, close_at_ms: 1 }, { name: "idx_rounds_status_close" });
    await this.rounds_collection.createIndex({ status: 1, resolve_at_ms: 1 }, { name: "idx_rounds_status_resolve" });

    await this.round_actions_collection.createIndex({ round_id: 1, wallet: 1 }, { unique: true, name: "idx_actions_round_wallet_unique" });
    await this.round_actions_collection.createIndex({ round_id: 1 }, { name: "idx_actions_round" });
  }
}
