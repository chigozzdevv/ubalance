import type { FastifyInstance } from "fastify";
import type { auth_controller } from "@/features/auth/auth.controller";

export const register_auth_routes = async (
  fastify: FastifyInstance,
  controller: auth_controller,
  require_auth: (request: any, reply: any) => Promise<void>
) => {
  fastify.post("/challenge", controller.request_challenge);
  fastify.post("/verify", controller.verify_challenge);
  fastify.get("/me", { preHandler: require_auth }, controller.me);
};
