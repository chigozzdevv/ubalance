import type { FastifyInstance } from "fastify";
import type { ai_duels_controller } from "@/features/ai-duels/ai-duels.controller";

export const register_ai_duels_routes = async (
  fastify: FastifyInstance,
  controller: ai_duels_controller,
  require_auth: (request: any, reply: any) => Promise<void>
) => {
  fastify.get("/", controller.list);
  fastify.get("/:duelId", controller.get_by_id);

  fastify.post("/house/ensure", { preHandler: require_auth }, controller.ensure_house_bankroll);
  fastify.post("/house/fund", { preHandler: require_auth }, controller.fund_house_bankroll);
  fastify.post("/house/withdraw", { preHandler: require_auth }, controller.withdraw_house_bankroll);
  fastify.post("/house/active", { preHandler: require_auth }, controller.set_house_bankroll_active);

  fastify.post("/open/relay-prepare", { preHandler: require_auth }, controller.prepare_open_relay);
  fastify.post("/:duelId/open", { preHandler: require_auth }, controller.confirm_open);
  fastify.post("/:duelId/turns/relay-prepare", { preHandler: require_auth }, controller.prepare_append_turn_relay);
  fastify.post("/:duelId/turns", { preHandler: require_auth }, controller.confirm_append_turn);
  fastify.post("/:duelId/reveal-settle", { preHandler: require_auth }, controller.reveal_and_settle);
  fastify.post("/:duelId/claims/relay-prepare", { preHandler: require_auth }, controller.prepare_claim_relay);
  fastify.post("/:duelId/claims", { preHandler: require_auth }, controller.confirm_claim);
};
