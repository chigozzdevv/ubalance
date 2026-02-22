import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "@/shared/http-response";
import { app_error } from "@/shared/app-error";
import type { auth_service } from "@/features/auth/auth.service";

const challenge_schema = z.object({
  wallet: z.string().min(32)
});

const verify_schema = z.object({
  wallet: z.string().min(32),
  signature: z.string().min(32)
});

export class auth_controller {
  constructor(private service: auth_service) {}

  request_challenge = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = challenge_schema.parse(request.body ?? {});
      const challenge = await this.service.request_challenge(payload.wallet);
      reply.send(ok({
        wallet: challenge.wallet,
        message: challenge.message,
        expiresAtMs: challenge.expires_at_ms
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  verify_challenge = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = verify_schema.parse(request.body ?? {});
      const session = await this.service.verify_challenge(payload.wallet, payload.signature);
      reply.send(ok({
        wallet: session.wallet,
        token: session.token,
        expiresAtMs: session.expires_at_ms
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  me = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.auth_wallet) {
      reply.code(401).send({ success: false, message: "unauthorized" });
      return;
    }
    reply.send(ok({ wallet: request.auth_wallet }));
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
