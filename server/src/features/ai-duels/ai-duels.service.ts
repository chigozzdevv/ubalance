import { createHash, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type {
  ai_duel_document,
  mongo_service
} from "@/shared/mongo";
import type { markets_service } from "@/features/markets/markets.service";
import type { market } from "@/features/markets/markets.model";
import type { chain_admin_service } from "@/features/chain/chain-admin.service";
import type { decision_side } from "@/features/rounds/rounds.model";
import type { ai_duel_outcome, ai_duel_status, ai_duel_view } from "@/features/ai-duels/ai-duels.model";
import type { account_type } from "@/features/chain/ubalance-program";
import type { ai_decision_service } from "@/features/ai-duels/ai-decision.service";

const ai_duel_commit_domain = Buffer.from("ubalance-ai-duel", "utf8");
const max_list_limit = 100;

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

    const duel_id = await this.allocate_duel_id(market_item.slug, input.wallet);
    const recent_resolved_rounds = await this.mongo.rounds_collection
      .find({
        market_slug: market_item.slug,
        status: "resolved",
        settlement_price: { $ne: null }
      })
      .sort({ close_at_ms: -1 })
      .limit(20)
      .toArray();

    const ai_decision = await this.ai_decision.decide_side({
      wallet: input.wallet,
      market: market_item,
      round: round_document,
      recent_resolved_rounds
    });

    const ai_side = ai_decision.side;
    const nonce = randomBytes(32);
    const ai_commitment = this.build_ai_commitment({
      duel_id,
      player_wallet: input.wallet,
      market_pda: round_document.market_pda,
      round_pda: round_document.round_pda,
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
          player_side: input.player_side,
          ai_side,
          ai_decision_model: ai_decision.model,
          ai_decision_confidence: ai_decision.confidence,
          ai_decision_rationale: ai_decision.rationale,
          ai_nonce_base64: nonce.toString("base64"),
          ai_commitment_base64: Buffer.from(ai_commitment).toString("base64"),
          amount_lamports: input.amount_lamports,
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
    if (duel_document.status === "open") {
      return this.get_by_id(duel_document.id);
    }
    if (duel_document.status !== "prepared") {
      throw new app_error("ai duel is not in prepared state", 409);
    }

    await this.chain_admin.verify_open_ai_duel_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_market_pda: duel_document.market_pda,
      expected_round_pda: duel_document.round_pda,
      expected_house_bankroll_pda: duel_document.house_bankroll_pda,
      expected_ai_duel_pda: duel_document.ai_duel_pda,
      expected_duel_id: Number(duel_document.duel_id),
      expected_player_side: duel_document.player_side,
      expected_amount_lamports: Number(duel_document.amount_lamports),
      expected_ai_commitment: Buffer.from(duel_document.ai_commitment_base64, "base64")
    });

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          status: "open",
          open_tx_signature: input.tx_signature,
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(duel_document.id);
  }

  async reveal_and_settle(input: {
    duel_record_id: string;
    admin_wallet: string;
  }): Promise<ai_duel_view> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    const duel_document = await this.get_duel_or_throw(input.duel_record_id);
    if (duel_document.status === "settled") {
      return this.get_by_id(duel_document.id);
    }
    if (duel_document.status !== "open" && duel_document.status !== "revealed") {
      throw new app_error("ai duel is not open", 409);
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

    const ai_side = duel_document.ai_side;
    const nonce = Buffer.from(duel_document.ai_nonce_base64, "base64");

    let reveal_tx_signature = duel_document.reveal_tx_signature;
    if (!reveal_tx_signature) {
      reveal_tx_signature = await this.chain_admin.reveal_ai_duel({
        market_index: market_item.market_index,
        player_wallet: duel_document.player_wallet,
        duel_id: Number(duel_document.duel_id),
        ai_side,
        nonce
      });
    }

    const settle_tx_signature = await this.chain_admin.settle_ai_duel({
      market_index: market_item.market_index,
      player_wallet: duel_document.player_wallet,
      duel_id: Number(duel_document.duel_id),
      round_number: Number(duel_document.round_number)
    });

    const resolved = this.resolve_duel_outcome({
      player_side: duel_document.player_side,
      ai_side,
      winning_side,
      amount_lamports: Number(duel_document.amount_lamports)
    });

    await this.mongo.ai_duels_collection.updateOne(
      { id: duel_document.id },
      {
        $set: {
          status: "settled",
          outcome: resolved.outcome,
          player_payout_lamports: resolved.player_payout_lamports,
          reveal_tx_signature,
          settle_tx_signature,
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
    player_wallet: string;
    market_pda: string;
    round_pda: string;
    ai_side: decision_side;
    nonce: Buffer;
  }): Buffer {
    const duel_id_le = Buffer.alloc(8);
    duel_id_le.writeBigUInt64LE(BigInt(input.duel_id), 0);

    const side = Buffer.from([this.side_to_raw(input.ai_side)]);

    return createHash("sha256")
      .update(ai_duel_commit_domain)
      .update(duel_id_le)
      .update(new PublicKey(input.player_wallet).toBuffer())
      .update(new PublicKey(input.market_pda).toBuffer())
      .update(new PublicKey(input.round_pda).toBuffer())
      .update(side)
      .update(input.nonce)
      .digest();
  }

  private resolve_duel_outcome(input: {
    player_side: decision_side;
    ai_side: decision_side;
    winning_side: decision_side;
    amount_lamports: number;
  }): {
    outcome: ai_duel_outcome;
    player_payout_lamports: number;
  } {
    const player_correct = input.player_side === input.winning_side;
    const ai_correct = input.ai_side === input.winning_side;

    if (player_correct && !ai_correct) {
      return {
        outcome: "player_win",
        player_payout_lamports: input.amount_lamports * 2
      };
    }

    if (ai_correct && !player_correct) {
      return {
        outcome: "house_win",
        player_payout_lamports: 0
      };
    }

    return {
      outcome: "push",
      player_payout_lamports: input.amount_lamports
    };
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

  private to_view(duel_document: ai_duel_document, market_item: market): ai_duel_view {
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
      playerSide: duel_document.player_side,
      aiSide: duel_document.ai_side,
      aiDecisionModel: duel_document.ai_decision_model ?? null,
      aiDecisionConfidence:
        duel_document.ai_decision_confidence === undefined || duel_document.ai_decision_confidence === null
          ? null
          : Number(duel_document.ai_decision_confidence),
      aiDecisionRationale: duel_document.ai_decision_rationale ?? null,
      amountLamports: Number(duel_document.amount_lamports),
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
