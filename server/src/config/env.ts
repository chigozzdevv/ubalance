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
  PYTH_PRICE_ACCOUNT_BTC_USD: z.string().optional().default(""),
  PYTH_PRICE_ACCOUNT_ETH_USD: z.string().optional().default(""),
  PYTH_PRICE_ACCOUNT_SOL_USD: z.string().optional().default(""),
  PYTH_PRICE_ACCOUNT_BNB_USD: z.string().optional().default(""),
  PYTH_PRICE_ACCOUNT_XRP_USD: z.string().optional().default(""),
  MONGODB_URI: z.string().default("mongodb://127.0.0.1:27017"),
  MONGODB_DB_NAME: z.string().default("ubalance_prediction_market"),
  ROUND_RESOLVE_DELAY_SECONDS: z.coerce.number().default(20),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_MODEL: z.string().default("gpt-5-mini"),
  OPENAI_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high", "none"]).default("low"),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  OPENAI_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().default(220),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  AI_MODEL_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),
  AI_MODEL_DECISION_RETRIES: z.coerce.number().int().min(1).max(5).default(2),
  AI_DUEL_MAX_STAKE_LAMPORTS: z.coerce.number().int().positive().default(50_000_000),
  AI_DUEL_MAX_TOTAL_OPEN_EXPOSURE_LAMPORTS: z.coerce.number().int().positive().default(2_000_000_000),
  AI_DUEL_MAX_MARKET_OPEN_EXPOSURE_LAMPORTS: z.coerce.number().int().positive().default(1_000_000_000),
  AI_DUEL_MAX_ROUND_OPEN_EXPOSURE_LAMPORTS: z.coerce.number().int().positive().default(400_000_000),
  AI_DUEL_MAX_WALLET_OPEN_EXPOSURE_LAMPORTS: z.coerce.number().int().positive().default(250_000_000),
  AI_DUEL_MAX_OPEN_DUELS_COUNT: z.coerce.number().int().positive().default(1_000),
  AI_DUEL_MAX_WALLET_OPEN_DUELS_COUNT: z.coerce.number().int().positive().default(30),
  AI_DUEL_MAX_TURNS_PER_DUEL: z.coerce.number().int().positive().default(32),
  AI_DUEL_REQUIRED_BANKROLL_COVERAGE_BPS: z.coerce.number().int().min(10_000).max(50_000).default(12_000),
  AI_DUEL_PREPARED_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  AUTH_CHALLENGE_TTL_SECONDS: z.coerce.number().default(300),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().default(86400)
});

const parsed_env = env_schema.parse(process.env);

export const env = parsed_env;
