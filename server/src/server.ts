import { env } from "@/config/env";
import { build_app } from "@/app";

const start = async () => {
  const app = await build_app();
  await app.listen({
    host: env.HOST,
    port: Number(env.PORT)
  });
};

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
