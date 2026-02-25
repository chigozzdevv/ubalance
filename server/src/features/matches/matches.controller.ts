import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "@/shared/http-response";
import { app_error } from "@/shared/app-error";
import type { matches_service } from "@/features/matches/matches.service";

const list_query_schema = z.object({
  status: z.enum(["open", "locked", "resolved", "cancelled"]).optional(),
  marketSlug: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const create_match_schema = z.object({
  marketSlug: z.string().min(1),
  buyInLamports: z.coerce.number().int().positive(),
  maxPlayers: z.coerce.number().int().min(2).max(100),
  startAtMs: z.coerce.number().int().positive(),
  endAtMs: z.coerce.number().int().positive()
});

const confirm_tx_schema = z.object({
  txSignature: z.string().min(20).max(128)
});

export class matches_controller {
  constructor(private readonly service: matches_service) {}

  list = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = list_query_schema.parse(request.query ?? {});
      const rows = await this.service.list({
        status: query.status,
        market_slug: query.marketSlug,
        limit: query.limit
      });
      reply.send(ok(rows));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  get_by_id = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const match_id = (request.params as any).matchId as string;
      reply.send(ok(await this.service.get_by_id(match_id)));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  create_match = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const payload = create_match_schema.parse(request.body ?? {});
      const created = await this.service.create_match({
        admin_wallet: wallet,
        market_slug: payload.marketSlug,
        buy_in_lamports: payload.buyInLamports,
        max_players: payload.maxPlayers,
        start_at_ms: payload.startAtMs,
        end_at_ms: payload.endAtMs
      });
      reply.send(ok(created));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_join_relay = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const prepared = await this.service.prepare_join_relay({
        match_id,
        wallet
      });

      reply.send(ok({
        transactionBase64: prepared.transaction_base64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
        feePayer: prepared.fee_payer,
        matchPda: prepared.match_pda,
        matchEntryPda: prepared.match_entry_pda
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  confirm_join = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const payload = confirm_tx_schema.parse(request.body ?? {});
      const updated = await this.service.confirm_join({
        match_id,
        wallet,
        tx_signature: payload.txSignature
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  finalize_match = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const updated = await this.service.finalize_match({
        admin_wallet: wallet,
        match_id
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  cancel_match = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const updated = await this.service.cancel_match({
        admin_wallet: wallet,
        match_id
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_claim_relay = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const prepared = await this.service.prepare_claim_relay({
        match_id,
        wallet
      });

      reply.send(ok({
        transactionBase64: prepared.transaction_base64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
        feePayer: prepared.fee_payer,
        matchPda: prepared.match_pda,
        matchEntryPda: prepared.match_entry_pda
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  confirm_claim = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const match_id = (request.params as any).matchId as string;
      const payload = confirm_tx_schema.parse(request.body ?? {});
      const updated = await this.service.confirm_claim({
        match_id,
        wallet,
        tx_signature: payload.txSignature
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  private handle_error(error: unknown, reply: FastifyReply): void {
    if (error instanceof app_error) {
      reply.code(error.status_code).send({ success: false, message: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.code(400).send({ success: false, message: error.issues[0]?.message ?? "invalid payload" });
      return;
    }
    reply.code(500).send({ success: false, message: "internal server error" });
  }
}
