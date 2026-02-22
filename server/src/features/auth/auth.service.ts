import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type { challenge_record, session_record } from "@/features/auth/auth.model";

export class auth_service {
  private challenges = new Map<string, challenge_record>();
  private sessions = new Map<string, session_record>();

  request_challenge(wallet: string): challenge_record {
    this.assert_wallet(wallet);
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
    this.challenges.set(wallet, challenge);
    return challenge;
  }

  verify_challenge(wallet: string, signature: string): session_record {
    this.assert_wallet(wallet);
    const challenge = this.challenges.get(wallet);
    if (!challenge) {
      throw new app_error("challenge not found", 404);
    }
    if (challenge.expires_at_ms < Date.now()) {
      this.challenges.delete(wallet);
      throw new app_error("challenge expired", 401);
    }

    const signature_bytes = this.decode_signature(signature);
    const message_bytes = new TextEncoder().encode(challenge.message);
    const wallet_bytes = new PublicKey(wallet).toBytes();

    const valid = nacl.sign.detached.verify(message_bytes, signature_bytes, wallet_bytes);
    if (!valid) {
      throw new app_error("invalid signature", 401);
    }

    this.challenges.delete(wallet);
    const session: session_record = {
      wallet,
      token: randomUUID(),
      expires_at_ms: Date.now() + env.AUTH_SESSION_TTL_SECONDS * 1000
    };
    this.sessions.set(session.token, session);
    return session;
  }

  get_session(token: string): session_record {
    const session = this.sessions.get(token);
    if (!session) {
      throw new app_error("invalid session", 401);
    }
    if (session.expires_at_ms < Date.now()) {
      this.sessions.delete(token);
      throw new app_error("session expired", 401);
    }
    return session;
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
