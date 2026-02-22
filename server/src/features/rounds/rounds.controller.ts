import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "@/shared/http-response";
import { app_error } from "@/shared/app-error";
import type { rounds_service } from "@/features/rounds/rounds.service";

const action_schema = z.object({
  side: z.enum(["yes", "no", "skip"]),
  amountLamports: z.coerce.number().int().nonnegative(),
  txSignature: z.string().min(20).max(128).nullable().optional()
});

const relay_prepare_schema = z.object({
  side: z.enum(["yes", "no", "skip"]),
  amountLamports: z.coerce.number().int().nonnegative()
});

const history_query_schema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  marketSlug: z.string().optional()
});

export class rounds_controller {
  constructor(private service: rounds_service) {}

  list_active = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send(ok(await this.service.list_active()));
  };

  list_history = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = history_query_schema.parse(request.query ?? {});
      reply.send(ok(await this.service.list_history(query.limit, query.marketSlug)));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  get_by_id = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const round_id = (request.params as any).roundId as string;
      reply.send(ok(await this.service.get_by_id(round_id)));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  upsert_action = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }
      const round_id = (request.params as any).roundId as string;
      const payload = action_schema.parse(request.body ?? {});
      const result = await this.service.upsert_action(
        round_id,
        wallet,
        payload.side,
        payload.amountLamports,
        payload.txSignature ?? null
      );
      reply.send(ok(result));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_relay_action = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const round_id = (request.params as any).roundId as string;
      const payload = relay_prepare_schema.parse(request.body ?? {});
      const prepared = await this.service.prepare_relay_action(
        round_id,
        wallet,
        payload.side,
        payload.amountLamports
      );

      reply.send(
        ok({
          transactionBase64: prepared.transaction_base64,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.last_valid_block_height,
          feePayer: prepared.fee_payer,
          amountLamports: prepared.amount_lamports
        })
      );
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
