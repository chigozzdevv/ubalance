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
  match_status,
  match_view
} from "@/features/matches/matches.model";

const max_list_limit = 100;

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
    admin_wallet: string;
    market_slug: string;
    buy_in_lamports: number;
    max_players: number;
    start_at_ms: number;
    end_at_ms: number;
  }): Promise<match_view> {
    await this.mongo.ensure_ready();
    this.require_admin_wallet(input.admin_wallet);

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
    if (input.end_at_ms <= input.start_at_ms) {
      throw new app_error("endAtMs must be greater than startAtMs", 400);
    }
    if (input.end_at_ms <= Date.now()) {
      throw new app_error("endAtMs must be in the future", 400);
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

    await this.mongo.matches_collection.insertOne({
      _id: id,
      id,
      market_slug: input.market_slug,
      market_pda: market_item.market_pda,
      match_id: match_id_numeric,
      match_pda,
      buy_in_lamports: input.buy_in_lamports,
      max_players: input.max_players,
      player_count: 0,
      pot_lamports: 0,
      winner_count: 0,
      highest_score: 0,
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
  }): Promise<match_view> {
    await this.mongo.ensure_ready();

    const match_document = await this.get_open_match_or_throw(input.match_id);
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

    if (!existing_entry) {
      await this.mongo.matches_collection.updateOne(
        { id: match_document.id },
        {
          $inc: {
            player_count: 1,
            pot_lamports: match_document.buy_in_lamports
          },
          $set: {
            updated_at_ms: now
          }
        }
      );
    }

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

    const normalized_results = await this.compute_results_from_resolved_round_actions({
      match_document,
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

    for (const result of normalized_results) {
      try {
        await this.chain_admin.set_match_entry_result({
          market_index: market_item.market_index,
          match_id: Number(match_document.match_id),
          player_wallet: result.wallet,
          scoring_round_numbers: result.scoring_round_numbers
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

    const winner_count = normalized_results.filter((result) => result.is_winner).length;
    const highest_score = normalized_results.reduce((highest, result) => Math.max(highest, result.score), 0);
    const now = Date.now();

    await this.mongo.matches_collection.updateOne(
      { id: match_document.id },
      {
        $set: {
          status: "resolved",
          lock_tx_signature: lock_tx_signature,
          finalize_tx_signature,
          winner_count,
          highest_score,
          updated_at_ms: now
        }
      }
    );

    for (const result of normalized_results) {
      await this.mongo.match_entries_collection.updateOne(
        { _id: `${match_document.id}:${result.wallet}` },
        {
          $set: {
            score: result.score,
            is_winner: result.is_winner,
            result_recorded: true,
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

  private async compute_results_from_resolved_round_actions(input: {
    match_document: match_document;
    entries: match_entry_document[];
  }): Promise<Array<{ wallet: string; score: number; is_winner: boolean; scoring_round_numbers: number[] }>> {
    const match_rounds = await this.mongo.rounds_collection
      .find({
        market_slug: input.match_document.market_slug,
        status: "resolved",
        close_at_ms: {
          $gte: input.match_document.start_at_ms,
          $lte: input.match_document.end_at_ms
        }
      })
      .project<{ id: string; round_number: number; winning_side: "yes" | "no" | "skip" | null }>({
        id: 1,
        round_number: 1,
        winning_side: 1
      })
      .toArray();

    if (match_rounds.length === 0) {
      throw new app_error("no resolved rounds found in match window", 409);
    }

    const round_ids = match_rounds.map((row) => row.id);
    const wallets = input.entries.map((entry) => entry.wallet);
    const winning_side_by_round = new Map<string, "yes" | "no" | "skip" | null>(
      match_rounds.map((row) => [row.id, row.winning_side])
    );
    const round_number_by_id = new Map<string, number>(match_rounds.map((row) => [row.id, Number(row.round_number)]));

    const round_actions = await this.mongo.round_actions_collection
      .find({
        round_id: { $in: round_ids },
        wallet: { $in: wallets },
        tx_signature: { $ne: null }
      })
      .project<{ round_id: string; wallet: string; side: "yes" | "no" | "skip" }>({
        round_id: 1,
        wallet: 1,
        side: 1
      })
      .toArray();

    if (round_actions.length === 0) {
      throw new app_error("no verified round actions found for this match window", 409);
    }

    const score_by_wallet = new Map<string, number>();
    const scoring_rounds_by_wallet = new Map<string, Set<number>>();
    for (const entry of input.entries) {
      score_by_wallet.set(entry.wallet, 0);
      scoring_rounds_by_wallet.set(entry.wallet, new Set<number>());
    }

    for (const action of round_actions) {
      const round_number = round_number_by_id.get(action.round_id);
      if (round_number && Number.isInteger(round_number) && round_number > 0) {
        scoring_rounds_by_wallet.get(action.wallet)?.add(round_number);
      }
      const winning_side = winning_side_by_round.get(action.round_id);
      if (!winning_side || winning_side === "skip") {
        continue;
      }
      if (action.side !== winning_side) {
        continue;
      }
      const next_score = (score_by_wallet.get(action.wallet) ?? 0) + 1;
      if (next_score > 65535) {
        throw new app_error("computed score exceeds supported range", 500);
      }
      score_by_wallet.set(action.wallet, next_score);
    }

    const normalized = input.entries.map((entry) => ({
      wallet: entry.wallet,
      score: score_by_wallet.get(entry.wallet) ?? 0,
      is_winner: false,
      scoring_round_numbers: [...(scoring_rounds_by_wallet.get(entry.wallet) ?? new Set<number>())].sort((a, b) => a - b)
    }));

    const highest_score = normalized.reduce((highest, row) => Math.max(highest, row.score), 0);
    for (const row of normalized) {
      row.is_winner = row.score === highest_score;
    }

    const winner_count = normalized.filter((row) => row.is_winner).length;
    if (winner_count === 0) {
      throw new app_error("at least one winner is required", 500);
    }

    return normalized;
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
    return {
      id: match_document.id,
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
}
