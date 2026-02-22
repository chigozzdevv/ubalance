import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "@/shared/http-response";
import type { er_service } from "@/features/er/er.service";

export class er_controller {
  constructor(private service: er_service) {}

  list_validators = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send(ok(this.service.list_validators()));
  };

  connection_config = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.send(ok(this.service.get_connection_config()));
  };
}
