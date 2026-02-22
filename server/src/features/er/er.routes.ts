import type { FastifyInstance } from "fastify";
import type { er_controller } from "@/features/er/er.controller";

export const register_er_routes = async (
  fastify: FastifyInstance,
  controller: er_controller
) => {
  fastify.get("/validators", controller.list_validators);
  fastify.get("/connection", controller.connection_config);
};
