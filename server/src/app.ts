import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "@/config/env";
import { register_routes } from "@/routes/index";

export const build_app = async () => {
  const app = Fastify({
    logger: true,
    pluginTimeout: 120_000
  });

  await app.register(cors, {
    origin: env.CLIENT_ORIGIN,
    credentials: true
  });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(async (scope) => {
    await register_routes(scope);
  }, { prefix: "/api/v1" });

  return app;
};
