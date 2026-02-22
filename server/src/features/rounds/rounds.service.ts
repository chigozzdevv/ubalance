import { app_error } from "@/shared/app-error";
import type {
  market_document,
  mongo_service,
  round_document
} from "@/shared/mongo";
import type { markets_service } from "@/features/markets/markets.service";
import type { market } from "@/features/markets/markets.model";
import type { oracle_service } from "@/features/oracle/oracle.service";
import { to_lamports_price, type chain_admin_service } from "@/features/chain/chain-admin.service";
import type { decision_side, round_action, round_view } from "@/features/rounds/rounds.model";
import { env } from "@/config/env";

const default_history_limit = 20;
const max_history_limit = 100;
const transition_batch_size = 4;
const delegation_scan_batch_size = 6;

export class rounds_service {
  private refresh_in_progress: Promise<void> | null = null;
  private last_refresh_started_at_ms = 0;

  constructor(
    private readonly mongo: mongo_service,
    private readonly markets_service: markets_service,
    private readonly oracle_service: oracle_service,
    private readonly chain_admin: chain_admin_service
  ) {}

  async bootstrap(): Promise<void> {
    await this.mongo.ensure_ready();
    await this.refresh_round_states();
  }

  async list_active(): Promise<round_view[]> {
    await this.mongo.ensure_ready();
    this.schedule_refresh();
    const rows = await this.mongo.rounds_collection.find({ status: "predicting" }).sort({ close_at_ms: -1 }).toArray();
    return this.hydrate_views(rows);
  }

  async list_history(limit = default_history_limit, market_slug?: string): Promise<round_view[]> {
    await this.mongo.ensure_ready();
    this.schedule_refresh();
    const safe_limit = Math.max(1, Math.min(limit, max_history_limit));
    const filter: Record<string, any> = { status: { $ne: "predicting" } };
    if (market_slug) {
      filter.market_slug = market_slug;
    }

    const rows = await this.mongo.rounds_collection
      .find(filter)
      .sort({ close_at_ms: -1 })
      .limit(safe_limit)
      .toArray();

    return this.hydrate_views(rows);
  }

  async get_by_id(round_id: string): Promise<round_view> {
    await this.mongo.ensure_ready();
    this.schedule_refresh();
    const round_document = await this.mongo.rounds_collection.findOne({ id: round_id });
    if (!round_document) {
      throw new app_error("round not found", 404);
    }

    const market_document = await this.mongo.markets_collection.findOne({ slug: round_document.market_slug });
    if (!market_document) {
      throw new app_error("market not found", 404);
    }

    return this.to_view(round_document, market_document);
  }

  async upsert_action(
    round_id: string,
    wallet: string,
    side: decision_side,
    amount_lamports: number,
    tx_signature: string | null
  ): Promise<{ action: round_action; round: round_view }> {
    await this.mongo.ensure_ready();
    this.schedule_refresh();

    const round_document = await this.mongo.rounds_collection.findOne({ id: round_id });
    if (!round_document) {
      throw new app_error("round not found", 404);
    }
    if (round_document.status !== "predicting" || Date.now() >= Number(round_document.close_at_ms)) {
      throw new app_error("round is locked", 409);
    }

    if (amount_lamports < 0) {
      throw new app_error("amount must be positive", 400);
    }
    if (side !== "skip" && amount_lamports <= 0) {
      throw new app_error("amount must be greater than zero for yes/no", 400);
    }

    const amount_to_store = side === "skip" ? 0 : amount_lamports;
    const action_id = `${round_id}:${wallet}`;
    const existing_action = await this.mongo.round_actions_collection.findOne({ _id: action_id });
    const now = Date.now();

    await this.mongo.round_actions_collection.updateOne(
      { _id: action_id },
      {
        $set: {
          round_id,
          wallet,
          side,
          amount_lamports: amount_to_store,
          tx_signature,
          updated_at_ms: now
        },
        $setOnInsert: {
          _id: action_id
        }
      },
      { upsert: true }
    );

    let yes_delta = 0;
    let no_delta = 0;
    let skip_delta = 0;
    let action_delta = 0;

    if (existing_action) {
      if (existing_action.side === "yes") {
        yes_delta -= existing_action.amount_lamports;
      } else if (existing_action.side === "no") {
        no_delta -= existing_action.amount_lamports;
      } else {
        skip_delta -= 1;
      }
    } else {
      action_delta = 1;
    }

    if (side === "yes") {
      yes_delta += amount_to_store;
    } else if (side === "no") {
      no_delta += amount_to_store;
    } else {
      skip_delta += 1;
    }

    const increment_fields: Record<string, number> = {};
    if (yes_delta !== 0) {
      increment_fields["totals.yes_lamports"] = yes_delta;
    }
    if (no_delta !== 0) {
      increment_fields["totals.no_lamports"] = no_delta;
    }
    if (skip_delta !== 0) {
      increment_fields["totals.skip_count"] = skip_delta;
    }
    if (action_delta !== 0) {
      increment_fields["totals.action_count"] = action_delta;
    }

    const round_update: Record<string, any> = {
      $set: {
        updated_at_ms: now
      }
    };

    if (Object.keys(increment_fields).length > 0) {
      round_update.$inc = increment_fields;
    }

    await this.mongo.rounds_collection.updateOne({ id: round_id }, round_update);

    return {
      action: {
        wallet,
        side,
        amount_lamports: amount_to_store,
        updated_at_ms: now
      },
      round: await this.get_by_id(round_id)
    };
  }

