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
const match_seed = Buffer.from("match");
const match_entry_seed = Buffer.from("match_entry");
const market_oracle_seed = Buffer.from("market_oracle");
const house_bankroll_seed = Buffer.from("house_bankroll");
const ai_duel_seed = Buffer.from("ai_duel");

export type decision_side = "yes" | "no" | "skip";

export type account_type =
  | { kind: "market"; admin: PublicKey; market_index: number }
  | { kind: "round"; market: PublicKey; round_number: number }
  | { kind: "position"; round: PublicKey; user: PublicKey }
  | { kind: "match"; market: PublicKey; match_id: number }
  | { kind: "match_entry"; match_account: PublicKey; player: PublicKey }
  | { kind: "house_bankroll"; admin: PublicKey }
  | { kind: "ai_duel"; market: PublicKey; player: PublicKey; duel_id: number };

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

const encode_vec = (items: Buffer[]): Buffer => {
  return Buffer.concat([encode_u32(items.length), ...items]);
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
  if (account.kind === "position") {
    return Buffer.concat([encode_u8(2), account.round.toBuffer(), account.user.toBuffer()]);
  }
  if (account.kind === "match") {
    return Buffer.concat([encode_u8(3), account.market.toBuffer(), encode_u64(account.match_id)]);
  }
  if (account.kind === "match_entry") {
    return Buffer.concat([encode_u8(4), account.match_account.toBuffer(), account.player.toBuffer()]);
  }
  if (account.kind === "house_bankroll") {
    return Buffer.concat([encode_u8(5), account.admin.toBuffer()]);
  }

  return Buffer.concat([
    encode_u8(6),
    account.market.toBuffer(),
    account.player.toBuffer(),
    encode_u64(account.duel_id)
  ]);
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

export const derive_match_pda = (program_id: PublicKey, market_pda: PublicKey, match_id: number): PublicKey => {
  return PublicKey.findProgramAddressSync([match_seed, market_pda.toBuffer(), encode_u64(match_id)], program_id)[0];
};

export const derive_match_entry_pda = (
  program_id: PublicKey,
  match_pda: PublicKey,
  player: PublicKey
): PublicKey => {
  return PublicKey.findProgramAddressSync([match_entry_seed, match_pda.toBuffer(), player.toBuffer()], program_id)[0];
};

export const derive_market_oracle_pda = (program_id: PublicKey, market_pda: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync([market_oracle_seed, market_pda.toBuffer()], program_id)[0];
};

export const derive_house_bankroll_pda = (program_id: PublicKey, admin: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync([house_bankroll_seed, admin.toBuffer()], program_id)[0];
};

export const derive_ai_duel_pda = (
  program_id: PublicKey,
  market_pda: PublicKey,
  player: PublicKey,
  duel_id: number
): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [ai_duel_seed, market_pda.toBuffer(), player.toBuffer(), encode_u64(duel_id)],
    program_id
  )[0];
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

export const create_init_market_oracle_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  market_oracle_pda: PublicKey;
  oracle_feed_id: Uint8Array;
}): TransactionInstruction => {
  const feed_id = Buffer.from(args.oracle_feed_id);
  if (feed_id.length !== 32) {
    throw new Error("oracle_feed_id must be 32 bytes");
  }
  const data = Buffer.concat([instruction_discriminator("init_market_oracle"), feed_id]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.market_oracle_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
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
  position_pda: PublicKey;
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
      { pubkey: args.user, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false },
      { pubkey: args.position_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_claim_payout_instruction = (args: {
  program_id: PublicKey;
  user: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  position_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.user, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false },
      { pubkey: args.position_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("claim_payout")
  });
};

export const create_create_match_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  match_pda: PublicKey;
  match_id: number;
  buy_in_lamports: number;
  max_players: number;
  start_at_ts: number;
  end_at_ts: number;
}): TransactionInstruction => {
  const data = Buffer.concat([
    instruction_discriminator("create_match"),
    encode_u64(args.match_id),
    encode_u64(args.buy_in_lamports),
    encode_u8(args.max_players),
    encode_i64(args.start_at_ts),
    encode_i64(args.end_at_ts)
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.match_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_join_match_instruction = (args: {
  program_id: PublicKey;
  player: PublicKey;
  match_pda: PublicKey;
  match_entry_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.player, isWritable: true, isSigner: true },
      { pubkey: args.match_pda, isWritable: true, isSigner: false },
      { pubkey: args.match_entry_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data: instruction_discriminator("join_match")
  });
};

export const create_lock_match_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  match_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.match_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("lock_match")
  });
};

