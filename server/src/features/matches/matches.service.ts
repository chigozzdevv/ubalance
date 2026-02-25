import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type {
  match_document,
  match_entry_document,
  mongo_service
} from "@/shared/mongo";
import type { markets_service } from "@/features/markets/markets.service";
import type { market } from "@/features/markets/markets.model";
import type { chain_admin_service } from "@/features/chain/chain-admin.service";
import { PublicKey } from "@solana/web3.js";
import type { account_type } from "@/features/chain/ubalance-program";
import type {
  match_access_mode,
  match_status,
  match_view
} from "@/features/matches/matches.model";

const max_list_limit = 100;
const max_match_scoring_rounds = 256;
const max_open_matches_per_creator = 5;
const min_private_join_code_length = 4;
const max_private_join_code_length = 64;

export class matches_service {
  constructor(
    private readonly mongo: mongo_service,
    private readonly markets_service: markets_service,
    private readonly chain_admin: chain_admin_service
  ) {}

  async list(input?: {
    status?: match_status;
    market_slug?: string;
    limit?: number;
  }): Promise<match_view[]> {
    await this.mongo.ensure_ready();

    const safe_limit = Math.max(1, Math.min(input?.limit ?? 20, max_list_limit));
    const filter: Record<string, unknown> = {};
    if (input?.status) {
      filter.status = input.status;
    }
    if (input?.market_slug) {
      filter.market_slug = input.market_slug;
    }

    const rows = await this.mongo.matches_collection
      .find(filter)
      .sort({ end_at_ms: -1 })
      .limit(safe_limit)
      .toArray();

    return this.hydrate_views(rows);
  }