  private async refresh_round_states(): Promise<void> {
    if (this.refresh_in_progress) {
      await this.refresh_in_progress;
      return;
    }

    this.refresh_in_progress = this.refresh_round_states_internal().finally(() => {
      this.refresh_in_progress = null;
    });

    await this.refresh_in_progress;
  }

  private schedule_refresh(): void {
    const now = Date.now();
    if (this.refresh_in_progress) {
      return;
    }
    if (now - this.last_refresh_started_at_ms < 3_000) {
      return;
    }

    this.last_refresh_started_at_ms = now;
    this.refresh_in_progress = this.refresh_round_states_internal()
      .catch((error) => {
        console.error("failed refreshing round states", error);
      })
      .finally(() => {
        this.refresh_in_progress = null;
      });
  }

  private async refresh_round_states_internal(): Promise<void> {
    await this.ensure_predicting_rounds();
    await this.lock_expired_rounds();
    await this.resolve_expired_rounds();
    await this.ensure_predicting_rounds();
  }

  private async ensure_predicting_rounds(): Promise<void> {
    const markets = await this.markets_service.list(true);

    for (const market_item of markets) {
      try {
        const count = await this.mongo.rounds_collection.countDocuments({
          market_slug: market_item.slug,
          status: "predicting"
        });

        if (count === 0) {
          const recovered = await this.recover_chain_predicting_round(market_item);
          if (!recovered) {
            await this.create_new_round(market_item);
          }
        }

        await this.ensure_market_rounds_delegated(market_item);
      } catch (error) {
        console.error(`failed ensuring predicting round for ${market_item.slug}`, error);
      }
    }
  }

  private async create_new_round(market_item: market): Promise<void> {
    const open_at_ms = Date.now();
    const close_at_ms = open_at_ms + market_item.timeframe_minutes * 60_000;
    const reference_price = await this.oracle_service.get_latest_price(market_item.oracle_symbol);

    const opened = await this.chain_admin.open_round({
      market_index: market_item.market_index,
      reference_price,
      open_at_ms,
      close_at_ms
    });
    const round_id = `${market_item.slug}-${opened.round_number}`;

    const now = Date.now();

    await this.mongo.rounds_collection.insertOne({
      _id: round_id,
      id: round_id,
      market_slug: market_item.slug,
      market_pda: opened.market_pda,
      round_number: opened.round_number,
      round_pda: opened.round_pda,
      status: "predicting",
      reference_price,
      settlement_price: null,
      winning_side: null,
      open_at_ms,
      close_at_ms,
      locked_at_ms: null,
      resolve_at_ms: null,
      open_tx_signature: opened.open_tx_signature,
      lock_tx_signature: null,
      resolve_tx_signature: null,
      totals: {
        yes_lamports: 0,
        no_lamports: 0,
        skip_count: 0,
        action_count: 0
      },
      created_at_ms: now,
      updated_at_ms: now
    });

    await this.ensure_round_delegated(market_item.market_index, opened.round_number);
  }

  private async recover_chain_predicting_round(market_item: market): Promise<boolean> {
    const snapshot = await this.chain_admin.get_latest_round_snapshot(market_item.market_index);
    if (!snapshot || snapshot.status !== "predicting") {
      return false;
    }

    const round_id = `${market_item.slug}-${snapshot.round_number}`;
    const existing_round = await this.mongo.rounds_collection.findOne({ id: round_id });
    if (existing_round) {
      return true;
    }

    const now = Date.now();

    await this.mongo.rounds_collection.insertOne({
      _id: round_id,
      id: round_id,
      market_slug: market_item.slug,
      market_pda: snapshot.market_pda,
      round_number: snapshot.round_number,
      round_pda: snapshot.round_pda,
      status: "predicting",
      reference_price: snapshot.reference_price,
      settlement_price: null,
      winning_side: null,
      open_at_ms: snapshot.open_at_ms,
      close_at_ms: snapshot.close_at_ms,
      locked_at_ms: null,
      resolve_at_ms: null,
      open_tx_signature: null,
      lock_tx_signature: null,
      resolve_tx_signature: null,
      totals: {
        yes_lamports: 0,
        no_lamports: 0,
        skip_count: 0,
        action_count: 0
      },
      created_at_ms: now,
      updated_at_ms: now
    });

    await this.ensure_round_delegated(market_item.market_index, snapshot.round_number);

    return true;
  }

