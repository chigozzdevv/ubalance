import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "@/shared/http-response";
import type { markets_service } from "@/features/markets/markets.service";

export class markets_controller {
  constructor(private service: markets_service) {}

  list = async (request: FastifyRequest, reply: FastifyReply) => {
    const active_only = request.query
      ? !(request.query as any).includeInactive
      : true;
    reply.send(ok(await this.service.list(active_only)));
  };

  get_by_slug = async (request: FastifyRequest, reply: FastifyReply) => {
    const slug = (request.params as any).slug as string;
    const market = await this.service.get_by_slug(slug);
    if (!market) {
      reply.code(404).send({ success: false, message: "market not found" });
      return;
    }
    reply.send(ok(market));
  };
}