  async get_by_id(match_id: string): Promise<match_view> {
    await this.mongo.ensure_ready();

    const match_document = await this.mongo.matches_collection.findOne({ id: match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }

    const market_item = await this.get_market_or_throw(match_document.market_slug);
    return this.to_view(match_document, market_item);
  }

  async create_match(input: {
    creator_wallet: string;
    market_slug: string;
    buy_in_lamports: number;
    max_players: number;
    start_at_ms: number;
    end_at_ms: number;
    access_mode?: match_access_mode;
    join_code?: string;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();
    if (!input.creator_wallet || input.creator_wallet.length < 32) {
      throw new app_error("invalid creator wallet", 400);
    }

    const market_item = await this.get_market_or_throw(input.market_slug);
    if (!market_item.active) {
      throw new app_error("market is inactive", 409);
    }
    if (!Number.isInteger(input.buy_in_lamports) || input.buy_in_lamports <= 0) {
      throw new app_error("buyInLamports must be a positive integer", 400);
    }
    if (!Number.isInteger(input.max_players) || input.max_players < 2 || input.max_players > 100) {
      throw new app_error("maxPlayers must be between 2 and 100", 400);
    }
    if (!Number.isFinite(input.start_at_ms) || !Number.isFinite(input.end_at_ms)) {
      throw new app_error("startAtMs and endAtMs are required", 400);
    }
    const access_mode = input.access_mode ?? "public";
    if (access_mode !== "public" && access_mode !== "private") {
      throw new app_error("accessMode must be public or private", 400);
    }
    const normalized_join_code = this.normalize_join_code(input.join_code);
    if (access_mode === "private" && !normalized_join_code) {
      throw new app_error("joinCode is required for private matches", 400);
    }
    if (access_mode === "public" && normalized_join_code) {
      throw new app_error("joinCode can only be set for private matches", 400);
    }
    if (input.end_at_ms <= input.start_at_ms) {
      throw new app_error("endAtMs must be greater than startAtMs", 400);
    }
    if (input.end_at_ms <= Date.now()) {
      throw new app_error("endAtMs must be in the future", 400);
    }
    const timeframe_ms = Number(market_item.timeframe_minutes) * 60_000;
    if (!Number.isFinite(timeframe_ms) || timeframe_ms <= 0) {
      throw new app_error("market timeframe is invalid", 409);
    }
    const duration_ms = input.end_at_ms - input.start_at_ms;
    const worst_case_scoring_round_count = Math.ceil(duration_ms / timeframe_ms) + 2;
    if (worst_case_scoring_round_count > max_match_scoring_rounds) {
      throw new app_error(
        `match duration is too long for scoring window cap (${max_match_scoring_rounds} rounds max)`,
        400
      );
    }
    const creator_open_match_count = await this.mongo.matches_collection.countDocuments({
      created_by_wallet: input.creator_wallet,
      status: { $in: ["open", "locked"] }
    });
    if (creator_open_match_count >= max_open_matches_per_creator) {
      throw new app_error(
        `open match limit reached (${max_open_matches_per_creator})`,
        409
      );
    }

    const match_id_numeric = await this.allocate_match_id(input.market_slug);
    const chain_created = await this.chain_admin.create_match({
      market_index: market_item.market_index,
      match_id: match_id_numeric,
      buy_in_lamports: input.buy_in_lamports,
      max_players: input.max_players,
      start_at_ms: input.start_at_ms,
      end_at_ms: input.end_at_ms
    });

    const match_pda = chain_created.match_pda;
    await this.ensure_delegated(match_pda, {
      kind: "match",
      market: this.chain_admin.derive_market_pda(market_item.market_index),
      match_id: match_id_numeric
    });

    const now = Date.now();
    const id = `${input.market_slug}-${match_id_numeric}`;
    const private_join_code_secret =
      access_mode === "private" && normalized_join_code
        ? this.build_private_join_code_secret(normalized_join_code)
        : null;

    await this.mongo.matches_collection.insertOne({
      _id: id,
      id,
      market_slug: input.market_slug,
      access_mode,
      private_join_code_hash: private_join_code_secret?.hash_hex ?? null,
      private_join_code_salt: private_join_code_secret?.salt_hex ?? null,
      market_pda: market_item.market_pda,
      match_id: match_id_numeric,
      match_pda,
      buy_in_lamports: input.buy_in_lamports,
      max_players: input.max_players,
      player_count: 0,
      pot_lamports: 0,
      winner_count: 0,
      highest_score: 0,
      created_by_wallet: input.creator_wallet,
      start_at_ms: input.start_at_ms,
      end_at_ms: input.end_at_ms,
      status: "open",
      create_tx_signature: chain_created.create_tx_signature,
      lock_tx_signature: null,
      finalize_tx_signature: null,
      cancel_tx_signature: null,
      created_at_ms: now,
      updated_at_ms: now
    });

    return this.get_by_id(id);
  }

  async prepare_join_relay(input: {
    match_id: string;
    wallet: string;
    join_code?: string;
  }): Promise<{
    transaction_base64: string;
    blockhash: string;
    last_valid_block_height: number;
    fee_payer: string;
    match_pda: string;
    match_entry_pda: string;
  }> {
    await this.mongo.ensure_ready();

    const match_document = await this.get_open_match_or_throw(input.match_id);
    this.assert_private_join_authorized(match_document, input.wallet, input.join_code);
    if (match_document.player_count >= match_document.max_players) {
      throw new app_error("match is at capacity", 409);
    }
    const existing_entry = await this.mongo.match_entries_collection.findOne({
      match_id: match_document.id,
      wallet: input.wallet,
      joined: true
    });
    if (existing_entry) {
      throw new app_error("wallet already joined this match", 409);
    }

    const market_item = await this.get_market_or_throw(match_document.market_slug);

    await this.ensure_delegated(match_document.match_pda, {
      kind: "match",
      market: this.chain_admin.derive_market_pda(market_item.market_index),
      match_id: Number(match_document.match_id)
    });

    const prepared = await this.chain_admin.prepare_join_match_transaction({
      user_wallet: input.wallet,
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });

    return prepared;
  }

  async confirm_join(input: {
    match_id: string;
    wallet: string;
    tx_signature: string;
    join_code?: string;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();

    const match_document = await this.get_open_match_or_throw(input.match_id);
    this.assert_private_join_authorized(match_document, input.wallet, input.join_code);
    const market_item = await this.get_market_or_throw(match_document.market_slug);
    const match_entry_pda = this.chain_admin
      .derive_match_entry_pda(market_item.market_index, Number(match_document.match_id), input.wallet)
      .toBase58();

    await this.chain_admin.verify_join_match_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_match_pda: match_document.match_pda,
      expected_match_entry_pda: match_entry_pda
    });

    const entry_id = `${match_document.id}:${input.wallet}`;
    const existing_entry = await this.mongo.match_entries_collection.findOne({ _id: entry_id });
    const now = Date.now();

    await this.mongo.match_entries_collection.updateOne(
      { _id: entry_id },
      {
        $set: {
          match_id: match_document.id,
          match_pda: match_document.match_pda,
          wallet: input.wallet,
          match_entry_pda,
          buy_in_lamports: match_document.buy_in_lamports,
          score: existing_entry?.score ?? null,
          is_winner: existing_entry?.is_winner ?? null,
          result_recorded: existing_entry?.result_recorded ?? false,
          joined: true,
          claimed: existing_entry?.claimed ?? false,
          join_tx_signature: input.tx_signature,
          claim_tx_signature: existing_entry?.claim_tx_signature ?? null,
          joined_at_ms: existing_entry?.joined_at_ms ?? now,
          claimed_at_ms: existing_entry?.claimed_at_ms ?? null,
          updated_at_ms: now
        },
        $setOnInsert: {
          _id: entry_id
        }
      },
      { upsert: true }
    );

    const match_snapshot = await this.chain_admin.get_match_snapshot({
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });
    const fallback_player_count = match_document.player_count + (existing_entry ? 0 : 1);
    const fallback_pot_lamports = match_document.pot_lamports + (existing_entry ? 0 : match_document.buy_in_lamports);
    await this.mongo.matches_collection.updateOne(
      { id: match_document.id },
      {
        $set: {
          player_count: match_snapshot ? match_snapshot.player_count : fallback_player_count,
          pot_lamports: match_snapshot ? match_snapshot.pot_lamports : fallback_pot_lamports,
          updated_at_ms: now
        }
      }
    );

    return this.get_by_id(match_document.id);
  }

  async finalize_match(input: {
    admin_wallet: string;
    match_id: string;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    const match_document = await this.mongo.matches_collection.findOne({ id: input.match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }
    if (match_document.status === "resolved") {
      return this.get_by_id(match_document.id);
    }
    if (match_document.status === "cancelled") {
      throw new app_error("match is cancelled", 409);
    }
    if (Date.now() < match_document.end_at_ms) {
      throw new app_error("match has not ended yet", 409);
    }

    const market_item = await this.get_market_or_throw(match_document.market_slug);
    const entries = await this.mongo.match_entries_collection
      .find({ match_id: match_document.id, joined: true })
      .toArray();
    if (entries.length === 0) {
      throw new app_error("no joined players in match", 409);
    }

    const scoring_round_numbers_by_wallet = await this.compute_scoring_round_numbers_from_chain({
      match_document,
      market_item,
      entries
    });

    await this.ensure_undelegated(match_document.match_pda, {
      kind: "match",
      market: this.chain_admin.derive_market_pda(market_item.market_index),
      match_id: Number(match_document.match_id)
    });

    for (const entry of entries) {
      await this.ensure_undelegated(entry.match_entry_pda, {
        kind: "match_entry",
        match_account: new PublicKey(match_document.match_pda),
        player: new PublicKey(entry.wallet)
      });
    }

    let lock_tx_signature: string | null = match_document.lock_tx_signature;
    if (match_document.status === "open") {
      lock_tx_signature = await this.chain_admin.lock_match({
        market_index: market_item.market_index,
        match_id: Number(match_document.match_id)
      });
    }

    for (const entry of entries) {
      try {
        await this.chain_admin.set_match_entry_result({
          market_index: market_item.market_index,
          match_id: Number(match_document.match_id),
          player_wallet: entry.wallet,
          scoring_round_numbers: scoring_round_numbers_by_wallet.get(entry.wallet) ?? []
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (message.includes("Error Code: MatchResultAlreadyRecorded") || message.includes("Error Code: MatchResultsComplete")) {
          continue;
        }
        throw error;
      }
    }

    const finalize_tx_signature = await this.chain_admin.finalize_match({
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });

    const chain_match_snapshot = await this.chain_admin.get_match_snapshot({
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });
    if (!chain_match_snapshot || chain_match_snapshot.status !== "resolved") {
      throw new app_error("on-chain match is not resolved after finalize", 502);
    }

    const entry_snapshots = await this.chain_admin.get_match_entry_snapshots({
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id),
      player_wallets: entries.map((entry) => entry.wallet)
    });

    const now = Date.now();

    await this.mongo.matches_collection.updateOne(
      { id: match_document.id },
      {
        $set: {
          status: "resolved",
          lock_tx_signature: lock_tx_signature,
          finalize_tx_signature,
          winner_count: chain_match_snapshot.winner_count,
          highest_score: chain_match_snapshot.highest_score,
          updated_at_ms: now
        }
      }
    );

    for (const entry of entries) {
      const snapshot = entry_snapshots.get(entry.wallet);
      if (!snapshot) {
        throw new app_error(`missing on-chain match entry snapshot for ${entry.wallet}`, 502);
      }
      const is_winner =
        snapshot.result_recorded &&
        chain_match_snapshot.winner_count > 0 &&
        snapshot.score === chain_match_snapshot.highest_score;
      await this.mongo.match_entries_collection.updateOne(
        { _id: `${match_document.id}:${entry.wallet}` },
        {
          $set: {
            score: snapshot.score,
            is_winner: is_winner,
            result_recorded: snapshot.result_recorded,
            updated_at_ms: now
          }
        }
      );
    }

    return this.get_by_id(match_document.id);
  }

  async cancel_match(input: {
    admin_wallet: string;
    match_id: string;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

    const match_document = await this.mongo.matches_collection.findOne({ id: input.match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }
    if (match_document.status === "cancelled") {
      return this.get_by_id(match_document.id);
    }
    if (match_document.status === "resolved") {
      throw new app_error("match already resolved", 409);
    }

    const market_item = await this.get_market_or_throw(match_document.market_slug);

    await this.ensure_undelegated(match_document.match_pda, {
      kind: "match",
      market: this.chain_admin.derive_market_pda(market_item.market_index),
      match_id: Number(match_document.match_id)
    });

    const entries = await this.mongo.match_entries_collection
      .find({ match_id: match_document.id, joined: true })
      .toArray();
    for (const entry of entries) {
      await this.ensure_undelegated(entry.match_entry_pda, {
        kind: "match_entry",
        match_account: new PublicKey(match_document.match_pda),
        player: new PublicKey(entry.wallet)
      });
    }

    const cancel_tx_signature = await this.chain_admin.cancel_match({
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });

    await this.mongo.matches_collection.updateOne(
      { id: match_document.id },
      {
        $set: {
          status: "cancelled",
          cancel_tx_signature,
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(match_document.id);
  }

  async prepare_claim_relay(input: {
    match_id: string;
    wallet: string;
  }): Promise<{
    transaction_base64: string;
    blockhash: string;
    last_valid_block_height: number;
    fee_payer: string;
    match_pda: string;
    match_entry_pda: string;
  }> {
    await this.mongo.ensure_ready();

    const match_document = await this.mongo.matches_collection.findOne({ id: input.match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }
    if (match_document.status !== "resolved" && match_document.status !== "cancelled") {
      throw new app_error("match is not claimable yet", 409);
    }

    const entry = await this.mongo.match_entries_collection.findOne({
      match_id: match_document.id,
      wallet: input.wallet,
      joined: true
    });
    if (!entry) {
      throw new app_error("match entry not found", 404);
    }
    if (entry.claimed) {
      throw new app_error("payout already claimed", 409);
    }

    const market_item = await this.get_market_or_throw(match_document.market_slug);
    return this.chain_admin.prepare_claim_match_payout_transaction({
      user_wallet: input.wallet,
      market_index: market_item.market_index,
      match_id: Number(match_document.match_id)
    });
  }

  async confirm_claim(input: {
    match_id: string;
    wallet: string;
    tx_signature: string;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();

    const match_document = await this.mongo.matches_collection.findOne({ id: input.match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }

    const entry = await this.mongo.match_entries_collection.findOne({
      match_id: match_document.id,
      wallet: input.wallet,
      joined: true
    });
    if (!entry) {
      throw new app_error("match entry not found", 404);
    }
    if (entry.claimed) {
      return this.get_by_id(match_document.id);
    }

    await this.chain_admin.verify_claim_match_payout_transaction({
      tx_signature: input.tx_signature,
      expected_wallet: input.wallet,
      expected_match_pda: match_document.match_pda,
      expected_match_entry_pda: entry.match_entry_pda
    });

    await this.mongo.match_entries_collection.updateOne(
      { _id: entry._id },
      {
        $set: {
          claimed: true,
          claim_tx_signature: input.tx_signature,
          claimed_at_ms: Date.now(),
          updated_at_ms: Date.now()
        }
      }
    );

    return this.get_by_id(match_document.id);
  }

  private async compute_scoring_round_numbers_from_chain(input: {
    match_document: match_document;
    market_item: market;
    entries: match_entry_document[];
  }): Promise<Map<string, number[]>> {
    const round_statuses = await this.chain_admin.get_round_statuses_in_window({
      market_index: input.market_item.market_index,
      start_at_ms: Number(input.match_document.start_at_ms),
      end_at_ms: Number(input.match_document.end_at_ms)
    });

    if (round_statuses.length === 0) {
      throw new app_error("no rounds found on-chain in match window", 409);
    }
    const unresolved_round_numbers = round_statuses
      .filter((round_status) => round_status.status !== "resolved")
      .map((round_status) => round_status.round_number);
    if (unresolved_round_numbers.length > 0) {
      const preview = unresolved_round_numbers.slice(0, 6).join(", ");
      const suffix = unresolved_round_numbers.length > 6 ? ", ..." : "";
      throw new app_error(
        `waiting for all rounds to resolve before finalize (pending: ${preview}${suffix})`,
        409
      );
    }
    const resolved_round_numbers = round_statuses.map((round_status) => round_status.round_number);

    if (resolved_round_numbers.length === 0) {
      throw new app_error("no resolved rounds found on-chain in match window", 409);
    }
    if (resolved_round_numbers.length > max_match_scoring_rounds) {
      throw new app_error(
        `resolved rounds exceed on-chain scoring cap (${resolved_round_numbers.length} > ${max_match_scoring_rounds})`,
        409
      );
    }

    const scoring_round_numbers_by_wallet = new Map<string, number[]>();
    for (const entry of input.entries) {
      const scoring_round_numbers = await this.chain_admin.get_wallet_scoring_round_numbers({
        market_index: input.market_item.market_index,
        wallet: entry.wallet,
        round_numbers: resolved_round_numbers
      });
      scoring_round_numbers_by_wallet.set(entry.wallet, scoring_round_numbers);
    }

    return scoring_round_numbers_by_wallet;
  }

  private async allocate_match_id(market_slug: string): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
      const existing = await this.mongo.matches_collection.findOne({
        market_slug,
        match_id: candidate
      });
      if (!existing) {
        return candidate;
      }
    }

    throw new app_error("failed allocating unique match id", 500);
  }

  private require_admin_wallet(wallet: string): void {
    const admin_wallet = this.chain_admin.get_admin_public_key().toBase58();
    if (wallet !== admin_wallet) {
      throw new app_error("unauthorized", 403);
    }
  }

  private async get_open_match_or_throw(match_id: string): Promise<match_document> {
    const match_document = await this.mongo.matches_collection.findOne({ id: match_id });
    if (!match_document) {
      throw new app_error("match not found", 404);
    }
    if (match_document.status !== "open") {
      throw new app_error("match is not open", 409);
    }
    const now = Date.now();
    if (now >= match_document.start_at_ms || now >= match_document.end_at_ms) {
      throw new app_error("match already started", 409);
    }
    return match_document;
  }

  private async get_market_or_throw(market_slug: string): Promise<market> {
    const market_item = await this.markets_service.get_by_slug(market_slug);
    if (!market_item) {
      throw new app_error("market not found", 404);
    }
    return market_item;
  }

  private async ensure_delegated(match_pda: string, account_type: account_type): Promise<void> {
    const delegated = await this.chain_admin.is_pda_delegated(match_pda);
    if (delegated) {
      return;
    }

    try {
      await this.chain_admin.delegate_account({
        pda: match_pda,
        account_type
      });
    } catch (error) {
      const delegated_after_error = await this.chain_admin
        .is_pda_delegated(match_pda)
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

  private async hydrate_views(match_documents: match_document[]): Promise<match_view[]> {
    if (match_documents.length === 0) {
      return [];
    }

    const market_map = new Map<string, market>();
    const market_items = await this.markets_service.list(false);
    for (const market_item of market_items) {
      market_map.set(market_item.slug, market_item);
    }

    const match_ids = match_documents.map((match_document) => match_document.id);
    const entry_documents = await this.mongo.match_entries_collection
      .find({ match_id: { $in: match_ids } })
      .sort({ joined_at_ms: 1 })
      .toArray();

    const entries_by_match = new Map<string, match_entry_document[]>();
    for (const entry of entry_documents) {
      const existing = entries_by_match.get(entry.match_id) ?? [];
      existing.push(entry);
      entries_by_match.set(entry.match_id, existing);
    }

    const views: match_view[] = [];
    for (const row of match_documents) {
      const market_item = market_map.get(row.market_slug);
      if (!market_item) {
        continue;
      }
      views.push(this.to_view(row, market_item, entries_by_match.get(row.id) ?? []));
    }

    return views;
  }

  private to_view(
    match_document: match_document,
    market_item: market,
    entries: match_entry_document[] = []
  ): match_view {
    const access_mode = match_document.access_mode === "private" ? "private" : "public";
    return {
      id: match_document.id,
      createdByWallet: match_document.created_by_wallet ?? null,
      accessMode: access_mode,
      requiresJoinCode: access_mode === "private",
      market: market_item,
      marketPda: match_document.market_pda,
      matchId: Number(match_document.match_id),
      matchPda: match_document.match_pda,
      buyInLamports: Number(match_document.buy_in_lamports),
      maxPlayers: Number(match_document.max_players),
      playerCount: Number(match_document.player_count),
      potLamports: Number(match_document.pot_lamports),
      winnerCount: Number(match_document.winner_count),
      highestScore: Number(match_document.highest_score),
      startAtMs: Number(match_document.start_at_ms),
      endAtMs: Number(match_document.end_at_ms),
      status: match_document.status,
      createTxSignature: match_document.create_tx_signature,
      lockTxSignature: match_document.lock_tx_signature,
      finalizeTxSignature: match_document.finalize_tx_signature,
      cancelTxSignature: match_document.cancel_tx_signature,
      createdAtMs: Number(match_document.created_at_ms),
      updatedAtMs: Number(match_document.updated_at_ms),
      entries: entries.map((entry) => ({
        wallet: entry.wallet,
        matchEntryPda: entry.match_entry_pda,
        buyInLamports: Number(entry.buy_in_lamports),
        joined: Boolean(entry.joined),
        score: entry.score === null ? null : Number(entry.score),
        isWinner: entry.is_winner,
        resultRecorded: Boolean(entry.result_recorded),
        claimed: Boolean(entry.claimed),
        joinedAtMs: Number(entry.joined_at_ms),
        claimedAtMs: entry.claimed_at_ms === null ? null : Number(entry.claimed_at_ms)
      }))
    };
  }

  private assert_private_join_authorized(
    match_document: match_document,
    wallet: string,
    provided_join_code?: string
  ): void {
    const access_mode = match_document.access_mode === "private" ? "private" : "public";
    if (access_mode !== "private") {
      return;
    }
    if (match_document.created_by_wallet && wallet === match_document.created_by_wallet) {
      return;
    }

    const expected_hash = match_document.private_join_code_hash ?? "";
    const salt_hex = match_document.private_join_code_salt ?? "";
    if (!expected_hash || !salt_hex) {
      throw new app_error("private match is misconfigured", 500);
    }

    const normalized_join_code = this.normalize_join_code(provided_join_code);
    if (!normalized_join_code) {
      throw new app_error("joinCode is required for this private match", 403);
    }

    const candidate_hash = this.hash_private_join_code(normalized_join_code, salt_hex);
    if (!this.safe_hex_equal(expected_hash, candidate_hash)) {
      throw new app_error("invalid joinCode", 403);
    }
  }

  private normalize_join_code(code?: string | null): string | null {
    if (!code) {
      return null;
    }
    const normalized = code.trim();
    if (!normalized) {
      return null;
    }
    if (normalized.length < min_private_join_code_length || normalized.length > max_private_join_code_length) {
      throw new app_error(
        `joinCode must be between ${min_private_join_code_length} and ${max_private_join_code_length} characters`,
        400
      );
    }
    return normalized;
  }

  private build_private_join_code_secret(normalized_join_code: string): {
    salt_hex: string;
    hash_hex: string;
  } {
    const salt_hex = randomBytes(16).toString("hex");
    const hash_hex = this.hash_private_join_code(normalized_join_code, salt_hex);
    return { salt_hex, hash_hex };
  }

  private hash_private_join_code(normalized_join_code: string, salt_hex: string): string {
    return createHash("sha256")
      .update(`${salt_hex}:${env.MATCH_JOIN_CODE_PEPPER}:${normalized_join_code}`)
      .digest("hex");
  }

  private safe_hex_equal(expected_hex: string, candidate_hex: string): boolean {
    try {
      const expected_buffer = Buffer.from(expected_hex, "hex");
      const candidate_buffer = Buffer.from(candidate_hex, "hex");
      if (expected_buffer.length === 0 || expected_buffer.length !== candidate_buffer.length) {
        return false;
      }
      return timingSafeEqual(expected_buffer, candidate_buffer);
    } catch {
      return false;
    }
  }
}
