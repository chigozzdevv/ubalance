import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import type { decision_side } from "@/types/round";

const program_default = "FkZVTshsawSNHYzxFZFfdBJUbLxvQJVhWtJqi8FgunFG";
const place_prediction_discriminator = Buffer.from("4f2ec3c5325b58e5", "hex");

const encode_u8 = (value: number): Buffer => Buffer.from([value & 0xff]);

const encode_u64 = (value: number | bigint): Buffer => {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  const low = normalized % 0x1_0000_0000;
  const high = Math.floor(normalized / 0x1_0000_0000);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(low, 0);
  buffer.writeUInt32LE(high, 4);
  return buffer;
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

export const resolve_program_id = (program_id: string | undefined): PublicKey => {
  return new PublicKey(program_id || program_default);
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
    place_prediction_discriminator,
    encode_side(args.side),
    encode_u64(args.amount_lamports)
  ]);

  return new TransactionInstruction({
    programId: args.program_id,
    keys: [
      { pubkey: args.user, isWritable: true, isSigner: true },
      { pubkey: args.market_pda, isWritable: false, isSigner: false },
      { pubkey: args.round_pda, isWritable: true, isSigner: false }
    ],
    data
  });
};
