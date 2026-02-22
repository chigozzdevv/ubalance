import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type { challenge_record, session_record } from "@/features/auth/auth.model";
import type { mongo_service } from "@/shared/mongo";

export class auth_service {
  constructor(private readonly mongo: mongo_service) {}

  async request_challenge(wallet: string): Promise<challenge_record> {
    this.assert_wallet(wallet);
    await this.mongo.ensure_ready();

    const nonce = randomUUID();
    const issued_at = new Date().toISOString();
    const message = [
      "ubalance-prediction-market auth",
      `wallet: ${wallet}`,
      `nonce: ${nonce}`,
      `issued-at: ${issued_at}`
    ].join("\n");
    const challenge: challenge_record = {
      wallet,
      message,
      expires_at_ms: Date.now() + env.AUTH_CHALLENGE_TTL_SECONDS * 1000
    };

    await this.mongo.auth_challenges_collection.updateOne(
      { _id: wallet },
      {
        $set: {
          wallet: challenge.wallet,
          message: challenge.message,
          expires_at_ms: challenge.expires_at_ms,
          expires_at: new Date(challenge.expires_at_ms),
          updated_at_ms: Date.now()
        },
        $setOnInsert: {
          _id: wallet
        }
      },
      { upsert: true }
    );

    return challenge;
  }

  async verify_challenge(wallet: string, signature: string): Promise<session_record> {
    this.assert_wallet(wallet);
    await this.mongo.ensure_ready();

    const challenge_document = await this.mongo.auth_challenges_collection.findOne({ _id: wallet });
    if (!challenge_document) {
      throw new app_error("challenge not found", 404);
    }

    if (challenge_document.expires_at_ms < Date.now()) {
      await this.mongo.auth_challenges_collection.deleteOne({ _id: wallet });
      throw new app_error("challenge expired", 401);
    }

    const signature_bytes = this.decode_signature(signature);
    const message_bytes = new TextEncoder().encode(challenge_document.message);
    const wallet_bytes = new PublicKey(wallet).toBytes();

    const valid = nacl.sign.detached.verify(message_bytes, signature_bytes, wallet_bytes);
    if (!valid) {
      throw new app_error("invalid signature", 401);
    }

    await this.mongo.auth_challenges_collection.deleteOne({ _id: wallet });

    const session: session_record = {
      wallet,
      token: randomUUID(),
      expires_at_ms: Date.now() + env.AUTH_SESSION_TTL_SECONDS * 1000
    };

    await this.mongo.auth_sessions_collection.insertOne({
      _id: session.token,
      token: session.token,
      wallet: session.wallet,
      expires_at_ms: session.expires_at_ms,
      expires_at: new Date(session.expires_at_ms),
      created_at_ms: Date.now()
    });

    return session;
  }

  async get_session(token: string): Promise<session_record> {
    await this.mongo.ensure_ready();

    const session_document = await this.mongo.auth_sessions_collection.findOne({ _id: token });
    if (!session_document) {
      throw new app_error("invalid session", 401);
    }

    if (session_document.expires_at_ms < Date.now()) {
      await this.mongo.auth_sessions_collection.deleteOne({ _id: token });
      throw new app_error("session expired", 401);
    }

    return {
      wallet: session_document.wallet,
      token: session_document.token,
      expires_at_ms: session_document.expires_at_ms
    };
  }

  private decode_signature(signature: string): Uint8Array {
    try {
      return bs58.decode(signature);
    } catch {
      try {
        return Uint8Array.from(Buffer.from(signature, "base64"));
      } catch {
        throw new app_error("invalid signature format", 400);
      }
    }
  }

  private assert_wallet(wallet: string): void {
    try {
      new PublicKey(wallet);
    } catch {
      throw new app_error("invalid wallet address", 400);
    }
  }
}