export const create_set_match_entry_result_instruction = (args: {
  program_id: PublicKey;
  market_pda: PublicKey;
  match_pda: PublicKey;
  match_entry_pda: PublicKey;
  scoring_account_pairs: Array<{
    round_pda: PublicKey;
    position_pda: PublicKey;
  }>;
}): TransactionInstruction => {
  const keys = [
    { pubkey: args.market_pda, isWritable: false, isSigner: false },
    { pubkey: args.match_pda, isWritable: true, isSigner: false },
    { pubkey: args.match_entry_pda, isWritable: true, isSigner: false },
    ...args.scoring_account_pairs.flatMap((pair) => [
      { pubkey: pair.round_pda, isWritable: false, isSigner: false },
      { pubkey: pair.position_pda, isWritable: false, isSigner: false }
    ])
  ];

  return new TransactionInstruction({
    programId: args.program_id,
    keys,
    data: instruction_discriminator("set_match_entry_result")
  });
};

export const create_finalize_match_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  match_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.match_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("finalize_match")
  });
};

export const create_cancel_match_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  match_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.match_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("cancel_match")
  });
};

export const create_claim_match_payout_instruction = (args: {
  program_id: PublicKey;
  player: PublicKey;
  match_pda: PublicKey;
  match_entry_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.player, isWritable: true, isSigner: true },
      { pubkey: args.match_pda, isWritable: true, isSigner: false },
      { pubkey: args.match_entry_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("claim_match_payout")
  });
};

export const create_init_house_bankroll_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  house_bankroll_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data: instruction_discriminator("init_house_bankroll")
  });
};

export const create_set_house_bankroll_active_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  house_bankroll_pda: PublicKey;
  active: boolean;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false }
    ],
    data: Buffer.concat([
      instruction_discriminator("set_house_bankroll_active"),
      encode_u8(args.active ? 1 : 0)
    ])
  });
};

export const create_fund_house_bankroll_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  house_bankroll_pda: PublicKey;
  amount_lamports: number;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data: Buffer.concat([
      instruction_discriminator("fund_house_bankroll"),
      encode_u64(args.amount_lamports)
    ])
  });
};

export const create_withdraw_house_bankroll_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  house_bankroll_pda: PublicKey;
  amount_lamports: number;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false }
    ],
    data: Buffer.concat([
      instruction_discriminator("withdraw_house_bankroll"),
      encode_u64(args.amount_lamports)
    ])
  });
};

export const create_open_ai_duel_instruction = (args: {
  program_id: PublicKey;
  player: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  house_bankroll_pda: PublicKey;
  ai_duel_pda: PublicKey;
  duel_id: number;
  player_side: decision_side;
  amount_lamports: number;
  ai_commitment: Uint8Array;
}): TransactionInstruction => {
  const commitment = Buffer.from(args.ai_commitment);
  if (commitment.length !== 32) {
    throw new Error("ai_commitment must be 32 bytes");
  }

  const data = Buffer.concat([
    instruction_discriminator("open_ai_duel"),
    encode_u64(args.duel_id),
    encode_side(args.player_side),
    encode_u64(args.amount_lamports),
    commitment
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.player, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: false, isSigner: false },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false },
      { pubkey: args.ai_duel_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_append_ai_duel_turn_instruction = (args: {
  program_id: PublicKey;
  player: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  house_bankroll_pda: PublicKey;
  ai_duel_pda: PublicKey;
  duel_id: number;
  player_side: decision_side;
  amount_lamports: number;
  ai_commitment: Uint8Array;
}): TransactionInstruction => {
  const commitment = Buffer.from(args.ai_commitment);
  if (commitment.length !== 32) {
    throw new Error("ai_commitment must be 32 bytes");
  }

  const data = Buffer.concat([
    instruction_discriminator("append_ai_duel_turn"),
    encode_u64(args.duel_id),
    encode_side(args.player_side),
    encode_u64(args.amount_lamports),
    commitment
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.player, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: false, isSigner: false },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false },
      { pubkey: args.ai_duel_pda, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false }
    ],
    data
  });
};

