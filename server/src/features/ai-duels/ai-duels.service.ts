import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type {
  ai_duel_document,
  ai_duel_turn_document,
  mongo_service
} from "@/shared/mongo";
import type { markets_service } from "@/features/markets/markets.service";
import type { market } from "@/features/markets/markets.model";
import type { chain_admin_service } from "@/features/chain/chain-admin.service";
import type { decision_side } from "@/features/rounds/rounds.model";
import type {
  ai_duel_outcome,
  ai_duel_status,
  ai_duel_turn_view,
  ai_duel_view
} from "@/features/ai-duels/ai-duels.model";
import type { account_type } from "@/features/chain/ubalance-program";
import type { ai_decision_service, ai_user_performance_summary } from "@/features/ai-duels/ai-decision.service";

const ai_duel_commit_domain = Buffer.from("ubalance-ai-duel", "utf8");
const max_list_limit = 100;
const recent_market_rounds_limit = 20;
const recent_user_overall_duels_limit = 30;
const recent_user_market_duels_limit = 20;
const active_duel_statuses: ai_duel_status[] = ["prepared", "open", "revealed"];

export class ai_duels_service {
  constructor(
    private readonly mongo: mongo_service,
    private readonly markets_service: markets_service,
    private readonly chain_admin: chain_admin_service,
    private readonly ai_decision: ai_decision_service
  ) {}

  async list(input?: {
    wallet?: string;
    status?: ai_duel_status;
    market_slug?: string;
    limit?: number;
  }): Promise<ai_duel_view[]> {
    await this.mongo.ensure_ready();

    const safe_limit = Math.max(1, Math.min(input?.limit ?? 20, max_list_limit));
    const filter: Record<string, unknown> = {};
    if (input?.wallet) {
      filter.player_wallet = input.wallet;
    }
    if (input?.status) {
      filter.status = input.status;
    }
    if (input?.market_slug) {
      filter.market_slug = input.market_slug;
    }

    const rows = await this.mongo.ai_duels_collection
      .find(filter)
      .sort({ created_at_ms: -1 })
      .limit(safe_limit)
      .toArray();

    return this.hydrate_views(rows);
  }

  async get_by_id(duel_record_id: string): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();

    const duel_document = await this.mongo.ai_duels_collection.findOne({ id: duel_record_id });
    if (!duel_document) {
      throw new app_error("ai duel not found", 404);
    }

