import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import {
  create_append_ai_duel_turn_instruction,
  create_cancel_match_instruction,
  create_claim_ai_duel_payout_instruction,
  create_claim_match_payout_instruction,
  create_claim_payout_instruction,
  create_commit_and_undelegate_pda_instruction,
  create_commit_and_undelegate_round_instruction,
  create_create_match_instruction,
  create_finalize_match_instruction,
  create_fund_house_bankroll_instruction,
  create_init_house_bankroll_instruction,
  create_init_market_oracle_instruction,
  create_initialize_market_instruction,
  create_join_match_instruction,
  create_lock_match_instruction,
  create_lock_round_instruction,
  create_open_ai_duel_instruction,
  create_open_round_instruction,
  create_place_prediction_instruction,
  create_program_delegate_pda_instruction,
  create_resolve_round_instruction,
  create_reveal_ai_duel_instruction,
  create_set_house_bankroll_active_instruction,
  create_set_market_active_instruction,
  create_set_match_entry_result_instruction,
  create_settle_ai_duel_instruction,
  create_withdraw_house_bankroll_instruction,
  derive_ai_duel_pda,
  derive_house_bankroll_pda,
  derive_market_pda,
  derive_market_oracle_pda,
  derive_match_entry_pda,
  derive_match_pda,
  derive_position_pda,
  derive_round_pda,
  type account_type,
  type decision_side
} from "@/features/chain/ubalance-program";

type market_chain_input = {
  market_index: number;
  display_name: string;
  timeframe_minutes: number;
};

type round_chain_input = {
  market_index: number;
  reference_price: number;
  open_at_ms: number;
  close_at_ms: number;
};

type chain_round_status = "predicting" | "locked" | "resolved";
type chain_match_status = "open" | "locked" | "resolved" | "cancelled";

export type chain_match_snapshot = {
  status: chain_match_status;
  player_count: number;
  winner_count: number;
  highest_score: number;
  recorded_result_count: number;
  pot_lamports: number;
};

export type chain_match_entry_snapshot = {
  score: number;
  joined: boolean;
  result_recorded: boolean;
  is_winner: boolean;
  claimed: boolean;
};

export type latest_round_snapshot = {
  market_pda: string;
  round_pda: string;
  round_number: number;
  status: chain_round_status;
  reference_price: number;
  settlement_price: number | null;
  open_at_ms: number;
  close_at_ms: number;
  winning_side: "yes" | "no" | "skip" | null;
};

export type round_window_status = {
  round_number: number;
  status: chain_round_status;
  close_at_ms: number;
};

export type prepared_prediction_transaction = {
  transaction_base64: string;
  blockhash: string;
  last_valid_block_height: number;
  fee_payer: string;
};

export const to_lamports_price = (value: number): number => {
  return Math.max(1, Math.round(value * 100_000));
};

const parse_secret_key = (value: string): Uint8Array => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new app_error("UBALANCE_ADMIN_SECRET_KEY is required", 500);
  }
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    return Uint8Array.from(parsed);
  }
  return bs58.decode(trimmed);
};

const load_admin_secret_key = (): Uint8Array => {
  return parse_secret_key(env.UBALANCE_ADMIN_SECRET_KEY);
};

const parse_oracle_feed_id_hex = (value: string): Uint8Array => {
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new app_error("invalid oracle feed id hex", 400);
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve_sleep) => setTimeout(resolve_sleep, ms));
};

const discriminator = (instruction_name: string): Buffer => {
  return createHash("sha256").update(`global:${instruction_name}`).digest().subarray(0, 8);
};

const place_prediction_discriminator = discriminator("place_prediction");
const join_match_discriminator = discriminator("join_match");
const claim_match_payout_discriminator = discriminator("claim_match_payout");
const open_ai_duel_discriminator = discriminator("open_ai_duel");
const append_ai_duel_turn_discriminator = discriminator("append_ai_duel_turn");
const claim_ai_duel_payout_discriminator = discriminator("claim_ai_duel_payout");
const accounts_batch_size = 100;

const side_from_raw = (raw: number): decision_side => {
  if (raw === 0) {
    return "yes";
  }
  if (raw === 1) {
    return "no";
  }
  if (raw === 2) {
    return "skip";
  }
  throw new app_error("invalid decision side", 400);
};

export class chain_admin_service {
  readonly base_connection: Connection;
  readonly er_connection: Connection;
  readonly program_id: PublicKey;
  readonly validator: PublicKey;
  readonly admin: Keypair;