export const create_reveal_ai_duel_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  ai_duel_pda: PublicKey;
  ai_side: decision_side;
  nonce: Uint8Array;
}): TransactionInstruction => {
  const nonce = Buffer.from(args.nonce);
  if (nonce.length !== 32) {
    throw new Error("nonce must be 32 bytes");
  }

  const data = Buffer.concat([
    instruction_discriminator("reveal_ai_duel"),
    encode_side(args.ai_side),
    nonce
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.ai_duel_pda, isWritable: true, isSigner: false }
    ],
    data
  });
};

export const create_settle_ai_duel_instruction = (args: {
  program_id: PublicKey;
  admin: PublicKey;
  market_pda: PublicKey;
  round_pda: PublicKey;
  house_bankroll_pda: PublicKey;
  ai_duel_pda: PublicKey;
  ai_sides: decision_side[];
  nonces: Uint8Array[];
}): TransactionInstruction => {
  if (args.ai_sides.length !== args.nonces.length) {
    throw new Error("ai_sides and nonces length mismatch");
  }

  const encoded_sides = encode_vec(args.ai_sides.map((side) => encode_side(side)));
  const encoded_nonces = encode_vec(
    args.nonces.map((nonce_raw) => {
      const nonce = Buffer.from(nonce_raw);
      if (nonce.length !== 32) {
        throw new Error("nonce must be 32 bytes");
      }
      return nonce;
    })
  );

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.admin, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: false, isSigner: false },
      { pubkey: args.house_bankroll_pda, isWritable: true, isSigner: false },
      { pubkey: args.ai_duel_pda, isWritable: true, isSigner: false }
    ],
    data: Buffer.concat([
      instruction_discriminator("settle_ai_duel"),
      encoded_sides,
      encoded_nonces
    ])
  });
};

export const create_claim_ai_duel_payout_instruction = (args: {
  program_id: PublicKey;
  player: PublicKey;
  ai_duel_pda: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.player, isWritable: true, isSigner: true },
      { pubkey: args.ai_duel_pda, isWritable: true, isSigner: false }
    ],
    data: instruction_discriminator("claim_ai_duel_payout")
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

export const create_commit_and_undelegate_pda_instruction = (args: {
  program_id: PublicKey;
  payer: PublicKey;
  pda: PublicKey;
  account_type: account_type;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.payer, isWritable: true, isSigner: true },
      { pubkey: args.pda, isWritable: true, isSigner: false },
      { pubkey: MAGIC_PROGRAM_ID, isWritable: false, isSigner: false },
      { pubkey: MAGIC_CONTEXT_ID, isWritable: true, isSigner: false }
    ],
    data: Buffer.concat([
      instruction_discriminator("commit_and_undelegate_pda"),
      encode_account_type(args.account_type)
    ])
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
  market_pda: PublicKey;
  platform_fee_receiver: PublicKey;
  market_oracle_pda: PublicKey;
  round_pda: PublicKey;
  oracle_price_feed: PublicKey;
}): TransactionInstruction => {
  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.platform_fee_receiver, isWritable: true, isSigner: false },
      { pubkey: args.market_oracle_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false },
      { pubkey: args.oracle_price_feed, isWritable: false, isSigner: false }
    ],
    data: instruction_discriminator("resolve_round")
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
