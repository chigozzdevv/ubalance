import type { FastifyReply, FastifyRequest } from "fastify";
import type { auth_service } from "@/features/auth/auth.service";

export const build_auth_guard = (service: auth_service) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply.code(401).send({ success: false, message: "missing bearer token" });
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      const session = await service.get_session(token);
      request.auth_wallet = session.wallet;
    } catch (error: any) {
      reply.code(401).send({ success: false, message: error.message || "unauthorized" });
    }
  };
};
