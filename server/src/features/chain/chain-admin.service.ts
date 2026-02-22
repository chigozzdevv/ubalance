import bs58 from "bs58";
import {
  DELEGATION_PROGRAM_ID,
  GetCommitmentSignature
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import {
  create_initialize_market_instruction,
  create_commit_and_undelegate_round_instruction,
  create_lock_round_instruction,
  create_open_round_instruction,
  create_program_delegate_pda_instruction,
  create_resolve_round_instruction,
  create_set_market_active_instruction,
  derive_market_pda,
  derive_round_pda
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

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve_sleep) => setTimeout(resolve_sleep, ms));
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

  async is_round_delegated(input: { market_index: number; round_number: number }): Promise<boolean> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);
    const account = await this.base_connection.getAccountInfo(round_pda, "confirmed");
    if (!account) {
      throw new app_error("round account not found on base layer", 404);
    }

    return account.owner.equals(DELEGATION_PROGRAM_ID);
  }

  async delegate_round_account(input: { market_index: number; round_number: number }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    const delegate_account_ix = create_program_delegate_pda_instruction({
      program_id: this.program_id,
      payer: this.admin.publicKey,
      pda: round_pda,
      account_type: {
        kind: "round",
        market: market_pda,
        round_number: input.round_number
      },
      validator: this.validator
    });

    return this.send_base_transaction([delegate_account_ix], "delegate round account");
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

    await this.wait_for_round_owner(round_pda, this.program_id, 20_000);

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
    settlement_price: number;
  }): Promise<string> {
    const market_pda = this.derive_market_pda(input.market_index);
    const round_pda = derive_round_pda(this.program_id, market_pda, input.round_number);

    const resolve_ix = create_resolve_round_instruction({
      program_id: this.program_id,
      admin: this.admin.publicKey,
      market_pda,
      round_pda,
      settlement_price: to_lamports_price(input.settlement_price)
    });

    return this.send_base_transaction([resolve_ix], "resolve round");
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
      if (side_raw === 0) {
        winning_side = "yes";
      } else if (side_raw === 1) {
        winning_side = "no";
      } else if (side_raw === 2) {
        winning_side = "skip";
      } else {
        throw new app_error("invalid resolved side", 502);
      }
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

  private async wait_for_round_owner(round_pda: PublicKey, expected_owner: PublicKey, timeout_ms: number): Promise<void> {
    const started_at = Date.now();

    while (Date.now() - started_at < timeout_ms) {
      const account = await this.base_connection.getAccountInfo(round_pda, "confirmed");
      if (account && account.owner.equals(expected_owner)) {
        return;
      }
      await sleep(500);
    }

    throw new app_error("timed out waiting for round ownership sync from ER to base layer", 504);
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
