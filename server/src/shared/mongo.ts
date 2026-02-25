import { MongoClient, type Collection, type Db } from "mongodb";
import { env } from "@/config/env";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve_sleep) => setTimeout(resolve_sleep, ms));
};

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

export type match_document = {
  _id: string;
  id: string;
  market_slug: string;
  market_pda: string;
  match_id: number;
  match_pda: string;
  buy_in_lamports: number;
  max_players: number;
  player_count: number;
  pot_lamports: number;
  winner_count: number;
  highest_score: number;
  start_at_ms: number;
  end_at_ms: number;
  status: "open" | "locked" | "resolved" | "cancelled";
  create_tx_signature: string | null;
  lock_tx_signature: string | null;
  finalize_tx_signature: string | null;
  cancel_tx_signature: string | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type match_entry_document = {
  _id: string;
  match_id: string;
  match_pda: string;
  wallet: string;
  match_entry_pda: string;
  buy_in_lamports: number;
  score: number | null;
  is_winner: boolean | null;
  result_recorded: boolean;
  joined: boolean;
  claimed: boolean;
  join_tx_signature: string | null;
  claim_tx_signature: string | null;
  joined_at_ms: number;
  claimed_at_ms: number | null;
  updated_at_ms: number;
};

export type ai_duel_turn_document = {
  turn_index: number;
  player_side: "yes" | "no" | "skip";
  ai_side: "yes" | "no" | "skip";
  amount_lamports: number;
  ai_decision_model?: string | null;
  ai_decision_confidence?: number | null;
  ai_decision_rationale?: string | null;
  ai_nonce_base64: string;
  ai_commitment_base64: string;
  status: "prepared" | "open";
  tx_signature: string | null;
  created_at_ms: number;
};

export type ai_duel_document = {
  _id: string;
  id: string;
  market_slug: string;
  market_pda: string;
  round_id: string;
  round_number: number;
  round_pda: string;
  player_wallet: string;
  duel_id: number;
  ai_duel_pda: string;
  house_bankroll_pda: string;
  player_side?: "yes" | "no" | "skip";
  ai_side?: "yes" | "no" | "skip";
  ai_decision_model?: string | null;
  ai_decision_confidence?: number | null;
  ai_decision_rationale?: string | null;
  ai_nonce_base64?: string;
  ai_commitment_base64?: string;
  amount_lamports: number;
  turn_count?: number;
  turns?: ai_duel_turn_document[];
  pending_turn?: ai_duel_turn_document | null;
  status: "prepared" | "open" | "revealed" | "settled" | "cancelled";
  outcome: "player_win" | "house_win" | "push" | null;
  player_payout_lamports: number | null;
  open_tx_signature: string | null;
  reveal_tx_signature: string | null;
  settle_tx_signature: string | null;
  claim_tx_signature: string | null;
  claimed_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
};

export type auth_challenge_document = {
  _id: string;
  wallet: string;
  message: string;
  expires_at_ms: number;
  expires_at: Date;
  updated_at_ms: number;
};

export type auth_session_document = {
  _id: string;
  token: string;
  wallet: string;
  expires_at_ms: number;
  expires_at: Date;
  created_at_ms: number;
};

export class mongo_service {
  readonly client: MongoClient;
  db!: Db;
  markets_collection!: Collection<market_document>;
  rounds_collection!: Collection<round_document>;
  round_actions_collection!: Collection<round_action_document>;
  matches_collection!: Collection<match_document>;
  match_entries_collection!: Collection<match_entry_document>;
  ai_duels_collection!: Collection<ai_duel_document>;
  auth_challenges_collection!: Collection<auth_challenge_document>;
  auth_sessions_collection!: Collection<auth_session_document>;
  private init_promise: Promise<void> | null = null;
  private initialized = false;

  constructor() {
    this.client = new MongoClient(env.MONGODB_URI, {
      serverSelectionTimeoutMS: 7_000,
      connectTimeoutMS: 7_000,
      socketTimeoutMS: 20_000
    });
  }

  async ensure_ready(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.init_promise) {
      this.init_promise = this.initialize_with_retry()
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.init_promise = null;
        });
    }

    await this.init_promise;
  }

  private async initialize_with_retry(): Promise<void> {
    const max_attempts = 3;
    let last_error: unknown = null;

    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      try {
        await this.initialize_once();
        return;
      } catch (error) {
        last_error = error;
        if (attempt >= max_attempts) {
          break;
        }
        const delay_ms = Math.min(4_000, 400 * attempt);
        await sleep(delay_ms);
      }
    }

    throw (last_error instanceof Error ? last_error : new Error("failed to initialize MongoDB connection"));
  }

  private async initialize_once(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(env.MONGODB_DB_NAME);
    this.markets_collection = this.db.collection<market_document>("markets");
    this.rounds_collection = this.db.collection<round_document>("rounds");
    this.round_actions_collection = this.db.collection<round_action_document>("round_actions");
    this.matches_collection = this.db.collection<match_document>("matches");
    this.match_entries_collection = this.db.collection<match_entry_document>("match_entries");
    this.ai_duels_collection = this.db.collection<ai_duel_document>("ai_duels");
    this.auth_challenges_collection = this.db.collection<auth_challenge_document>("auth_challenges");
    this.auth_sessions_collection = this.db.collection<auth_session_document>("auth_sessions");
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

    await this.matches_collection.createIndex({ id: 1 }, { unique: true, name: "idx_matches_id_unique" });
    await this.matches_collection.createIndex(
      { market_slug: 1, match_id: 1 },
      { unique: true, name: "idx_matches_market_match_id_unique" }
    );
    await this.matches_collection.createIndex(
      { market_slug: 1, status: 1, end_at_ms: 1 },
      { name: "idx_matches_market_status_end" }
    );
    await this.matches_collection.createIndex(
      { status: 1, end_at_ms: 1 },
      { name: "idx_matches_status_end" }
    );

    await this.match_entries_collection.createIndex(
      { match_id: 1, wallet: 1 },
      { unique: true, name: "idx_match_entries_match_wallet_unique" }
    );
    await this.match_entries_collection.createIndex(
      { match_id: 1 },
      { name: "idx_match_entries_match" }
    );
    await this.match_entries_collection.createIndex(
      { wallet: 1, claimed: 1 },
      { name: "idx_match_entries_wallet_claimed" }
    );

    await this.ai_duels_collection.createIndex({ id: 1 }, { unique: true, name: "idx_ai_duels_id_unique" });
    await this.ai_duels_collection.createIndex(
      { market_slug: 1, player_wallet: 1, duel_id: 1 },
      { unique: true, name: "idx_ai_duels_market_player_duel_unique" }
    );
    await this.ai_duels_collection.createIndex(
      { round_id: 1, status: 1 },
      { name: "idx_ai_duels_round_status" }
    );
    await this.ai_duels_collection.createIndex(
      { status: 1, market_slug: 1 },
      { name: "idx_ai_duels_status_market" }
    );
    await this.ai_duels_collection.createIndex(
      { player_wallet: 1, status: 1, created_at_ms: -1 },
      { name: "idx_ai_duels_player_status_created" }
    );
    await this.ai_duels_collection.createIndex(
      { status: 1, created_at_ms: 1 },
      { name: "idx_ai_duels_status_created" }
    );

    await this.auth_challenges_collection.createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0, name: "idx_auth_challenges_expires_ttl" }
    );

    await this.auth_sessions_collection.createIndex({ wallet: 1 }, { name: "idx_auth_sessions_wallet" });
    await this.auth_sessions_collection.createIndex(
      { expires_at: 1 },
      { expireAfterSeconds: 0, name: "idx_auth_sessions_expires_ttl" }
    );
  }
}