  private async ensure_market_rounds_delegated(market_item: market): Promise<void> {
    const predicting_rounds = await this.mongo.rounds_collection
      .find({ market_slug: market_item.slug, status: "predicting" })
      .sort({ round_number: -1 })
      .limit(delegation_scan_batch_size)
      .toArray();

    for (const row of predicting_rounds) {
      try {
        await this.ensure_round_delegated(market_item.market_index, Number(row.round_number));
      } catch (error) {
        console.error(`failed ensuring delegation for ${row.id}`, error);
      }
    }
  }

  private async ensure_round_delegated(market_index: number, round_number: number): Promise<void> {
    const delegated = await this.chain_admin.is_round_delegated({ market_index, round_number });
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

  private async lock_expired_rounds(): Promise<void> {
    const now = Date.now();
    const expired_rounds = await this.mongo.rounds_collection
      .find({ status: "predicting", close_at_ms: { $lte: now } })
      .sort({ close_at_ms: 1 })
      .limit(transition_batch_size)
      .toArray();

    for (const row of expired_rounds) {
      try {
        const market_index = await this.get_market_index(row.market_slug);
        const delegated = await this.chain_admin.is_round_delegated({
          market_index,
          round_number: Number(row.round_number)
        });

        if (delegated) {
          try {
            await this.chain_admin.commit_and_undelegate_round({
              market_index,
              round_number: Number(row.round_number)
            });
          } catch (error) {
            const delegated_after_error = await this.chain_admin
              .is_round_delegated({ market_index, round_number: Number(row.round_number) })
              .catch(() => false);
            if (delegated_after_error) {
              throw error;
            }
          }
        }

        const lock_tx_signature = await this.chain_admin.lock_round({
          market_index,
          round_number: Number(row.round_number)
        });

        const locked_at_ms = Date.now();
        const resolve_at_ms = locked_at_ms + env.ROUND_RESOLVE_DELAY_SECONDS * 1000;

        await this.mongo.rounds_collection.updateOne(
          { id: row.id, status: "predicting" },
          {
            $set: {
              status: "locked",
              locked_at_ms,
              resolve_at_ms,
              lock_tx_signature,
              updated_at_ms: locked_at_ms
            }
          }
        );
      } catch (error) {
        if (this.is_invalid_state_error(error)) {
          await this.reconcile_round_state_from_chain(row).catch(() => undefined);
          continue;
        }
        console.error(`failed locking round ${row.id}`, error);
      }
    }
  }

  private async resolve_expired_rounds(): Promise<void> {
    const now = Date.now();
    const locked_rounds = await this.mongo.rounds_collection
      .find({
        status: "locked",
        resolve_at_ms: { $ne: null, $lte: now }
      })
      .sort({ resolve_at_ms: 1 })
      .limit(transition_batch_size)
      .toArray();

    for (const row of locked_rounds) {
      try {
        const market_document = await this.mongo.markets_collection.findOne({ slug: row.market_slug });
        if (!market_document) {
          throw new app_error(`market not found for round ${row.id}`, 404);
        }

        const settlement_price = await this.oracle_service.get_price_near_timestamp(
          market_document.oracle_symbol,
          Number(row.close_at_ms)
        );
        const winning_side = this.determine_winning_side(Number(row.reference_price), settlement_price);

        const resolve_tx_signature = await this.chain_admin.resolve_round({
          market_index: Number(market_document.market_index),
          round_number: Number(row.round_number),
          settlement_price
        });

        const updated_at_ms = Date.now();
        await this.mongo.rounds_collection.updateOne(
          { id: row.id, status: "locked" },
          {
            $set: {
              status: "resolved",
              settlement_price,
              winning_side,
              resolve_tx_signature,
              updated_at_ms
            }
          }
        );
      } catch (error) {
        if (this.is_invalid_state_error(error)) {
          await this.reconcile_round_state_from_chain(row).catch(() => undefined);
          continue;
        }
        console.error(`failed resolving round ${row.id}`, error);
      }
    }
  }

  private is_invalid_state_error(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return message.includes("Error Code: InvalidState") || message.includes("custom program error: 0x1771");
  }

  private async reconcile_round_state_from_chain(row: round_document): Promise<void> {
    const market_index = await this.get_market_index(row.market_slug);
    const snapshot = await this.chain_admin.get_round_snapshot({
      market_index,
      round_number: Number(row.round_number)
    });
    if (!snapshot) {
      return;
    }

    const now = Date.now();
    const base_set: Record<string, unknown> = {
      market_pda: snapshot.market_pda,
      round_pda: snapshot.round_pda,
      status: snapshot.status,
      reference_price: snapshot.reference_price,
      settlement_price: snapshot.settlement_price,
      winning_side: snapshot.winning_side,
      open_at_ms: snapshot.open_at_ms,
      close_at_ms: snapshot.close_at_ms,
      updated_at_ms: now
    };

    if (snapshot.status === "predicting") {
      base_set.locked_at_ms = null;
      base_set.resolve_at_ms = null;
    } else if (snapshot.status === "locked") {
      base_set.locked_at_ms = row.locked_at_ms ?? now;
      base_set.resolve_at_ms = row.resolve_at_ms ?? now + env.ROUND_RESOLVE_DELAY_SECONDS * 1000;
    } else {
      base_set.locked_at_ms = row.locked_at_ms ?? now;
      base_set.resolve_at_ms = row.resolve_at_ms ?? now;
    }

    await this.mongo.rounds_collection.updateOne(
      { id: row.id },
      {
        $set: base_set
      }
    );
  }

  private async hydrate_views(round_documents: round_document[]): Promise<round_view[]> {
    if (round_documents.length === 0) {
      return [];
    }

    const market_slugs = [...new Set(round_documents.map((round_document) => round_document.market_slug))];
    const market_documents = await this.mongo.markets_collection
      .find({ slug: { $in: market_slugs } })
      .toArray();

    const market_by_slug = new Map<string, market_document>();
    for (const market_document of market_documents) {
      market_by_slug.set(market_document.slug, market_document);
    }

    return round_documents
      .map((round_document) => {
        const market_document = market_by_slug.get(round_document.market_slug);
        if (!market_document) {
          return null;
        }
        return this.to_view(round_document, market_document);
      })
      .filter((round): round is round_view => round !== null);
  }

  private to_view(round_document: round_document, market_document: market_document): round_view {
    return {
      id: round_document.id,
      market: {
        slug: market_document.slug,
        display_name: market_document.display_name,
        base_symbol: market_document.base_symbol,
        quote_symbol: market_document.quote_symbol,
        oracle_symbol: market_document.oracle_symbol,
        timeframe_minutes: Number(market_document.timeframe_minutes),
        category: market_document.category as market["category"],
        active: Boolean(market_document.active),
        market_index: Number(market_document.market_index),
        market_pda: market_document.market_pda
      },
      marketPda: round_document.market_pda,
      roundNumber: Number(round_document.round_number),
      roundPda: round_document.round_pda,
      status: round_document.status,
      referencePrice: Number(round_document.reference_price),
      settlementPrice:
        round_document.settlement_price === null ? null : Number(round_document.settlement_price),
      winningSide: round_document.winning_side,
      openAtMs: Number(round_document.open_at_ms),
      closeAtMs: Number(round_document.close_at_ms),
      lockedAtMs: round_document.locked_at_ms === null ? null : Number(round_document.locked_at_ms),
      resolveAtMs: round_document.resolve_at_ms === null ? null : Number(round_document.resolve_at_ms),
      openTxSignature: round_document.open_tx_signature,
      lockTxSignature: round_document.lock_tx_signature,
      resolveTxSignature: round_document.resolve_tx_signature,
      totals: {
        yesLamports: Number(round_document.totals.yes_lamports),
        noLamports: Number(round_document.totals.no_lamports),
        skipCount: Number(round_document.totals.skip_count),
        actionCount: Number(round_document.totals.action_count)
      }
    };
  }

  private determine_winning_side(reference_price: number, settlement_price: number): decision_side {
    const normalized_reference_price = to_lamports_price(reference_price);
    const normalized_settlement_price = to_lamports_price(settlement_price);

    if (normalized_settlement_price > normalized_reference_price) {
      return "yes";
    }
    if (normalized_settlement_price < normalized_reference_price) {
      return "no";
    }
    return "skip";
  }

  private async get_market_index(market_slug: string): Promise<number> {
    const market_document = await this.mongo.markets_collection.findOne({ slug: market_slug });
    if (!market_document) {
      throw new app_error(`market not found for slug ${market_slug}`, 404);
    }
    return Number(market_document.market_index);
  }
}
