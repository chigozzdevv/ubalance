import "dotenv/config";
import { z } from "zod";

const env_schema = z.object({
  PORT: z.string().default("3001"),
  HOST: z.string().default("0.0.0.0"),
  CLIENT_ORIGIN: z.string().default("http://localhost:3000"),
  ER_RPC_URL: z.string().default("https://devnet-us.magicblock.app"),
  ER_WS_URL: z.string().default("wss://devnet-us.magicblock.app"),
  PYTH_HERMES_URL: z.string().default("https://hermes.pyth.network"),
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  UBALANCE_PROGRAM_ID: z.string().default("FkZVTshsawSNHYzxFZFfdBJUbLxvQJVhWtJqi8FgunFG"),
  UBALANCE_ADMIN_SECRET_KEY: z.string().min(1),
  ER_VALIDATOR_PUBKEY: z.string().default("MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd"),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGODB_DB_NAME: z.string().default("ubalance_prediction_market"),
  ROUND_RESOLVE_DELAY_SECONDS: z.coerce.number().default(20),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().default(300),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().default(86400)
});

const parsed_env = env_schema.parse(process.env);

export const env = parsed_env;