    const market_item = await this.get_market_or_throw(duel_document.market_slug);
    return this.to_view(duel_document, market_item);
  }

  async ensure_house_bankroll(input: { admin_wallet: string }): Promise<{
    house_bankroll_pda: string;
    initialize_tx_signature: string | null;
  }> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    return this.chain_admin.ensure_house_bankroll_initialized();
  }

  async fund_house_bankroll(input: {
    admin_wallet: string;
    amount_lamports: number;
  }): Promise<{ tx_signature: string; balance_lamports: number }> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    if (!Number.isInteger(input.amount_lamports) || input.amount_lamports <= 0) {
      throw new app_error("amountLamports must be a positive integer", 400);
    }

    await this.ensure_house_bankroll({ admin_wallet: input.admin_wallet });
    await this.ensure_undelegated(this.chain_admin.derive_house_bankroll_pda().toBase58(), {
      kind: "house_bankroll",
      admin: this.chain_admin.get_admin_public_key()
    });
    const tx_signature = await this.chain_admin.fund_house_bankroll(input.amount_lamports);
    const balance_lamports = await this.chain_admin.get_house_bankroll_balance_lamports();
    return { tx_signature, balance_lamports };
  }

  async set_house_bankroll_active(input: {
    admin_wallet: string;
    active: boolean;
  }): Promise<{ tx_signature: string }> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    await this.ensure_house_bankroll({ admin_wallet: input.admin_wallet });
    await this.ensure_undelegated(this.chain_admin.derive_house_bankroll_pda().toBase58(), {
      kind: "house_bankroll",
      admin: this.chain_admin.get_admin_public_key()
    });

    const tx_signature = await this.chain_admin.set_house_bankroll_active(input.active);
    return { tx_signature };
  }

  async withdraw_house_bankroll(input: {
    admin_wallet: string;
    amount_lamports: number;
  }): Promise<{ tx_signature: string; balance_lamports: number }> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    if (!Number.isInteger(input.amount_lamports) || input.amount_lamports <= 0) {
      throw new app_error("amountLamports must be a positive integer", 400);
    }

    await this.ensure_undelegated(this.chain_admin.derive_house_bankroll_pda().toBase58(), {
      kind: "house_bankroll",
      admin: this.chain_admin.get_admin_public_key()
    });
    const tx_signature = await this.chain_admin.withdraw_house_bankroll(input.amount_lamports);
    const balance_lamports = await this.chain_admin.get_house_bankroll_balance_lamports();
    return { tx_signature, balance_lamports };
  }

  async prepare_open_relay(input: {
    wallet: string;
    round_id: string;
    player_side: decision_side;
    amount_lamports: number;
  }): Promise<{
    duel_record_id: string;
    transaction_base64: string;
    blockhash: string;
    last_valid_block_height: number;
    fee_payer: string;
    market_pda: string;
    round_pda: string;
    house_bankroll_pda: string;
    ai_duel_pda: string;
  }> {
    await this.mongo.ensure_ready();

    if (input.player_side !== "yes" && input.player_side !== "no") {
      throw new app_error("playerSide must be yes or no", 400);
    }
    if (!Number.isInteger(input.amount_lamports) || input.amount_lamports <= 0) {
      throw new app_error("amountLamports must be a positive integer", 400);
    }
    if (input.amount_lamports > env.AI_DUEL_MAX_STAKE_LAMPORTS) {
      throw new app_error(
        `amountLamports exceeds cap of ${env.AI_DUEL_MAX_STAKE_LAMPORTS}`,
        400
      );
    }

    const round_document = await this.mongo.rounds_collection.findOne({ id: input.round_id });
    if (!round_document) {
      throw new app_error("round not found", 404);
    }
    if (round_document.status !== "predicting") {
      throw new app_error("round is not open for ai duel", 409);
    }
    if (Date.now() >= Number(round_document.close_at_ms)) {
      throw new app_error("round is closed", 409);
    }

    const market_item = await this.get_market_or_throw(round_document.market_slug);

    const initialized = await this.ensure_house_bankroll({
      admin_wallet: this.chain_admin.get_admin_public_key().toBase58()
    });
    await this.ensure_delegated(initialized.house_bankroll_pda, {
      kind: "house_bankroll",
      admin: this.chain_admin.get_admin_public_key()
    });

    const round_number = Number(round_document.round_number);
    await this.ensure_round_delegated(market_item.market_index, round_number);
    await this.expire_stale_prepared_duels();
    await this.assert_open_exposure_limits({
      wallet: input.wallet,
      market_slug: market_item.slug,
      round_id: round_document.id,
      additional_amount_lamports: input.amount_lamports,
      increment_open_duel_count: true
    });

    const duel_id = await this.allocate_duel_id(market_item.slug, input.wallet);
    const [recent_resolved_rounds, recent_user_overall_duels, recent_user_market_duels] = await Promise.all([
      this.mongo.rounds_collection
        .find({
          market_slug: market_item.slug,
          status: "resolved",
          settlement_price: { $ne: null }
        })
        .sort({ close_at_ms: -1 })
        .limit(recent_market_rounds_limit)
        .toArray(),
      this.mongo.ai_duels_collection
        .find({
          player_wallet: input.wallet,
          status: "settled",
          outcome: { $in: ["player_win", "house_win", "push"] }
        })
        .sort({ created_at_ms: -1 })
        .limit(recent_user_overall_duels_limit)
        .toArray(),
      this.mongo.ai_duels_collection
        .find({
          player_wallet: input.wallet,
          market_slug: market_item.slug,
          status: "settled",
          outcome: { $in: ["player_win", "house_win", "push"] }
        })
        .sort({ created_at_ms: -1 })
        .limit(recent_user_market_duels_limit)
        .toArray()
    ]);

    const recent_user_performance = {
      overall: this.summarize_user_performance(recent_user_overall_duels),
      market: this.summarize_user_performance(recent_user_market_duels)
    };

    const ai_decision = await this.ai_decision.decide_side({
      wallet: input.wallet,
      market: market_item,
      round: round_document,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      recent_user_performance,
      recent_resolved_rounds
    });

    const ai_side = ai_decision.side;
    const turn_index = 0;
    const nonce = randomBytes(32);
    const ai_commitment = this.build_ai_commitment({
      duel_id,
      turn_index,
      player_wallet: input.wallet,
      market_pda: round_document.market_pda,
      round_pda: round_document.round_pda,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_side,
      nonce
    });

    const prepared = await this.chain_admin.prepare_open_ai_duel_transaction({
      user_wallet: input.wallet,
      market_index: market_item.market_index,
      round_number,
      duel_id,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_commitment
    });

    const duel_record_id = `${round_document.id}:${input.wallet}:${duel_id}`;
    const now = Date.now();
    const pending_turn: ai_duel_turn_document = {
      turn_index,
      player_side: input.player_side,
      ai_side,
      amount_lamports: input.amount_lamports,
      ai_decision_model: ai_decision.model,
      ai_decision_confidence: ai_decision.confidence,
      ai_decision_rationale: ai_decision.rationale,
      ai_nonce_base64: nonce.toString("base64"),
      ai_commitment_base64: Buffer.from(ai_commitment).toString("base64"),
      status: "prepared",
      tx_signature: null,
      created_at_ms: now
    };

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_record_id },
      {
        $set: {
          id: duel_record_id,
          market_slug: market_item.slug,
          market_pda: round_document.market_pda,
          round_id: round_document.id,
          round_number,
          round_pda: round_document.round_pda,
          player_wallet: input.wallet,
          duel_id,
          ai_duel_pda: prepared.ai_duel_pda,
          house_bankroll_pda: initialized.house_bankroll_pda,
          amount_lamports: input.amount_lamports,
          turn_count: 0,
          turns: [],
          pending_turn,
          player_side: input.player_side,
          ai_side,
          ai_decision_model: ai_decision.model,
          ai_decision_confidence: ai_decision.confidence,
          ai_decision_rationale: ai_decision.rationale,
          ai_nonce_base64: pending_turn.ai_nonce_base64,
          ai_commitment_base64: pending_turn.ai_commitment_base64,
          status: "prepared",
          outcome: null,
          player_payout_lamports: null,
          open_tx_signature: null,
          reveal_tx_signature: null,
          settle_tx_signature: null,
          claim_tx_signature: null,
          claimed_at_ms: null,
          created_at_ms: now,
          updated_at_ms: now
        },
        $setOnInsert: {
          _id: duel_record_id
        }
      },
      { upsert: true }
    );

    return {
      duel_record_id,
      transaction_base64: prepared.transaction_base64,
      blockhash: prepared.blockhash,
      last_valid_block_height: prepared.last_valid_block_height,
      fee_payer: prepared.fee_payer,
      market_pda: prepared.market_pda,
      round_pda: prepared.round_pda,
      house_bankroll_pda: prepared.house_bankroll_pda,
      ai_duel_pda: prepared.ai_duel_pda
    };
  }

  async confirm_open(input: {
    duel_record_id: string;
    wallet: string;
    tx_signature: string;
  }): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.player_wallet !== input.wallet) {
      throw new app_error("unauthorized", 403);
    }
    const existing_turns = duel_document.turns ?? [];
    if (duel_document.status === "open" && !duel_document.pending_turn && existing_turns.length > 0) {
      return this.get_by_id(duel_document.id);
    }
    if (duel_document.status !== "prepared" && duel_document.status !== "open") {
      throw new app_error("ai duel is not waiting for open confirmation", 409);
    }

    const pending_turn = duel_document.pending_turn;
    if (!pending_turn || pending_turn.status !== "prepared" || pending_turn.turn_index !== 0) {
      throw new app_error("duel has no prepared opening turn", 409);
    }

    await this.chain_admin.verify_open_ai_duel_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_market_pda: duel_document.market_pda,
      expected_round_pda: duel_document.round_pda,
      expected_house_bankroll_pda: duel_document.house_bankroll_pda,
      expected_ai_duel_pda: duel_document.ai_duel_pda,
      expected_duel_id: Number(duel_document.duel_id),
      expected_player_side: pending_turn.player_side,
      expected_amount_lamports: Number(pending_turn.amount_lamports),
      expected_ai_commitment: Buffer.from(pending_turn.ai_commitment_base64, "base64")
    });

    const confirmed_turn: ai_duel_turn_document = {
      ...pending_turn,
      status: "open",
      tx_signature: input.tx_signature
    };
    const turns = [...existing_turns, confirmed_turn];
    const now = Date.now();

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          status: "open",
          open_tx_signature: input.tx_signature,
          pending_turn: null,
          turns,
          turn_count: turns.length,
          player_side: confirmed_turn.player_side,
          ai_side: confirmed_turn.ai_side,
          ai_decision_model: confirmed_turn.ai_decision_model ?? null,
          ai_decision_confidence:
            confirmed_turn.ai_decision_confidence === undefined
              ? null
              : confirmed_turn.ai_decision_confidence,
          ai_decision_rationale: confirmed_turn.ai_decision_rationale ?? null,
          ai_nonce_base64: confirmed_turn.ai_nonce_base64,
          ai_commitment_base64: confirmed_turn.ai_commitment_base64,
          updated_at_ms: now
        }
      }
    );

    return this.get_by_id(duel_document.id);
  }

  async prepare_append_turn_relay(input: {
    duel_record_id: string;
    wallet: string;
    player_side: decision_side;
    amount_lamports: number;
  }): Promise<{
    transaction_base64: string;
    blockhash: string;
    last_valid_block_height: number;
    fee_payer: string;
    market_pda: string;
    round_pda: string;
    house_bankroll_pda: string;
    ai_duel_pda: string;
    turn_index: number;
  }> {
    await this.mongo.ensure_ready();

    if (input.player_side !== "yes" && input.player_side !== "no") {
      throw new app_error("playerSide must be yes or no", 400);
    }
    if (!Number.isInteger(input.amount_lamports) || input.amount_lamports <= 0) {
      throw new app_error("amountLamports must be a positive integer", 400);
    }
    if (input.amount_lamports > env.AI_DUEL_MAX_STAKE_LAMPORTS) {
      throw new app_error(
        `amountLamports exceeds cap of ${env.AI_DUEL_MAX_STAKE_LAMPORTS}`,
        400
      );
    }

    await this.expire_stale_prepared_duels();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.player_wallet !== input.wallet) {
      throw new app_error("unauthorized", 403);
    }
    if (duel_document.status !== "open") {
      throw new app_error("ai duel is not open", 409);
    }
    if (duel_document.pending_turn) {
      throw new app_error("ai duel has a pending turn awaiting confirmation", 409);
    }

    const turns = duel_document.turns ?? [];
    if (turns.length <= 0) {
      throw new app_error("duel has no confirmed opening turn", 409);
    }
    if (turns.length >= env.AI_DUEL_MAX_TURNS_PER_DUEL) {
      throw new app_error(
        `duel turn cap exceeded (${turns.length} >= ${env.AI_DUEL_MAX_TURNS_PER_DUEL})`,
        409
      );
    }

    const round_document = await this.mongo.rounds_collection.findOne({ id: duel_document.round_id });
    if (!round_document) {
      throw new app_error("round not found for ai duel", 404);
    }
    if (round_document.status !== "predicting") {
      throw new app_error("round is not open for ai duel", 409);
    }
    if (Date.now() >= Number(round_document.close_at_ms)) {
      throw new app_error("round is closed", 409);
    }

    const market_item = await this.get_market_or_throw(duel_document.market_slug);
    await this.ensure_round_delegated(market_item.market_index, Number(duel_document.round_number));
    await this.assert_open_exposure_limits({
      wallet: input.wallet,
      market_slug: market_item.slug,
      round_id: round_document.id,
      additional_amount_lamports: input.amount_lamports,
      increment_open_duel_count: false
    });

    const [recent_resolved_rounds, recent_user_overall_duels, recent_user_market_duels] = await Promise.all([
      this.mongo.rounds_collection
        .find({
          market_slug: market_item.slug,
          status: "resolved",
          settlement_price: { $ne: null }
        })
        .sort({ close_at_ms: -1 })
        .limit(recent_market_rounds_limit)
        .toArray(),
      this.mongo.ai_duels_collection
        .find({
          player_wallet: input.wallet,
          status: "settled",
          outcome: { $in: ["player_win", "house_win", "push"] }
        })
        .sort({ created_at_ms: -1 })
        .limit(recent_user_overall_duels_limit)
        .toArray(),
      this.mongo.ai_duels_collection
        .find({
          player_wallet: input.wallet,
          market_slug: market_item.slug,
          status: "settled",
          outcome: { $in: ["player_win", "house_win", "push"] }
        })
        .sort({ created_at_ms: -1 })
        .limit(recent_user_market_duels_limit)
        .toArray()
    ]);

    const recent_user_performance = {
      overall: this.summarize_user_performance(recent_user_overall_duels),
      market: this.summarize_user_performance(recent_user_market_duels)
    };

    const ai_decision = await this.ai_decision.decide_side({
      wallet: input.wallet,
      market: market_item,
      round: round_document,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      recent_user_performance,
      recent_resolved_rounds
    });

    const turn_index = turns.length;
    const nonce = randomBytes(32);
    const ai_commitment = this.build_ai_commitment({
      duel_id: Number(duel_document.duel_id),
      turn_index,
      player_wallet: duel_document.player_wallet,
      market_pda: duel_document.market_pda,
      round_pda: duel_document.round_pda,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_side: ai_decision.side,
      nonce
    });

    const prepared = await this.chain_admin.prepare_append_ai_duel_turn_transaction({
      user_wallet: input.wallet,
      market_index: market_item.market_index,
      round_number: Number(duel_document.round_number),
      duel_id: Number(duel_document.duel_id),
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_commitment
    });

    const pending_turn: ai_duel_turn_document = {
      turn_index,
      player_side: input.player_side,
      ai_side: ai_decision.side,
      amount_lamports: input.amount_lamports,
      ai_decision_model: ai_decision.model,
      ai_decision_confidence: ai_decision.confidence,
      ai_decision_rationale: ai_decision.rationale,
      ai_nonce_base64: nonce.toString("base64"),
      ai_commitment_base64: Buffer.from(ai_commitment).toString("base64"),
      status: "prepared",
      tx_signature: null,
      created_at_ms: Date.now()
    };

    const current_total_amount = Number(duel_document.amount_lamports ?? 0);
    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          pending_turn,
          amount_lamports: current_total_amount + input.amount_lamports,
          turn_count: turns.length,
          updated_at_ms: Date.now()
        }
      }
    );

    return {
      transaction_base64: prepared.transaction_base64,
      blockhash: prepared.blockhash,
      last_valid_block_height: prepared.last_valid_block_height,
      fee_payer: prepared.fee_payer,
      market_pda: prepared.market_pda,
      round_pda: prepared.round_pda,
      house_bankroll_pda: prepared.house_bankroll_pda,
      ai_duel_pda: prepared.ai_duel_pda,
      turn_index
    };
  }

  async confirm_append_turn(input: {
    duel_record_id: string;
    wallet: string;
    tx_signature: string;
  }): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.player_wallet !== input.wallet) {
      throw new app_error("unauthorized", 403);
    }
    if (duel_document.status !== "open") {
      throw new app_error("ai duel is not open", 409);
    }

    const pending_turn = duel_document.pending_turn;
    if (!pending_turn || pending_turn.status !== "prepared") {
      return this.get_by_id(duel_document.id);
    }

    await this.chain_admin.verify_append_ai_duel_turn_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_market_pda: duel_document.market_pda,
      expected_round_pda: duel_document.round_pda,
      expected_house_bankroll_pda: duel_document.house_bankroll_pda,
      expected_ai_duel_pda: duel_document.ai_duel_pda,
      expected_duel_id: Number(duel_document.duel_id),
      expected_player_side: pending_turn.player_side,
      expected_amount_lamports: Number(pending_turn.amount_lamports),
      expected_ai_commitment: Buffer.from(pending_turn.ai_commitment_base64, "base64")
    });

    const confirmed_turn: ai_duel_turn_document = {
      ...pending_turn,
      status: "open",
      tx_signature: input.tx_signature
    };
    const turns: ai_duel_turn_document[] = [...(duel_document.turns ?? []), confirmed_turn];

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          pending_turn: null,
          turns,
          turn_count: turns.length,
          player_side: pending_turn.player_side,
          ai_side: pending_turn.ai_side,
          ai_decision_model: pending_turn.ai_decision_model ?? null,
          ai_decision_confidence:
            pending_turn.ai_decision_confidence === undefined
              ? null
              : pending_turn.ai_decision_confidence,
          ai_decision_rationale: pending_turn.ai_decision_rationale ?? null,
          ai_nonce_base64: pending_turn.ai_nonce_base64,
          ai_commitment_base64: pending_turn.ai_commitment_base64,
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(duel_document.id);
  }

  async reveal_and_settle(input: {
    duel_record_id: string;
    wallet: string;
  }): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    const admin_wallet = this.chain_admin.get_admin_public_key().toBase58();
    if (input.wallet !== duel_document.player_wallet && input.wallet !== admin_wallet) {
      throw new app_error("unauthorized", 403);
    }
    if (duel_document.status === "settled") {
      return this.get_by_id(duel_document.id);
    }
    if (duel_document.status !== "open" && duel_document.status !== "revealed") {
      throw new app_error("ai duel is not open", 409);
    }
    if (duel_document.pending_turn) {
      throw new app_error("ai duel has a pending turn awaiting confirmation", 409);
    }

    const turns = this.get_confirmed_turns(duel_document);
    if (turns.length <= 0) {
      throw new app_error("ai duel has no confirmed turns", 409);
    }

    const market_item = await this.get_market_or_throw(duel_document.market_slug);
    const round_document = await this.mongo.rounds_collection.findOne({ id: duel_document.round_id });
    if (!round_document) {
      throw new app_error("round not found for ai duel", 404);
    }

    let winning_side = round_document.winning_side;
    if (round_document.status !== "resolved" || !winning_side) {
      const snapshot = await this.chain_admin.get_round_snapshot({
        market_index: market_item.market_index,
        round_number: Number(duel_document.round_number)
      });
      if (!snapshot || snapshot.status !== "resolved" || !snapshot.winning_side) {
        throw new app_error("round is not resolved yet", 409);
      }
      winning_side = snapshot.winning_side;
    }

    await this.ensure_undelegated(duel_document.ai_duel_pda, {
      kind: "ai_duel",
      market: new PublicKey(duel_document.market_pda),
      player: new PublicKey(duel_document.player_wallet),
      duel_id: Number(duel_document.duel_id)
    });
    await this.ensure_undelegated(duel_document.house_bankroll_pda, {
      kind: "house_bankroll",
      admin: this.chain_admin.get_admin_public_key()
    });

    const settle_tx_signature = await this.chain_admin.settle_ai_duel({
      market_index: market_item.market_index,
      player_wallet: duel_document.player_wallet,
      duel_id: Number(duel_document.duel_id),
      round_number: Number(duel_document.round_number),
      ai_sides: turns.map((turn) => turn.ai_side),
      nonces: turns.map((turn) => Buffer.from(turn.ai_nonce_base64, "base64"))
    });

    const total_amount_lamports = turns.reduce(
      (sum, turn) => sum + Number(turn.amount_lamports),
      0
    );
    const resolved = this.resolve_duel_outcome({
      turns,
      winning_side,
      total_amount_lamports
    });

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          status: "settled",
          outcome: resolved.outcome,
          player_payout_lamports: resolved.player_payout_lamports,
          reveal_tx_signature: duel_document.reveal_tx_signature ?? null,
          settle_tx_signature,
          pending_turn: null,
          turn_count: turns.length,
          amount_lamports: total_amount_lamports,
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(duel_document.id);
  }

  async prepare_claim_relay(input: {
    duel_record_id: string;
    wallet: string;
  }): Promise<{
    transaction_base64: string;
    blockhash: string;
    last_valid_block_height: number;
    fee_payer: string;
    ai_duel_pda: string;
  }> {
    await this.mongo.ensure_ready();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.player_wallet !== input.wallet) {
      throw new app_error("unauthorized", 403);
    }
    if (duel_document.status !== "settled") {
      throw new app_error("ai duel is not settled", 409);
    }
    if (duel_document.claimed_at_ms) {
      throw new app_error("payout already claimed", 409);
    }
    if (!duel_document.player_payout_lamports || duel_document.player_payout_lamports <= 0) {
      throw new app_error("no payout available", 409);
    }

    const market_item = await this.get_market_or_throw(duel_document.market_slug);
    return this.chain_admin.prepare_claim_ai_duel_payout_transaction({
      user_wallet: input.wallet,
      market_index: market_item.market_index,
      duel_id: Number(duel_document.duel_id)
    });
  }

  async confirm_claim(input: {
    duel_record_id: string;
    wallet: string;
    tx_signature: string;
  }): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.player_wallet !== input.wallet) {
      throw new app_error("unauthorized", 403);
    }
    if (duel_document.claimed_at_ms) {
      return this.get_by_id(duel_document.id);
    }

    await this.chain_admin.verify_claim_ai_duel_payout_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_ai_duel_pda: duel_document.ai_duel_pda
    });

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          claim_tx_signature: input.tx_signature,
          claimed_at_ms: Date.now(),
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(duel_document.id);
  }

  private build_ai_commitment(input: {
    duel_id: number;
    turn_index: number;
    player_wallet: string;
    market_pda: string;
    round_pda: string;
    player_side: decision_side;
    amount_lamports: number;
    ai_side: decision_side;
    nonce: Buffer;
  }): Buffer {
    const duel_id_le = Buffer.alloc(8);
    duel_id_le.writeBigUInt64LE(BigInt(input.duel_id), 0);
    const turn_index_le = Buffer.alloc(2);
    turn_index_le.writeUInt16LE(input.turn_index & 0xffff, 0);

    const player_side = Buffer.from([this.side_to_raw(input.player_side)]);
    const amount_lamports_le = Buffer.alloc(8);
    amount_lamports_le.writeBigUInt64LE(BigInt(input.amount_lamports), 0);
    const side = Buffer.from([this.side_to_raw(input.ai_side)]);

    return createHash("sha256")
      .update(ai_duel_commit_domain)
      .update(duel_id_le)
      .update(new PublicKey(input.player_wallet).toBuffer())
      .update(new PublicKey(input.market_pda).toBuffer())
      .update(new PublicKey(input.round_pda).toBuffer())
      .update(turn_index_le)
      .update(player_side)
      .update(amount_lamports_le)
      .update(side)
      .update(input.nonce)
      .digest();
  }

  private resolve_duel_outcome(input: {
    turns: ai_duel_turn_document[];
    winning_side: decision_side;
    total_amount_lamports: number;
  }): {
    outcome: ai_duel_outcome;
    player_payout_lamports: number;
  } {
    let player_payout_lamports = 0;
    for (const turn of input.turns) {
      player_payout_lamports += this.resolve_duel_turn_player_payout_lamports({
        player_side: turn.player_side,
        ai_side: turn.ai_side,
        winning_side: input.winning_side,
        amount_lamports: Number(turn.amount_lamports)
      });
    }

    if (player_payout_lamports > input.total_amount_lamports) {
      return {
        outcome: "player_win",
        player_payout_lamports
      };
    }

    if (player_payout_lamports < input.total_amount_lamports) {
      return {
        outcome: "house_win",
        player_payout_lamports
      };
    }

    return {
      outcome: "push",
      player_payout_lamports
    };
  }

  private resolve_duel_turn_player_payout_lamports(input: {
    player_side: decision_side;
    ai_side: decision_side;
    winning_side: decision_side;
    amount_lamports: number;
  }): number {
    const player_correct = input.player_side === input.winning_side;
    const ai_correct = input.ai_side === input.winning_side;

    if (player_correct && !ai_correct) {
      return input.amount_lamports * 2;
    }
    if (ai_correct && !player_correct) {
      return 0;
    }
    return input.amount_lamports;
  }

  private side_to_raw(side: decision_side): number {
    if (side === "yes") {
      return 0;
    }
    if (side === "no") {
      return 1;
    }
    return 2;
  }

  private summarize_user_performance(rows: ai_duel_document[]): ai_user_performance_summary {
    if (rows.length === 0) {
      return {
        sample_size: 0,
        player_wins: 0,
        house_wins: 0,
        pushes: 0,
        player_win_rate_ex_push: null,
        avg_stake_lamports: null,
        avg_player_roi_pct: null,
        recent_outcomes: []
      };
    }

    let player_wins = 0;
    let house_wins = 0;
    let pushes = 0;
    let total_stake = 0;
    let total_roi_pct = 0;
    let roi_count = 0;

    for (const row of rows) {
      if (row.outcome === "player_win") {
        player_wins += 1;
      } else if (row.outcome === "house_win") {
        house_wins += 1;
      } else if (row.outcome === "push") {
        pushes += 1;
      }

      const amount = Number(row.amount_lamports);
      total_stake += amount;

      const payout = row.player_payout_lamports === null ? null : Number(row.player_payout_lamports);
      if (amount > 0 && payout !== null) {
        total_roi_pct += ((payout - amount) / amount) * 100;
        roi_count += 1;
      }
    }

    const decisive = player_wins + house_wins;
    const recent_outcomes = rows
      .slice(0, 6)
      .map((row) => row.outcome)
      .filter((outcome): outcome is "player_win" | "house_win" | "push" => outcome !== null);

    return {
      sample_size: rows.length,
      player_wins,
      house_wins,
      pushes,
      player_win_rate_ex_push: decisive > 0 ? player_wins / decisive : null,
      avg_stake_lamports: total_stake / rows.length,
      avg_player_roi_pct: roi_count > 0 ? total_roi_pct / roi_count : null,
      recent_outcomes
    };
  }

  private async assert_open_exposure_limits(input: {
    wallet: string;
    market_slug: string;
    round_id: string;
    additional_amount_lamports: number;
    increment_open_duel_count: boolean;
  }): Promise<void> {
    const [
      overall_exposure_rows,
      wallet_exposure_rows,
      market_exposure_rows,
      round_exposure_rows,
      total_open_duels_count,
      wallet_open_duels_count,
      bankroll_balance_lamports
    ] = await Promise.all([
      this.mongo.ai_duels_collection
        .aggregate<{ total_exposure_lamports: number }>([
          {
            $match: {
              status: { $in: active_duel_statuses }
            }
          },
          {
            $group: {
              _id: null,
              total_exposure_lamports: { $sum: "$amount_lamports" }
            }
          }
        ])
        .toArray(),
      this.mongo.ai_duels_collection
        .aggregate<{ wallet_exposure_lamports: number }>([
          {
            $match: {
              status: { $in: active_duel_statuses },
              player_wallet: input.wallet
            }
          },
          {
            $group: {
              _id: null,
              wallet_exposure_lamports: { $sum: "$amount_lamports" }
            }
          }
        ])
        .toArray(),
      this.mongo.ai_duels_collection
        .aggregate<{ market_exposure_lamports: number }>([
          {
            $match: {
              status: { $in: active_duel_statuses },
              market_slug: input.market_slug
            }
          },
          {
            $group: {
              _id: null,
              market_exposure_lamports: { $sum: "$amount_lamports" }
            }
          }
        ])
        .toArray(),
      this.mongo.ai_duels_collection
        .aggregate<{ round_exposure_lamports: number }>([
          {
            $match: {
              status: { $in: active_duel_statuses },
              round_id: input.round_id
            }
          },
          {
            $group: {
              _id: null,
              round_exposure_lamports: { $sum: "$amount_lamports" }
            }
          }
        ])
        .toArray(),
      this.mongo.ai_duels_collection.countDocuments({
        status: { $in: active_duel_statuses }
      }),
      this.mongo.ai_duels_collection.countDocuments({
        status: { $in: active_duel_statuses },
        player_wallet: input.wallet
      }),
      this.chain_admin.get_house_bankroll_balance_lamports()
    ]);

    const total_open_exposure_lamports = Number(overall_exposure_rows[0]?.total_exposure_lamports ?? 0);
    const wallet_open_exposure_lamports = Number(wallet_exposure_rows[0]?.wallet_exposure_lamports ?? 0);
    const market_open_exposure_lamports = Number(market_exposure_rows[0]?.market_exposure_lamports ?? 0);
    const round_open_exposure_lamports = Number(round_exposure_rows[0]?.round_exposure_lamports ?? 0);
    const projected_total_open_exposure_lamports = total_open_exposure_lamports + input.additional_amount_lamports;
    const projected_wallet_open_exposure_lamports = wallet_open_exposure_lamports + input.additional_amount_lamports;
    const projected_market_open_exposure_lamports = market_open_exposure_lamports + input.additional_amount_lamports;
    const projected_round_open_exposure_lamports = round_open_exposure_lamports + input.additional_amount_lamports;
    const duel_count_increment = input.increment_open_duel_count ? 1 : 0;
    const projected_total_open_duels_count = total_open_duels_count + duel_count_increment;
    const projected_wallet_open_duels_count = wallet_open_duels_count + duel_count_increment;

    if (projected_total_open_exposure_lamports > env.AI_DUEL_MAX_TOTAL_OPEN_EXPOSURE_LAMPORTS) {
      throw new app_error(
        `platform open exposure cap exceeded (${projected_total_open_exposure_lamports} > ${env.AI_DUEL_MAX_TOTAL_OPEN_EXPOSURE_LAMPORTS})`,
        409
      );
    }

    if (projected_market_open_exposure_lamports > env.AI_DUEL_MAX_MARKET_OPEN_EXPOSURE_LAMPORTS) {
      throw new app_error(
        `market open exposure cap exceeded (${projected_market_open_exposure_lamports} > ${env.AI_DUEL_MAX_MARKET_OPEN_EXPOSURE_LAMPORTS})`,
        409
      );
    }

    if (projected_round_open_exposure_lamports > env.AI_DUEL_MAX_ROUND_OPEN_EXPOSURE_LAMPORTS) {
      throw new app_error(
        `round open exposure cap exceeded (${projected_round_open_exposure_lamports} > ${env.AI_DUEL_MAX_ROUND_OPEN_EXPOSURE_LAMPORTS})`,
        409
      );
    }

    if (projected_wallet_open_exposure_lamports > env.AI_DUEL_MAX_WALLET_OPEN_EXPOSURE_LAMPORTS) {
      throw new app_error(
        `wallet open exposure cap exceeded (${projected_wallet_open_exposure_lamports} > ${env.AI_DUEL_MAX_WALLET_OPEN_EXPOSURE_LAMPORTS})`,
        409
      );
    }

    if (projected_total_open_duels_count > env.AI_DUEL_MAX_OPEN_DUELS_COUNT) {
      throw new app_error(
        `global open duel count cap exceeded (${projected_total_open_duels_count} > ${env.AI_DUEL_MAX_OPEN_DUELS_COUNT})`,
        409
      );
    }

    if (projected_wallet_open_duels_count > env.AI_DUEL_MAX_WALLET_OPEN_DUELS_COUNT) {
      throw new app_error(
        `wallet open duel count cap exceeded (${projected_wallet_open_duels_count} > ${env.AI_DUEL_MAX_WALLET_OPEN_DUELS_COUNT})`,
        409
      );
    }

    const required_bankroll_lamports = Math.ceil(
      (projected_total_open_exposure_lamports * env.AI_DUEL_REQUIRED_BANKROLL_COVERAGE_BPS) / 10_000
    );
    if (bankroll_balance_lamports < required_bankroll_lamports) {
      throw new app_error(
        `insufficient bankroll coverage (${bankroll_balance_lamports} < ${required_bankroll_lamports})`,
        409
      );
    }
  }

  private async expire_stale_prepared_duels(): Promise<void> {
    const now_ms = Date.now();
    const cutoff_ms = now_ms - env.AI_DUEL_PREPARED_TTL_SECONDS * 1000;
    await this.mongo.ai_duels_collection.updateMany(
      {
        status: "prepared",
        created_at_ms: { $lte: cutoff_ms }
      },
      {
        $set: {
          status: "cancelled",
          updated_at_ms: now_ms
        }
      }
    );

    const stale_pending_turn_duels = await this.mongo.ai_duels_collection
      .find({
        status: "open",
        pending_turn: { $ne: null },
        "pending_turn.status": "prepared",
        "pending_turn.created_at_ms": { $lte: cutoff_ms }
      })
      .limit(200)
      .toArray();

    for (const duel_document of stale_pending_turn_duels) {
      const pending_turn = duel_document.pending_turn;
      if (!pending_turn) {
        continue;
      }

      const next_total_amount_lamports = Math.max(
        0,
        Number(duel_document.amount_lamports ?? 0) - Number(pending_turn.amount_lamports ?? 0)
      );

      await this.mongo.ai_duels_collection.updateOne(
        { id: duel_document.id },
        {
          $set: {
            pending_turn: null,
            amount_lamports: next_total_amount_lamports,
            updated_at_ms: now_ms
          }
        }
      );
    }
  }

  private async allocate_duel_id(market_slug: string, wallet: string): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
      const existing = await this.mongo.ai_duels_collection.findOne({
        market_slug,
        player_wallet: wallet,
        duel_id: candidate
      });
      if (!existing) {
        return candidate;
      }
    }

    throw new app_error("failed allocating unique duel id", 500);
  }

  private require_admin_wallet(wallet: string): void {
    const admin_wallet = this.chain_admin.get_admin_public_key().toBase58();
    if (wallet !== admin_wallet) {
      throw new app_error("unauthorized", 403);
    }
  }

  private async get_market_or_throw(market_slug: string): Promise<market> {
    const market_item = await this.markets_service.get_by_slug(market_slug);
    if (!market_item) {
      throw new app_error("market not found", 404);
    }
    return market_item;
  }

  private async get_duel_or_throw(duel_record_id: string): Promise<ai_duel_document> {
    const duel_document = await this.mongo.ai_duels_collection.findOne({ id: duel_record_id });
    if (!duel_document) {
      throw new app_error("ai duel not found", 404);
    }
    return duel_document;
  }

  private async ensure_round_delegated(market_index: number, round_number: number): Promise<void> {
    const delegated = await this.chain_admin
      .is_round_delegated({ market_index, round_number })
      .catch(() => false);
    if (delegated) {
      return;
    }

    try {
      await this.chain_admin.delegate_round_account({ market_index, round_number });
    } catch (error) {
      const delegated_after_error = await this.chain_admin
        .is_round_delegated({ market_index, round_number })
        .catch(() => false);
      if (!delegated_after_error) {
        throw error;
      }
    }
  }

  private async ensure_delegated(pda: string, account_type: account_type): Promise<void> {
    const delegated = await this.chain_admin.is_pda_delegated(pda).catch(() => false);
    if (delegated) {
      return;
    }

    try {
      await this.chain_admin.delegate_account({ pda, account_type });
    } catch (error) {
      const delegated_after_error = await this.chain_admin
        .is_pda_delegated(pda)
        .catch(() => false);
      if (!delegated_after_error) {
        throw error;
      }
    }
  }

  private async ensure_undelegated(pda: string, account_type: account_type): Promise<void> {
    const delegated = await this.chain_admin.is_pda_delegated(pda).catch(() => false);
    if (!delegated) {
      return;
    }

    await this.chain_admin.commit_and_undelegate_account({
      pda,
      account_type
    });
  }

  private async hydrate_views(duel_documents: ai_duel_document[]): Promise<ai_duel_view[]> {
    if (duel_documents.length === 0) {
      return [];
    }

    const market_items = await this.markets_service.list(false);
    const market_map = new Map<string, market>();
    for (const market_item of market_items) {
      market_map.set(market_item.slug, market_item);
    }

    const views: ai_duel_view[] = [];
    for (const duel_document of duel_documents) {
      const market_item = market_map.get(duel_document.market_slug);
      if (!market_item) {
        continue;
      }
      views.push(this.to_view(duel_document, market_item));
    }

    return views;
  }

  private get_confirmed_turns(duel_document: ai_duel_document): ai_duel_turn_document[] {
    const turns = Array.isArray(duel_document.turns) ? duel_document.turns : [];
    if (turns.length > 0) {
      return [...turns].sort((a, b) => Number(a.turn_index) - Number(b.turn_index));
    }

    if (
      duel_document.player_side &&
      duel_document.ai_side &&
      duel_document.ai_nonce_base64 &&
      duel_document.ai_commitment_base64 &&
      Number(duel_document.amount_lamports) > 0
    ) {
      return [
        {
          turn_index: 0,
          player_side: duel_document.player_side,
          ai_side: duel_document.ai_side,
          amount_lamports: Number(duel_document.amount_lamports),
          ai_decision_model: duel_document.ai_decision_model ?? null,
          ai_decision_confidence: duel_document.ai_decision_confidence ?? null,
          ai_decision_rationale: duel_document.ai_decision_rationale ?? null,
          ai_nonce_base64: duel_document.ai_nonce_base64,
          ai_commitment_base64: duel_document.ai_commitment_base64,
          status: duel_document.status === "prepared" ? "prepared" : "open",
          tx_signature: duel_document.open_tx_signature,
          created_at_ms: Number(duel_document.created_at_ms)
        }
      ];
    }

    return [];
  }

  private to_turn_view(turn: ai_duel_turn_document): ai_duel_turn_view {
    return {
      turnIndex: Number(turn.turn_index),
      playerSide: turn.player_side,
      aiSide: turn.ai_side,
      amountLamports: Number(turn.amount_lamports),
      aiDecisionModel: turn.ai_decision_model ?? null,
      aiDecisionConfidence:
        turn.ai_decision_confidence === undefined || turn.ai_decision_confidence === null
          ? null
          : Number(turn.ai_decision_confidence),
      aiDecisionRationale: turn.ai_decision_rationale ?? null,
      status: turn.status,
      txSignature: turn.tx_signature ?? null,
      createdAtMs: Number(turn.created_at_ms)
    };
  }

  private to_view(duel_document: ai_duel_document, market_item: market): ai_duel_view {
    const turns = this.get_confirmed_turns(duel_document);
    const pending_turn = duel_document.pending_turn ?? null;
    const latest_turn = pending_turn ?? turns[turns.length - 1] ?? null;
    const latest_confidence =
      latest_turn?.ai_decision_confidence !== undefined
        ? latest_turn.ai_decision_confidence
        : duel_document.ai_decision_confidence;

    return {
      id: duel_document.id,
      market: market_item,
      marketPda: duel_document.market_pda,
      roundId: duel_document.round_id,
      roundNumber: Number(duel_document.round_number),
      roundPda: duel_document.round_pda,
      playerWallet: duel_document.player_wallet,
      duelId: Number(duel_document.duel_id),
      aiDuelPda: duel_document.ai_duel_pda,
      houseBankrollPda: duel_document.house_bankroll_pda,
      playerSide: latest_turn?.player_side ?? duel_document.player_side ?? "yes",
      aiSide: latest_turn?.ai_side ?? duel_document.ai_side ?? "no",
      aiDecisionModel: latest_turn?.ai_decision_model ?? duel_document.ai_decision_model ?? null,
      aiDecisionConfidence:
        latest_confidence === undefined || latest_confidence === null ? null : Number(latest_confidence),
      aiDecisionRationale: latest_turn?.ai_decision_rationale ?? duel_document.ai_decision_rationale ?? null,
      amountLamports: Number(duel_document.amount_lamports),
      turnCount: turns.length,
      totalAmountLamports: Number(duel_document.amount_lamports),
      pendingTurn: pending_turn ? this.to_turn_view(pending_turn) : null,
      turns: turns.map((turn) => this.to_turn_view(turn)),
      status: duel_document.status,
      outcome: duel_document.outcome,
      playerPayoutLamports:
        duel_document.player_payout_lamports === null
          ? null
          : Number(duel_document.player_payout_lamports),
      openTxSignature: duel_document.open_tx_signature,
      revealTxSignature: duel_document.reveal_tx_signature,
      settleTxSignature: duel_document.settle_tx_signature,
      claimTxSignature: duel_document.claim_tx_signature,
      claimedAtMs: duel_document.claimed_at_ms === null ? null : Number(duel_document.claimed_at_ms),
      createdAtMs: Number(duel_document.created_at_ms),
      updatedAtMs: Number(duel_document.updated_at_ms)
    };
  }
}
