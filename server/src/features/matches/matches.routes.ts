import type { FastifyInstance } from "fastify";
import type { matches_controller } from "@/features/matches/matches.controller";

export const register_matches_routes = async (
  fastify: FastifyInstance,
  controller: matches_controller,
  require_auth: (request: any, reply: any) => Promise<void>
) => {
  fastify.get("/", controller.list);
  fastify.get("/:matchId", controller.get_by_id);
  fastify.post("/", { preHandler: require_auth }, controller.create_match);
  fastify.post("/:matchId/join/relay-prepare", { preHandler: require_auth }, controller.prepare_join_relay);
  fastify.post("/:matchId/join", { preHandler: require_auth }, controller.confirm_join);
  fastify.post("/:matchId/finalize", { preHandler: require_auth }, controller.finalize_match);
  fastify.post("/:matchId/cancel", { preHandler: require_auth }, controller.cancel_match);
  fastify.post("/:matchId/claims/relay-prepare", { preHandler: require_auth }, controller.prepare_claim_relay);
  fastify.post("/:matchId/claims", { preHandler: require_auth }, controller.confirm_claim);
};