  constructor() {
    this.base_connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    this.er_connection = new Connection(env.ER_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: env.ER_WS_URL
    });
    this.program_id = new PublicKey(env.UBALANCE_PROGRAM_ID);
    this.validator = new PublicKey(env.ER_VALIDATOR_PUBKEY);
    this.admin = Keypair.fromSecretKey(load_admin_secret_key());
  }

  get_admin_public_key(): PublicKey {
    return this.admin.publicKey;
  }

  derive_market_pda(market_index: number): PublicKey {
    return derive_market_pda(this.program_id, this.admin.publicKey, market_index);
  }

  derive_round_pda(market_index: number, round_number: number): PublicKey {
    const market_pda = this.derive_market_pda(market_index);
    return derive_round_pda(this.program_id, market_pda, round_number);
  }

  derive_market_oracle_pda(market_index: number): PublicKey {
    const market_pda = this.derive_market_pda(market_index);
    return derive_market_oracle_pda(this.program_id, market_pda);
  }

  derive_match_pda(market_index: number, match_id: number): PublicKey {
    const market_pda = this.derive_market_pda(market_index);
    return derive_match_pda(this.program_id, market_pda, match_id);
  }

  derive_match_entry_pda(market_index: number, match_id: number, player_wallet: string): PublicKey {
    const match_pda = this.derive_match_pda(market_index, match_id);
    return derive_match_entry_pda(this.program_id, match_pda, new PublicKey(player_wallet));
  }

  derive_house_bankroll_pda(): PublicKey {
    return derive_house_bankroll_pda(this.program_id, this.admin.publicKey);
  }

  derive_ai_duel_pda(market_index: number, player_wallet: string, duel_id: number): PublicKey {
    const market_pda = this.derive_market_pda(market_index);
    return derive_ai_duel_pda(this.program_id, market_pda, new PublicKey(player_wallet), duel_id);
  }

  async get_next_round_number(market_index: number): Promise<number> {
    const market_pda = this.derive_market_pda(market_index);
    const account = await this.base_connection.getAccountInfo(market_pda, "confirmed");
    if (!account) {
      throw new app_error(`market ${market_index} is not initialized on-chain`, 404);
    }

    const data = Buffer.from(account.data);
    const last_round_offset = 8 + 32 + 2 + 4;
    if (data.length < last_round_offset + 8) {
      throw new app_error(`invalid market account data for ${market_index}`, 502);
    }

    const last_round = Number(data.readBigUInt64LE(last_round_offset));
    if (!Number.isSafeInteger(last_round)) {
      throw new app_error(`unsupported round number for market ${market_index}`, 502);
    }

    return last_round + 1;
  }

  async get_latest_round_snapshot(market_index: number): Promise<latest_round_snapshot | null> {
    const next_round_number = await this.get_next_round_number(market_index);
    const latest_round_number = next_round_number - 1;
    if (latest_round_number < 1) {
      return null;
    }

    return this.get_round_snapshot({ market_index, round_number: latest_round_number });
  }

  async get_round_snapshot(input: { market_index: number; round_number: number }): Promise<latest_round_snapshot | null> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    const round_account = await this.base_connection.getAccountInfo(round_pda, "confirmed");
    if (!round_account) {
      return null;
    }

    const decoded = this.decode_round_account(round_account.data);
    return {
      market_pda: market_pda.toBase58(),
      round_pda: round_pda.toBase58(),
      round_number: decoded.round_number,
      status: decoded.status,
      reference_price: decoded.reference_price / 100_000,
      settlement_price: decoded.settlement_price === null ? null : decoded.settlement_price / 100_000,
      open_at_ms: decoded.open_at_ts * 1000,
      close_at_ms: decoded.close_at_ts * 1000,
      winning_side: decoded.winning_side
    };
  }

  async get_resolved_round_numbers_in_window(input: {
    market_index: number;
    start_at_ms: number;
    end_at_ms: number;
  }): Promise<number[]> {
    const round_statuses = await this.get_round_statuses_in_window(input);
    const resolved_round_numbers = round_statuses
      .filter((round_status) => round_status.status === "resolved")
      .map((round_status) => round_status.round_number);
    return [...new Set(resolved_round_numbers)].sort((a, b) => a - b);
  }

  async get_round_statuses_in_window(input: {
    market_index: number;
    start_at_ms: number;
    end_at_ms: number;
  }): Promise<round_window_status[]> {
    if (input.end_at_ms < input.start_at_ms) {
      throw new app_error("invalid round window", 400);
    }

    const latest_round_snapshot = await this.get_latest_round_snapshot(input.market_index);
    if (!latest_round_snapshot || latest_round_snapshot.round_number < 1) {
      return [];
    }

    const market_pda = this.derive_market_pda(input.market_index);
    const latest_round_number = Number(latest_round_snapshot.round_number);
    const statuses: round_window_status[] = [];

    for (let start_round_number = 1; start_round_number <= latest_round_number; start_round_number += accounts_batch_size) {
      const end_round_number = Math.min(start_round_number + accounts_batch_size - 1, latest_round_number);
      const chunk_round_numbers: number[] = [];
      const chunk_round_accounts: PublicKey[] = [];

      for (let round_number = start_round_number; round_number <= end_round_number; round_number += 1) {
        chunk_round_numbers.push(round_number);
        chunk_round_accounts.push(derive_round_pda(this.program_id, market_pda, round_number));
      }

      const account_infos = await this.base_connection.getMultipleAccountsInfo(chunk_round_accounts, "confirmed");
      for (let index = 0; index < account_infos.length; index += 1) {
        const account_info = account_infos[index];
        if (!account_info || !account_info.owner.equals(this.program_id)) {
          continue;
        }

        const decoded = this.decode_round_account(account_info.data);
        const close_at_ms = decoded.close_at_ts * 1_000;
        if (close_at_ms < input.start_at_ms || close_at_ms > input.end_at_ms) {
          continue;
        }

        const round_number = chunk_round_numbers[index];
        if (round_number > 0) {
          statuses.push({
            round_number,
            status: decoded.status,
            close_at_ms
          });
        }
      }
    }

    return statuses.sort((a, b) => a.round_number - b.round_number);
  }

  async get_wallet_scoring_round_numbers(input: {
    market_index: number;
    wallet: string;
    round_numbers: number[];
  }): Promise<number[]> {
    const deduped_round_numbers = [...new Set(input.round_numbers)]
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
    if (deduped_round_numbers.length === 0) {
      return [];
    }

    const market_pda = this.derive_market_pda(input.market_index);
    const player = new PublicKey(input.wallet);
    const scoring_round_numbers: number[] = [];

    for (let index = 0; index < deduped_round_numbers.length; index += accounts_batch_size) {
      const chunk_round_numbers = deduped_round_numbers.slice(index, index + accounts_batch_size);
      const chunk_position_accounts = chunk_round_numbers.map((round_number) => {
        const round_pda = derive_round_pda(this.program_id, market_pda, round_number);
        return derive_position_pda(this.program_id, round_pda, player);
      });

      const account_infos = await this.base_connection.getMultipleAccountsInfo(chunk_position_accounts, "confirmed");
      for (let account_index = 0; account_index < account_infos.length; account_index += 1) {
        const account_info = account_infos[account_index];
        if (!account_info || !account_info.owner.equals(this.program_id)) {
          continue;
        }
        scoring_round_numbers.push(chunk_round_numbers[account_index]!);
      }
    }

    return [...new Set(scoring_round_numbers)].sort((a, b) => a - b);
  }

  async get_match_snapshot(input: {
    market_index: number;
    match_id: number;
  }): Promise<chain_match_snapshot | null> {
    const match_pda = this.derive_match_pda(input.market_index, input.match_id);
    const match_account = await this.base_connection.getAccountInfo(match_pda, "confirmed");
    if (!match_account) {
      return null;
    }
    if (!match_account.owner.equals(this.program_id)) {
      throw new app_error("invalid match account owner", 502);
    }
    return this.decode_match_account(match_account.data);
  }

  async get_match_entry_snapshots(input: {
    market_index: number;
    match_id: number;
    player_wallets: string[];
  }): Promise<Map<string, chain_match_entry_snapshot>> {
    const deduped_wallets = [...new Set(input.player_wallets)]
      .map((wallet) => wallet.trim())
      .filter((wallet) => wallet.length > 0);
    const snapshots = new Map<string, chain_match_entry_snapshot>();
    if (deduped_wallets.length === 0) {
      return snapshots;
    }

    const match_pda = this.derive_match_pda(input.market_index, input.match_id);

    for (let index = 0; index < deduped_wallets.length; index += accounts_batch_size) {
      const chunk_wallets = deduped_wallets.slice(index, index + accounts_batch_size);
      const chunk_entry_accounts = chunk_wallets.map((wallet) => {
        const player = new PublicKey(wallet);
        return derive_match_entry_pda(this.program_id, match_pda, player);
      });

      const account_infos = await this.base_connection.getMultipleAccountsInfo(chunk_entry_accounts, "confirmed");
      for (let account_index = 0; account_index < account_infos.length; account_index += 1) {
        const account_info = account_infos[account_index];
        if (!account_info || !account_info.owner.equals(this.program_id)) {
          continue;
        }
        const wallet = chunk_wallets[account_index]!;
        snapshots.set(wallet, this.decode_match_entry_account(account_info.data));
      }
    }

    return snapshots;
  }

  async ensure_market_initialized(input: market_chain_input): Promise<{ market_pda: string; initialize_tx_signature: string | null }> {
    const market_pda = this.derive_market_pda(input.market_index);
    const existing = await this.base_connection.getAccountInfo(market_pda, "confirmed");
    if (existing) {
      return { market_pda: market_pda.toBase58(), initialize_tx_signature: null };
    }

    const initialize_ix = create_initialize_market_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      market_index: input.market_index,
      name: input.display_name,
      timeframe_seconds: input.timeframe_minutes * 60
    });

    const activate_ix = create_set_market_active_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      is_active: true
    });

    try {
      const signature = await this.send_base_transaction([initialize_ix, activate_ix], "initialize market");
      return { market_pda: market_pda.toBase58(), initialize_tx_signature: signature };
    } catch (error) {
      const existing_after_error = await this.base_connection.getAccountInfo(market_pda, "confirmed");
      if (existing_after_error) {
        return { market_pda: market_pda.toBase58(), initialize_tx_signature: null };
      }
      throw error;
    }
  }

  async ensure_market_oracle_initialized(input: {
    market_index: number;
    oracle_feed_id_hex: string;
  }): Promise<{ market_oracle_pda: string; initialize_tx_signature: string | null }> {
    const market_pda = this.derive_market_pda(input.market_index);
    const market_oracle_pda = derive_market_oracle_pda(this.program_id, market_pda);
    const existing = await this.base_connection.getAccountInfo(market_oracle_pda, "confirmed");
    if (existing) {
      return { market_oracle_pda: market_oracle_pda.toBase58(), initialize_tx_signature: null };
    }

    const initialize_ix = create_init_market_oracle_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      market_oracle_pda,
      oracle_feed_id: parse_oracle_feed_id_hex(input.oracle_feed_id_hex)
    });

    try {
      const signature = await this.send_base_transaction([initialize_ix], "initialize market oracle");
      return { market_oracle_pda: market_oracle_pda.toBase58(), initialize_tx_signature: signature };
    } catch (error) {
      const existing_after_error = await this.base_connection.getAccountInfo(market_oracle_pda, "confirmed");
      if (existing_after_error) {
        return { market_oracle_pda: market_oracle_pda.toBase58(), initialize_tx_signature: null };
      }
      throw error;
    }
  }

  async open_round(input: round_chain_input): Promise<{
    market_pda: string;
    round_pda: string;
    round_number: number;
    open_tx_signature: string;
  }> {
    const market_pda = this.derive_market_pda(input.market_index);
    let round_number = await this.get_next_round_number(input.market_index);
    const max_attempts = 3;
    let last_error: unknown = null;

    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      const round_pda = derive_round_pda(this.program_id, market_pda, round_number);
      const open_round_ix = create_open_round_instruction({
        program_id: this.program_id,
        admin: this.admin.publicKey,
        market_pda,
        round_pda,
        reference_price: to_lamports_price(input.reference_price),
        open_at_ts: Math.floor(input.open_at_ms / 1000),
        close_at_ts: Math.floor(input.close_at_ms / 1000)
      });

      try {
        const open_tx_signature = await this.send_base_transaction([open_round_ix], "open round");
        return {
          market_pda: market_pda.toBase58(),
          round_pda: round_pda.toBase58(),
          round_number,
          open_tx_signature
        };
      } catch (error) {
        last_error = error;
        const formatted = this.format_error(error);
        const retryable = this.is_retryable_open_round_error(formatted);
        if (!retryable || attempt >= max_attempts) {
          throw new app_error(`open round failed: ${formatted}`, 502);
        }

        round_number = await this.get_next_round_number(input.market_index);
        await sleep(250 * attempt);
      }
    }

    throw new app_error(`open round failed: ${this.format_error(last_error)}`, 502);
  }

  async create_match(input: {
    market_index: number;
    match_id: number;
    buy_in_lamports: number;
    max_players: number;
    start_at_ms: number;
    end_at_ms: number;
  }): Promise<{ match_pda: string; create_tx_signature: string }> {
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);

    const create_match_ix = create_create_match_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      match_pda,
      match_id: input.match_id,
      buy_in_lamports: input.buy_in_lamports,
      max_players: input.max_players,
      start_at_ts: Math.floor(input.start_at_ms / 1000),
      end_at_ts: Math.floor(input.end_at_ms / 1000)
    });

    const create_tx_signature = await this.send_base_transaction([create_match_ix], "create match");
    return {
      match_pda: match_pda.toBase58(),
      create_tx_signature
    };
  }

  async lock_match(input: { market_index: number; match_id: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);

    const lock_match_ix = create_lock_match_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      match_pda
    });

    return this.send_base_transaction([lock_match_ix], "lock match");
  }

  async set_match_entry_result(input: {
    market_index: number;
    match_id: number;
    player_wallet: string;
    scoring_round_numbers: number[];
  }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);
    const player = new PublicKey(input.player_wallet);
    const match_entry_pda = derive_match_entry_pda(this.program_id, match_pda, player);
    const deduped_round_numbers = [...new Set(input.scoring_round_numbers)]
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
    const scoring_account_pairs = deduped_round_numbers.map((round_number) => {
      const round_pda = derive_round_pda(this.program_id, market_pda, round_number);
      const position_pda = derive_position_pda(this.program_id, round_pda, player);
      return { round_pda, position_pda };
    });

    const set_result_ix = create_set_match_entry_result_instruction({
      program_id: this.program_id,
      market_pda,
      match_pda,
      match_entry_pda,
      scoring_account_pairs
    });

    return this.send_base_transaction([set_result_ix], "set match result from on-chain rounds");
  }

  async finalize_match(input: { market_index: number; match_id: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);

    const finalize_ix = create_finalize_match_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      match_pda
    });

    return this.send_base_transaction([finalize_ix], "finalize match");
  }

  async cancel_match(input: { market_index: number; match_id: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);

    const cancel_ix = create_cancel_match_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      match_pda
    });

    return this.send_base_transaction([cancel_ix], "cancel match");
  }

  async ensure_house_bankroll_initialized(): Promise<{ house_bankroll_pda: string; initialize_tx_signature: string | null }> {
    const house_bankroll_pda = this.derive_house_bankroll_pda();
    const existing = await this.base_connection.getAccountInfo(house_bankroll_pda, "confirmed");
    if (existing) {
      return { house_bankroll_pda: house_bankroll_pda.toBase58(), initialize_tx_signature: null };
    }

    const initialize_ix = create_init_house_bankroll_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      house_bankroll_pda
    });

    const activate_ix = create_set_house_bankroll_active_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      house_bankroll_pda,
      active: true
    });

    try {
      const signature = await this.send_base_transaction([initialize_ix, activate_ix], "init house bankroll");
      return { house_bankroll_pda: house_bankroll_pda.toBase58(), initialize_tx_signature: signature };
    } catch (error) {
      const existing_after_error = await this.base_connection.getAccountInfo(house_bankroll_pda, "confirmed");
      if (existing_after_error) {
        return { house_bankroll_pda: house_bankroll_pda.toBase58(), initialize_tx_signature: null };
      }
      throw error;
    }
  }

  async set_house_bankroll_active(active: boolean): Promise<string> {
    const house_bankroll_pda = this.derive_house_bankroll_pda();
    const ix = create_set_house_bankroll_active_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      house_bankroll_pda,
      active
    });
    return this.send_base_transaction([ix], "set house bankroll active");
  }

  async fund_house_bankroll(amount_lamports: number): Promise<string> {
    const house_bankroll_pda = this.derive_house_bankroll_pda();
    const ix = create_fund_house_bankroll_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      house_bankroll_pda,
      amount_lamports
    });
    return this.send_base_transaction([ix], "fund house bankroll");
  }

  async withdraw_house_bankroll(amount_lamports: number): Promise<string> {
    const house_bankroll_pda = this.derive_house_bankroll_pda();
    const ix = create_withdraw_house_bankroll_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      house_bankroll_pda,
      amount_lamports
    });
    return this.send_base_transaction([ix], "withdraw house bankroll");
  }

  async get_house_bankroll_balance_lamports(): Promise<number> {
    const house_bankroll_pda = this.derive_house_bankroll_pda();
    return this.base_connection.getBalance(house_bankroll_pda, "confirmed");
  }

  async is_round_delegated(input: { market_index: number; round_number: number }): Promise<boolean> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    return this.is_pda_delegated(round_pda);
  }

  async is_pda_delegated(pda: PublicKey | string): Promise<boolean> {
    const key = this.to_public_key(pda);
    const account = await this.base_connection.getAccountInfo(key, "confirmed");
    if (!account) {
      throw new app_error("account not found on base layer", 404);
    }

    return account.owner.equals(DELEGATION_PROGRAM_ID);
  }

  async delegate_round_account(input: { market_index: number; round_number: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    return this.delegate_account({
      pda: round_pda,
      account_type: {
        kind: "round",
        market: market_pda,
        round_number: input.round_number
      }
    });
  }

  async delegate_account(input: { pda: PublicKey | string; account_type: account_type }): Promise<string> {
    const pda = this.to_public_key(input.pda);
    const delegate_account_ix = create_program_delegate_pda_instruction({
      program_id: this.program_id,
      payer: this.admin.publicKey,
      pda,
      account_type: input.account_type,
      validator: this.validator
    });

    return this.send_base_transaction([delegate_account_ix], "delegate account");
  }

  async commit_and_undelegate_round(input: { market_index: number; round_number: number }): Promise<{
    er_tx_signature: string;
    base_commit_tx_signature: string | null;
  }> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    const commit_and_undelegate_round_ix = create_commit_and_undelegate_round_instruction({
      program_id: this.program_id,
      payer: this.admin.publicKey,
      market_pda,
      round_pda
    });
    const er_tx_signature = await this.send_er_transaction([commit_and_undelegate_round_ix], "commit and undelegate round");

    let base_commit_tx_signature: string | null = null;
    try {
      base_commit_tx_signature = await GetCommitmentSignature(er_tx_signature, this.er_connection);
    } catch {
      // Best-effort helper only; ownership polling below enforces final state.
    }

    await this.wait_for_account_owner(round_pda, this.program_id, 20_000);

    return {
      er_tx_signature,
      base_commit_tx_signature
    };
  }

  async commit_and_undelegate_account(input: {
    pda: PublicKey | string;
    account_type: account_type;
    timeout_ms?: number;
  }): Promise<{
    er_tx_signature: string;
    base_commit_tx_signature: string | null;
  }> {
    const pda = this.to_public_key(input.pda);
    const ix = create_commit_and_undelegate_pda_instruction({
      program_id: this.program_id,
      payer: this.admin.publicKey,
      pda,
      account_type: input.account_type
    });

    const er_tx_signature = await this.send_er_transaction([ix], "commit and undelegate account");
    let base_commit_tx_signature: string | null = null;
    try {
      base_commit_tx_signature = await GetCommitmentSignature(er_tx_signature, this.er_connection);
    } catch {
      // Best-effort helper only; ownership polling below enforces final state.
    }

    await this.wait_for_account_owner(pda, this.program_id, input.timeout_ms ?? 20_000);

    return {
      er_tx_signature,
      base_commit_tx_signature
    };
  }

  async lock_round(input: { market_index: number; round_number: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    const lock_ix = create_lock_round_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      round_pda
    });

    return this.send_base_transaction([lock_ix], "lock round");
  }

  async resolve_round(input: {
    market_index: number;
    round_number: number;
    oracle_price_feed: string;
  }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const market_oracle_pda = derive_market_oracle_pda(this.program_id, market_pda);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    const resolve_ix = create_resolve_round_instruction({
      program_id: this.program_id,
      market_pda,
      platform_fee_receiver: this.admin.publicKey,
      market_oracle_pda,
      round_pda,
      oracle_price_feed: new PublicKey(input.oracle_price_feed)
    });

    return this.send_base_transaction([resolve_ix], "resolve round");
  }

  async prepare_prediction_transaction(input: {
    user_wallet: string;
    market_pda: string;
    round_pda: string;
    side: decision_side;
    amount_lamports: number;
  }): Promise<prepared_prediction_transaction> {
    const user = new PublicKey(input.user_wallet);
    const market = new PublicKey(input.market_pda);
    const round = new PublicKey(input.round_pda);
    const position = derive_position_pda(this.program_id, round, user);

    const place_prediction_ix = create_place_prediction_instruction({
      program_id: this.program_id,
      user,
      market_pda: market,
      round_pda: round,
      position_pda: position,
      side: input.side,
      amount_lamports: input.amount_lamports
    });

    return this.prepare_transaction(this.er_connection, place_prediction_ix);
  }

  async prepare_claim_payout_transaction(input: {
    user_wallet: string;
    market_pda: string;
    round_pda: string;
  }): Promise<prepared_prediction_transaction> {
    const user = new PublicKey(input.user_wallet);
    const market = new PublicKey(input.market_pda);
    const round = new PublicKey(input.round_pda);
    const position = derive_position_pda(this.program_id, round, user);

    const claim_payout_ix = create_claim_payout_instruction({
      program_id: this.program_id,
      user,
      market_pda: market,
      round_pda: round,
      position_pda: position
    });

    return this.prepare_transaction(this.base_connection, claim_payout_ix);
  }

  async prepare_join_match_transaction(input: {
    user_wallet: string;
    market_index: number;
    match_id: number;
  }): Promise<prepared_prediction_transaction & { match_pda: string; match_entry_pda: string }> {
    const player = new PublicKey(input.user_wallet);
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);
    const match_entry_pda = derive_match_entry_pda(this.program_id, match_pda, player);

    const join_match_ix = create_join_match_instruction({
      program_id: this.program_id,
      player,
      match_pda,
      match_entry_pda
    });

    const prepared = await this.prepare_transaction(this.er_connection, join_match_ix);
    return {
      ...prepared,
      match_pda: match_pda.toBase58(),
      match_entry_pda: match_entry_pda.toBase58()
    };
  }

  async prepare_claim_match_payout_transaction(input: {
    user_wallet: string;
    market_index: number;
    match_id: number;
  }): Promise<prepared_prediction_transaction & { match_pda: string; match_entry_pda: string }> {
    const player = new PublicKey(input.user_wallet);
    const market_pda = this.derive_market_pda(input.market_index);
    const match_pda = derive_match_pda(this.program_id, market_pda, input.match_id);
    const match_entry_pda = derive_match_entry_pda(this.program_id, match_pda, player);

    const claim_ix = create_claim_match_payout_instruction({
      program_id: this.program_id,
      player,
      match_pda,
      match_entry_pda
    });

    const prepared = await this.prepare_transaction(this.base_connection, claim_ix);
    return {
      ...prepared,
      match_pda: match_pda.toBase58(),
      match_entry_pda: match_entry_pda.toBase58()
    };
  }

  async prepare_open_ai_duel_transaction(input: {
    user_wallet: string;
    market_index: number;
    round_number: number;
    duel_id: number;
    player_side: decision_side;
    amount_lamports: number;
    ai_commitment: Uint8Array;
  }): Promise<prepared_prediction_transaction & {
    market_pda: string;
    round_pda: string;
    house_bankroll_pda: string;
    ai_duel_pda: string;
  }> {
    const player = new PublicKey(input.user_wallet);
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    const house_bankroll_pda = derive_house_bankroll_pda(this.program_id, this.admin.publicKey);
    const ai_duel_pda = derive_ai_duel_pda(this.program_id, market_pda, player, input.duel_id);

    const ix = create_open_ai_duel_instruction({
      program_id: this.program_id,
      player,
      market_pda,
      round_pda,
      house_bankroll_pda,
      ai_duel_pda,
      duel_id: input.duel_id,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_commitment: input.ai_commitment
    });

    const prepared = await this.prepare_transaction(this.er_connection, ix);
    return {
      ...prepared,
      market_pda: market_pda.toBase58(),
      round_pda: round_pda.toBase58(),
      house_bankroll_pda: house_bankroll_pda.toBase58(),
      ai_duel_pda: ai_duel_pda.toBase58()
    };
  }

  async prepare_append_ai_duel_turn_transaction(input: {
    user_wallet: string;
    market_index: number;
    round_number: number;
    duel_id: number;
    player_side: decision_side;
    amount_lamports: number;
    ai_commitment: Uint8Array;
  }): Promise<prepared_prediction_transaction & {
    market_pda: string;
    round_pda: string;
    house_bankroll_pda: string;
    ai_duel_pda: string;
  }> {
    const player = new PublicKey(input.user_wallet);
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    const house_bankroll_pda = derive_house_bankroll_pda(this.program_id, this.admin.publicKey);
    const ai_duel_pda = derive_ai_duel_pda(this.program_id, market_pda, player, input.duel_id);

    const ix = create_append_ai_duel_turn_instruction({
      program_id: this.program_id,
      player,
      market_pda,
      round_pda,
      house_bankroll_pda,
      ai_duel_pda,
      duel_id: input.duel_id,
      player_side: input.player_side,
      amount_lamports: input.amount_lamports,
      ai_commitment: input.ai_commitment
    });

    const prepared = await this.prepare_transaction(this.er_connection, ix);
    return {
      ...prepared,
      market_pda: market_pda.toBase58(),
      round_pda: round_pda.toBase58(),
      house_bankroll_pda: house_bankroll_pda.toBase58(),
      ai_duel_pda: ai_duel_pda.toBase58()
    };
  }

  async reveal_ai_duel(input: {
    market_index: number;
    player_wallet: string;
    duel_id: number;
    ai_side: decision_side;
    nonce: Uint8Array;
  }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const ai_duel_pda = derive_ai_duel_pda(
      this.program_id,
      market_pda,
      new PublicKey(input.player_wallet),
      input.duel_id
    );

    const reveal_ix = create_reveal_ai_duel_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      ai_duel_pda,
      ai_side: input.ai_side,
      nonce: input.nonce
    });

    return this.send_base_transaction([reveal_ix], "reveal ai duel");
  }

  async settle_ai_duel(input: {
    market_index: number;
    player_wallet: string;
    duel_id: number;
    round_number: number;
    ai_sides: decision_side[];
    nonces: Uint8Array[];
  }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    const house_bankroll_pda = derive_house_bankroll_pda(this.program_id, this.admin.publicKey);
    const ai_duel_pda = derive_ai_duel_pda(
      this.program_id,
      market_pda,
      new PublicKey(input.player_wallet),
      input.duel_id
    );

    const settle_ix = create_settle_ai_duel_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      round_pda,
      house_bankroll_pda,
      ai_duel_pda,
      ai_sides: input.ai_sides,
      nonces: input.nonces
    });

    return this.send_base_transaction([settle_ix], "settle ai duel");
  }

  async prepare_claim_ai_duel_payout_transaction(input: {
    user_wallet: string;
    market_index: number;
    duel_id: number;
  }): Promise<prepared_prediction_transaction & { ai_duel_pda: string }> {
    const player = new PublicKey(input.user_wallet);
    const market_pda = this.derive_market_pda(input.market_index);
    const ai_duel_pda = derive_ai_duel_pda(this.program_id, market_pda, player, input.duel_id);

    const claim_ix = create_claim_ai_duel_payout_instruction({
      program_id: this.program_id,
      player,
      ai_duel_pda
    });

    const prepared = await this.prepare_transaction(this.base_connection, claim_ix);
    return {
      ...prepared,
      ai_duel_pda: ai_duel_pda.toBase58()
    };
  }

  async verify_prediction_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_market_pda: string;
    expected_round_pda: string;
    expected_side: decision_side;
    expected_amount_lamports: number;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.er_connection, input.tx_signature);

    if (!parsed) {
      throw new app_error("prediction transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("prediction transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_market = new PublicKey(input.expected_market_pda).toBase58();
    const expected_round = new PublicKey(input.expected_round_pda).toBase58();
    const expected_position = derive_position_pda(
      this.program_id,
      new PublicKey(expected_round),
      new PublicKey(expected_wallet)
    ).toBase58();
    const expected_program = this.program_id.toBase58();
    const expected_system_program = "11111111111111111111111111111111";

    this.require_signer(parsed, expected_wallet, "prediction transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 5) {
        continue;
      }
      if (
        accounts[0] !== expected_wallet ||
        accounts[1] !== expected_market ||
        accounts[2] !== expected_round ||
        accounts[3] !== expected_position ||
        accounts[4] !== expected_system_program
      ) {
        continue;
      }

      const decoded = this.decode_place_prediction_data(instruction.data);
      if (decoded.side !== input.expected_side || decoded.amount_lamports !== input.expected_amount_lamports) {
        throw new app_error("prediction transaction data mismatch", 400);
      }
      return;
    }

    throw new app_error("prediction instruction not found in transaction", 400);
  }

  async verify_join_match_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_match_pda: string;
    expected_match_entry_pda: string;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.er_connection, input.tx_signature);
    if (!parsed) {
      throw new app_error("join match transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("join match transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_match = new PublicKey(input.expected_match_pda).toBase58();
    const expected_entry = new PublicKey(input.expected_match_entry_pda).toBase58();
    const expected_program = this.program_id.toBase58();
    const expected_system_program = "11111111111111111111111111111111";

    this.require_signer(parsed, expected_wallet, "join match transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 4) {
        continue;
      }

      if (
        accounts[0] !== expected_wallet ||
        accounts[1] !== expected_match ||
        accounts[2] !== expected_entry ||
        accounts[3] !== expected_system_program
      ) {
        continue;
      }

      this.require_instruction_discriminator(instruction.data, join_match_discriminator, 8, "join_match");
      return;
    }

    throw new app_error("join_match instruction not found in transaction", 400);
  }

  async verify_claim_match_payout_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_match_pda: string;
    expected_match_entry_pda: string;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.base_connection, input.tx_signature);
    if (!parsed) {
      throw new app_error("claim match payout transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("claim match payout transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_match = new PublicKey(input.expected_match_pda).toBase58();
    const expected_entry = new PublicKey(input.expected_match_entry_pda).toBase58();
    const expected_program = this.program_id.toBase58();

    this.require_signer(parsed, expected_wallet, "claim payout transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 3) {
        continue;
      }

      if (
        accounts[0] !== expected_wallet ||
        accounts[1] !== expected_match ||
        accounts[2] !== expected_entry
      ) {
        continue;
      }

      this.require_instruction_discriminator(
        instruction.data,
        claim_match_payout_discriminator,
        8,
        "claim_match_payout"
      );
      return;
    }

    throw new app_error("claim_match_payout instruction not found in transaction", 400);
  }

  async verify_open_ai_duel_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_market_pda: string;
    expected_round_pda: string;
    expected_house_bankroll_pda: string;
    expected_ai_duel_pda: string;
    expected_duel_id: number;
    expected_player_side: decision_side;
    expected_amount_lamports: number;
    expected_ai_commitment: Uint8Array;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.er_connection, input.tx_signature);
    if (!parsed) {
      throw new app_error("open ai duel transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("open ai duel transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_market = new PublicKey(input.expected_market_pda).toBase58();
    const expected_round = new PublicKey(input.expected_round_pda).toBase58();
    const expected_house = new PublicKey(input.expected_house_bankroll_pda).toBase58();
    const expected_duel = new PublicKey(input.expected_ai_duel_pda).toBase58();
    const expected_program = this.program_id.toBase58();
    const expected_system_program = "11111111111111111111111111111111";

    this.require_signer(parsed, expected_wallet, "open ai duel transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 6) {
        continue;
      }

      if (
        accounts[0] !== expected_wallet ||
        accounts[1] !== expected_market ||
        accounts[2] !== expected_round ||
        accounts[3] !== expected_house ||
        accounts[4] !== expected_duel ||
        accounts[5] !== expected_system_program
      ) {
        continue;
      }

      const decoded = this.decode_open_ai_duel_data(instruction.data);
      const expected_commitment = Buffer.from(input.expected_ai_commitment);
      if (
        decoded.duel_id !== input.expected_duel_id ||
        decoded.player_side !== input.expected_player_side ||
        decoded.amount_lamports !== input.expected_amount_lamports ||
        !decoded.ai_commitment.equals(expected_commitment)
      ) {
        throw new app_error("open ai duel transaction data mismatch", 400);
      }
      return;
    }

    throw new app_error("open_ai_duel instruction not found in transaction", 400);
  }

  async verify_append_ai_duel_turn_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_market_pda: string;
    expected_round_pda: string;
    expected_house_bankroll_pda: string;
    expected_ai_duel_pda: string;
    expected_duel_id: number;
    expected_player_side: decision_side;
    expected_amount_lamports: number;
    expected_ai_commitment: Uint8Array;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.er_connection, input.tx_signature);
    if (!parsed) {
      throw new app_error("append ai duel turn transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("append ai duel turn transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_market = new PublicKey(input.expected_market_pda).toBase58();
    const expected_round = new PublicKey(input.expected_round_pda).toBase58();
    const expected_house = new PublicKey(input.expected_house_bankroll_pda).toBase58();
    const expected_duel = new PublicKey(input.expected_ai_duel_pda).toBase58();
    const expected_program = this.program_id.toBase58();
    const expected_system_program = "11111111111111111111111111111111";

    this.require_signer(parsed, expected_wallet, "append ai duel turn transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 6) {
        continue;
      }

      if (
        accounts[0] !== expected_wallet ||
        accounts[1] !== expected_market ||
        accounts[2] !== expected_round ||
        accounts[3] !== expected_house ||
        accounts[4] !== expected_duel ||
        accounts[5] !== expected_system_program
      ) {
        continue;
      }

      const decoded = this.decode_append_ai_duel_turn_data(instruction.data);
      const expected_commitment = Buffer.from(input.expected_ai_commitment);
      if (
        decoded.duel_id !== input.expected_duel_id ||
        decoded.player_side !== input.expected_player_side ||
        decoded.amount_lamports !== input.expected_amount_lamports ||
        !decoded.ai_commitment.equals(expected_commitment)
      ) {
        throw new app_error("append ai duel turn transaction data mismatch", 400);
      }
      return;
    }

    throw new app_error("append_ai_duel_turn instruction not found in transaction", 400);
  }

  async verify_claim_ai_duel_payout_transaction(input: {
    tx_signature: string;
    expected_wallet: string;
    expected_ai_duel_pda: string;
  }): Promise<void> {
    const parsed = await this.get_parsed_transaction_with_retry(this.base_connection, input.tx_signature);
    if (!parsed) {
      throw new app_error("claim ai duel payout transaction not found", 400);
    }
    if (parsed.meta?.err) {
      throw new app_error("claim ai duel payout transaction failed", 400);
    }

    const expected_wallet = new PublicKey(input.expected_wallet).toBase58();
    const expected_ai_duel = new PublicKey(input.expected_ai_duel_pda).toBase58();
    const expected_program = this.program_id.toBase58();

    this.require_signer(parsed, expected_wallet, "claim ai duel payout transaction missing expected wallet signer");

    for (const instruction of parsed.transaction.message.instructions as any[]) {
      const instruction_program =
        typeof instruction?.programId === "string"
          ? instruction.programId
          : instruction?.programId?.toBase58?.();
      if (instruction_program !== expected_program) {
        continue;
      }
      if (!Array.isArray(instruction?.accounts) || typeof instruction?.data !== "string") {
        continue;
      }

      const accounts = instruction.accounts.map((account: any) =>
        typeof account === "string" ? account : account?.toBase58?.()
      );
      if (accounts.length < 2) {
        continue;
      }

      if (accounts[0] !== expected_wallet || accounts[1] !== expected_ai_duel) {
        continue;
      }

      this.require_instruction_discriminator(
        instruction.data,
        claim_ai_duel_payout_discriminator,
        8,
        "claim_ai_duel_payout"
      );
      return;
    }

    throw new app_error("claim_ai_duel_payout instruction not found in transaction", 400);
  }

  private async prepare_transaction(
    connection: Connection,
    instruction: TransactionInstruction
  ): Promise<prepared_prediction_transaction> {
    const latest = await connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: this.admin.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight
    });

    transaction.add(instruction);
    transaction.partialSign(this.admin);

    return {
      transaction_base64: transaction
        .serialize({
          requireAllSignatures: false,
          verifySignatures: false
        })
        .toString("base64"),
      blockhash: latest.blockhash,
      last_valid_block_height: latest.lastValidBlockHeight,
      fee_payer: this.admin.publicKey.toBase58()
    };
  }

  private async get_parsed_transaction_with_retry(connection: Connection, tx_signature: string): Promise<any | null> {
    const max_attempts = 7;
    let last_error: unknown = null;

    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      try {
        const parsed = await connection.getParsedTransaction(tx_signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        });
        if (parsed) {
          return parsed;
        }
      } catch (error) {
        last_error = error;
      }

      if (attempt < max_attempts) {
        await sleep(250 * attempt);
      }
    }

    if (last_error) {
      throw new app_error(`transaction lookup failed: ${this.format_error(last_error)}`, 502);
    }
    return null;
  }

  private decode_place_prediction_data(data_base58: string): {
    side: decision_side;
    amount_lamports: number;
  } {
    const raw = this.decode_instruction_data(data_base58);

    if (raw.length !== 17) {
      throw new app_error("prediction instruction data length mismatch", 400);
    }
    const discriminator_raw = raw.subarray(0, 8);
    if (!Buffer.from(discriminator_raw).equals(place_prediction_discriminator)) {
      throw new app_error("unexpected instruction discriminator", 400);
    }

    const side = side_from_raw(raw[8]);
    const amount_lamports = Number(Buffer.from(raw.subarray(9, 17)).readBigUInt64LE(0));
    if (!Number.isSafeInteger(amount_lamports)) {
      throw new app_error("invalid prediction amount", 400);
    }

    return { side, amount_lamports };
  }

  private decode_open_ai_duel_data(data_base58: string): {
    duel_id: number;
    player_side: decision_side;
    amount_lamports: number;
    ai_commitment: Buffer;
  } {
    return this.decode_ai_duel_turn_payload(
      data_base58,
      open_ai_duel_discriminator,
      "open ai duel"
    );
  }

  private decode_append_ai_duel_turn_data(data_base58: string): {
    duel_id: number;
    player_side: decision_side;
    amount_lamports: number;
    ai_commitment: Buffer;
  } {
    return this.decode_ai_duel_turn_payload(
      data_base58,
      append_ai_duel_turn_discriminator,
      "append ai duel turn"
    );
  }

  private decode_ai_duel_turn_payload(
    data_base58: string,
    expected_discriminator: Buffer,
    instruction_name: string
  ): {
    duel_id: number;
    player_side: decision_side;
    amount_lamports: number;
    ai_commitment: Buffer;
  } {
    const raw = this.decode_instruction_data(data_base58);
    if (raw.length !== 57) {
      throw new app_error(`${instruction_name} instruction data length mismatch`, 400);
    }
    const discriminator_raw = raw.subarray(0, 8);
    if (!Buffer.from(discriminator_raw).equals(expected_discriminator)) {
      throw new app_error("unexpected instruction discriminator", 400);
    }

    const duel_id = Number(Buffer.from(raw.subarray(8, 16)).readBigUInt64LE(0));
    if (!Number.isSafeInteger(duel_id)) {
      throw new app_error("invalid duel id", 400);
    }

    const player_side = side_from_raw(raw[16]);
    const amount_lamports = Number(Buffer.from(raw.subarray(17, 25)).readBigUInt64LE(0));
    if (!Number.isSafeInteger(amount_lamports)) {
      throw new app_error("invalid duel amount", 400);
    }

    const ai_commitment = Buffer.from(raw.subarray(25, 57));

    return {
      duel_id,
      player_side,
      amount_lamports,
      ai_commitment
    };
  }

  private decode_instruction_data(data_base58: string): Uint8Array {
    try {
      return bs58.decode(data_base58);
    } catch {
      throw new app_error("instruction data is not base58", 400);
    }
  }

  private require_instruction_discriminator(
    data_base58: string,
    expected_discriminator: Buffer,
    expected_length: number,
    instruction_name: string
  ): void {
    const raw = this.decode_instruction_data(data_base58);
    if (raw.length !== expected_length) {
      throw new app_error(`${instruction_name} instruction data length mismatch`, 400);
    }
    const discriminator_raw = raw.subarray(0, 8);
    if (!Buffer.from(discriminator_raw).equals(expected_discriminator)) {
      throw new app_error(`unexpected ${instruction_name} discriminator`, 400);
    }
  }

  private require_signer(parsed: any, expected_wallet: string, error_message: string): void {
    const signer_present = parsed.transaction.message.accountKeys.some((key: any) => {
      const key_pubkey =
        typeof key?.pubkey === "string" ? key.pubkey : key?.pubkey?.toBase58?.();
      return Boolean(key?.signer) && key_pubkey === expected_wallet;
    });
    if (!signer_present) {
      throw new app_error(error_message, 400);
    }
  }

  private decode_round_account(data_buffer: Buffer | Uint8Array): {
    round_number: number;
    status: chain_round_status;
    reference_price: number;
    settlement_price: number | null;
    open_at_ts: number;
    close_at_ts: number;
    winning_side: "yes" | "no" | "skip" | null;
  } {
    const data = Buffer.from(data_buffer);
    let offset = 8;

    const ensure_available = (bytes: number) => {
      if (offset + bytes > data.length) {
        throw new app_error("invalid round account data", 502);
      }
    };

    ensure_available(32);
    offset += 32;

    ensure_available(8);
    const round_number = Number(data.readBigUInt64LE(offset));
    offset += 8;

    ensure_available(1);
    const status_raw = data.readUInt8(offset);
    offset += 1;
    let status: chain_round_status;
    if (status_raw === 0) {
      status = "predicting";
    } else if (status_raw === 1) {
      status = "locked";
    } else if (status_raw === 2) {
      status = "resolved";
    } else {
      throw new app_error("invalid round status", 502);
    }

    ensure_available(8);
    const reference_price = Number(data.readBigUInt64LE(offset));
    offset += 8;

    ensure_available(1);
    const settlement_tag = data.readUInt8(offset);
    offset += 1;
    let settlement_price: number | null = null;
    if (settlement_tag === 1) {
      ensure_available(8);
      settlement_price = Number(data.readBigUInt64LE(offset));
      offset += 8;
    }

    ensure_available(8);
    const open_at_ts = Number(data.readBigInt64LE(offset));
    offset += 8;

    ensure_available(8);
    const close_at_ts = Number(data.readBigInt64LE(offset));
    offset += 8;

    ensure_available(1);
    const resolved_side_tag = data.readUInt8(offset);
    offset += 1;
    let winning_side: "yes" | "no" | "skip" | null = null;
    if (resolved_side_tag === 1) {
      ensure_available(1);
      const side_raw = data.readUInt8(offset);
      offset += 1;
      winning_side = side_from_raw(side_raw);
    }

    return {
      round_number,
      status,
      reference_price,
      settlement_price,
      open_at_ts,
      close_at_ts,
      winning_side
    };
  }

  private decode_match_account(data_buffer: Buffer | Uint8Array): chain_match_snapshot {
    const data = Buffer.from(data_buffer);
    let offset = 8;

    const ensure_available = (bytes: number) => {
      if (offset + bytes > data.length) {
        throw new app_error("invalid match account data", 502);
      }
    };

    ensure_available(32);
    offset += 32;
    ensure_available(32);
    offset += 32;
    ensure_available(8);
    offset += 8;
    ensure_available(8);
    offset += 8;

    ensure_available(1);
    offset += 1;

    ensure_available(1);
    const player_count = data.readUInt8(offset);
    offset += 1;

    ensure_available(8);
    offset += 8;
    ensure_available(8);
    offset += 8;

    ensure_available(1);
    const status_raw = data.readUInt8(offset);
    offset += 1;
    const status = this.decode_match_status(status_raw);

    ensure_available(8);
    const pot_lamports = Number(data.readBigUInt64LE(offset));
    offset += 8;
    if (!Number.isSafeInteger(pot_lamports)) {
      throw new app_error("invalid match pot amount", 502);
    }

    ensure_available(1);
    const winner_count = data.readUInt8(offset);
    offset += 1;

    ensure_available(2);
    const highest_score = data.readUInt16LE(offset);
    offset += 2;

    ensure_available(1);
    const recorded_result_count = data.readUInt8(offset);

    return {
      status,
      player_count,
      winner_count,
      highest_score,
      recorded_result_count,
      pot_lamports
    };
  }

  private decode_match_entry_account(data_buffer: Buffer | Uint8Array): chain_match_entry_snapshot {
    const data = Buffer.from(data_buffer);
    let offset = 8;

    const ensure_available = (bytes: number) => {
      if (offset + bytes > data.length) {
        throw new app_error("invalid match entry account data", 502);
      }
    };

    ensure_available(32);
    offset += 32;
    ensure_available(32);
    offset += 32;
    ensure_available(8);
    offset += 8;

    ensure_available(2);
    const score = data.readUInt16LE(offset);
    offset += 2;

    ensure_available(1);
    const joined = data.readUInt8(offset) === 1;
    offset += 1;

    ensure_available(1);
    const result_recorded = data.readUInt8(offset) === 1;
    offset += 1;

    ensure_available(1);
    const is_winner = data.readUInt8(offset) === 1;
    offset += 1;

    ensure_available(1);
    const claimed = data.readUInt8(offset) === 1;

    return {
      score,
      joined,
      result_recorded,
      is_winner,
      claimed
    };
  }

  private decode_match_status(raw: number): chain_match_status {
    if (raw === 0) {
      return "open";
    }
    if (raw === 1) {
      return "locked";
    }
    if (raw === 2) {
      return "resolved";
    }
    if (raw === 3) {
      return "cancelled";
    }
    throw new app_error("invalid match status", 502);
  }

  private async wait_for_account_owner(
    account_key: PublicKey,
    expected_owner: PublicKey,
    timeout_ms: number
  ): Promise<void> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout_ms) {
      const account = await this.base_connection.getAccountInfo(account_key, "confirmed");
      if (account && account.owner.equals(expected_owner)) {
        return;
      }
      await sleep(500);
    }

    throw new app_error("timed out waiting for account ownership sync from ER to base layer", 504);
  }

  private to_public_key(value: PublicKey | string): PublicKey {
    return value instanceof PublicKey ? value : new PublicKey(value);
  }

  private async send_base_transaction(instructions: TransactionInstruction[], operation_label: string): Promise<string> {
    return this.send_admin_transaction(this.base_connection, instructions, operation_label);
  }

  private async send_er_transaction(instructions: TransactionInstruction[], operation_label: string): Promise<string> {
    return this.send_admin_transaction(this.er_connection, instructions, operation_label);
  }

  private async send_admin_transaction(
    connection: Connection,
    instructions: TransactionInstruction[],
    operation_label: string
  ): Promise<string> {
    if (instructions.length === 0) {
      throw new app_error("cannot send empty transaction", 500);
    }

    const max_attempts = 3;
    let last_error: unknown = null;

    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      try {
        const latest = await connection.getLatestBlockhash("confirmed");
        const transaction = new Transaction({
          feePayer: this.admin.publicKey,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight
        });

        for (const instruction of instructions) {
          transaction.add(instruction);
        }

        transaction.sign(this.admin);

        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          preflightCommitment: "confirmed",
          maxRetries: 3
        });

        const confirmation = await connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight
          },
          "confirmed"
        );

        if (confirmation.value.err) {
          throw new Error(JSON.stringify(confirmation.value.err));
        }

        return signature;
      } catch (error) {
        last_error = error;
        if (attempt < max_attempts) {
          await sleep(300 * attempt);
          continue;
        }
      }
    }

    throw new app_error(
      `${operation_label} failed: ${this.format_error(last_error)}`,
      502
    );
  }

  private format_error(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
    return "unknown error";
  }

  private is_retryable_open_round_error(error_message: string): boolean {
    const text = error_message.toLowerCase();
    return (
      text.includes("constraintseeds") ||
      text.includes("error number: 2006") ||
      text.includes("already in use") ||
      text.includes("account address already in use")
    );
  }
}
