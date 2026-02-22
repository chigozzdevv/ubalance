import type { FastifyInstance } from "fastify";
import type { markets_controller } from "@/features/markets/markets.controller";

export const register_markets_routes = async (
  fastify: FastifyInstance,
  controller: markets_controller
) => {
  fastify.get("/", controller.list);
  fastify.get("/:slug", controller.get_by_slug);
};
