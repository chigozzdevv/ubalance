import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount
} from "@magicblock-labs/ephemeral-rollups-sdk";

const market_seed = Buffer.from("market");
const round_seed = Buffer.from("round");
const position_seed = Buffer.from("position");

export type decision_side = "yes" | "no" | "skip";

export type account_type =
  | { kind: "market"; admin: PublicKey; market_index: number }
  | { kind: "round"; market: PublicKey; round_number: number }
  | { kind: "position"; round: PublicKey; user: PublicKey };

const encode_u8 = (value: number): Buffer => Buffer.from([value & 0xff]);

const encode_u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
};

const encode_u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};

const encode_u64 = (value: number | bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
};

const encode_i64 = (value: number | bigint): Buffer => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(BigInt(value), 0);
  return buffer;
};

const encode_string = (value: string): Buffer => {
  const raw = Buffer.from(value, "utf8");
  return Buffer.concat([encode_u32(raw.length), raw]);
};

const instruction_discriminator = (name: string): Buffer => {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
};

const encode_side = (side: decision_side): Buffer => {
  if (side === "yes") {
    return encode_u8(0);
  }
  if (side === "no") {
    return encode_u8(1);
  }
  return encode_u8(2);
};

const encode_account_type = (account: account_type): Buffer => {
  if (account.kind === "market") {
    return Buffer.concat([encode_u8(0), account.admin.toBuffer(), encode_u16(account.market_index)]);
  }
  if (account.kind === "round") {
    return Buffer.concat([encode_u8(1), account.market.toBuffer(), encode_u64(account.round_number)]);
  }
  return Buffer.concat([encode_u8(2), account.round.toBuffer(), account.user.toBuffer()]);
};

export const derive_market_pda = (program_id: PublicKey, admin: PublicKey, market_index: number): PublicKey => {
  return PublicKey.findProgramAddressSync([market_seed, admin.toBuffer(), encode_u16(market_index)], program_id)[0];
};

export const derive_round_pda = (program_id: PublicKey, market_pda: PublicKey, round_number: number): PublicKey => {
  return PublicKey.findProgramAddressSync([round_seed, market_pda.toBuffer(), encode_u64(round_number)], program_id)[0];
};

export const derive_position_pda = (program_id: PublicKey, round_pda: PublicKey, user: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync([position_seed, round_pda.toBuffer(), user.toBuffer()], program_id)[0];
};

export const create_initialize_market_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  market_index: number;
  name: string;
  timeframe_seconds: number;
}): TransactionInstruction => {
  const data = Buffer.concat([
    instruction_discriminator("initialize_market"),
    encode_u16(args.market_index),
    encode_string(args.name),
    encode_u32(args.timeframe_seconds)
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_set_market_active_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  is_active: boolean;
}): TransactionInstruction => {
  const data = Buffer.concat([instruction_discriminator("set_market_active"), encode_u8(args.is_active ? 1 : 0)]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: true, isSigner: false }
    ],
    data
  });
};

export const create_open_round_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  reference_price: number;
  open_at_ts: number;
  close_at_ts: number;
}): TransactionInstruction => {
  const data = Buffer.concat([
    instruction_discriminator("open_round"),
    encode_u64(args.reference_price),
    encode_i64(args.open_at_ts),
    encode_i64(args.close_at_ts)
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: true, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_place_prediction_instruction = (args: {
  program_id: PublicKey;
  user: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  side: decision_side;
  amount_lamports: number;
}): TransactionInstruction => {
  const data = Buffer.concat([
    instruction_discriminator("place_prediction"),
    encode_side(args.side),
    encode_u64(args.amount_lamports)
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.user, isWritable: false, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false }
    ],
    data
  });
};

export const create_commit_and_undelegate_round_instruction = (args: {
  program_id: PublicKey;
  payer: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.payer, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("commit_and_undelegate_round")
  });
};

export const create_lock_round_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("lock_round")
  });
};

export const create_resolve_round_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  settlement_price: number;
}): TransactionInstruction => {
  const data = Buffer.concat([instruction_discriminator("resolve_round"), encode_u64(args.settlement_price)]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false }
    ],
    data
  });
};

export const create_program_delegate_pda_instruction = (args: {
  program_id: PublicKey;
  payer: PublicKey;
  pda: PublicKey;
  account_type: account_type;
  validator: PublicKey | null;
}): TransactionInstruction => {
  const data = Buffer.concat([instruction_discriminator("delegate_pda"), encode_account_type(args.account_type)]);
  const buffer_pda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(args.pda, args.program_id);
  const delegation_record_pda = delegationRecordPdaFromDelegatedAccount(args.pda);
  const delegation_metadata_pda = delegationMetadataPdaFromDelegatedAccount(args.pda);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: buffer_pda, isWritable: true, isSigner: false },
      { pubkey: delegation_record_pda, isWritable: true, isSigner: false },
      { pubkey: delegation_metadata_pda, isWritable: true, isSigner: false },
      { pubkey: args.pda, isWritable: true, isSigner: false },
      { pubkey: args.payer, isWritable: false, isSigner: true },
      ...(args.validator ? [{ pubkey: args.validator, isWritable: false, isSigner: false }] : []),
      { pubkey: args.program_id, isWritable: false, isSigner: false },
      { pubkey: DELEGATION_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};
