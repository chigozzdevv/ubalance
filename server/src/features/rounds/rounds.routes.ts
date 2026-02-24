import type { FastifyInstance } from "fastify";
import type { rounds_controller } from "@/features/rounds/rounds.controller";

export const register_rounds_routes = async (
  fastify: FastifyInstance,
  controller: rounds_controller,
  require_auth: (request: any, reply: any) => Promise<void>
) => {
  fastify.get("/active", controller.list_active);
  fastify.get("/history", controller.list_history);
  fastify.get("/:roundId", controller.get_by_id);
  fastify.post("/:roundId/actions/relay-prepare", { preHandler: require_auth }, controller.prepare_relay_action);
  fastify.post("/:roundId/claims/relay-prepare", { preHandler: require_auth }, controller.prepare_relay_claim);
  fastify.post("/:roundId/actions", { preHandler: require_auth }, controller.upsert_action);
};
