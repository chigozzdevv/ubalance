import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

const script_dir = dirname(fileURLToPath(import.meta.url));
const server_dir = resolve(script_dir, "..");

const env_or = (key, fallback) => {
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
};

const parse_args = () => {
  const args = process.argv.slice(2);
  const options = {
    iterations: Number(env_or("SMOKE_ITERATIONS", "1")),
    market_slug: env_or("SMOKE_MARKET_SLUG", ""),
    side: env_or("SMOKE_SIDE", "yes"),
    amount_sol: Number(env_or("SMOKE_AMOUNT_SOL", "0.01")),
    min_balance_sol: Number(env_or("SMOKE_MIN_BALANCE_SOL", "0.05")),
    min_admin_balance_sol: Number(env_or("SMOKE_MIN_ADMIN_BALANCE_SOL", "0.05")),
    min_round_window_ms: Number(env_or("SMOKE_MIN_ROUND_WINDOW_MS", "25000")),
    poll_ms: Number(env_or("SMOKE_POLL_MS", "3000")),
    timeout_ms: Number(env_or("SMOKE_TIMEOUT_MS", "420000")),
    boot_server: true,
    keypair_path: env_or("SMOKE_USER_KEYPAIR_PATH", ".keys/ubalance-smoke-user-keypair.json")
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    if (token === "--iterations" && next) {
      options.iterations = Number(next);
      index += 1;
      continue;
    }
    if (token === "--market" && next) {
      options.market_slug = next;
      index += 1;
      continue;
    }
    if (token === "--side" && next) {
      options.side = next;
      index += 1;
      continue;
    }
    if (token === "--amount-sol" && next) {
      options.amount_sol = Number(next);
      index += 1;
      continue;
    }
    if (token === "--min-balance-sol" && next) {
      options.min_balance_sol = Number(next);
      index += 1;
      continue;
    }
    if (token === "--keypair" && next) {
      options.keypair_path = next;
      index += 1;
      continue;
    }
    if (token === "--reuse-server") {
      options.boot_server = false;
      continue;
    }
  }

  if (!Number.isFinite(options.iterations) || options.iterations < 1) {
    throw new Error("iterations must be a positive number");
  }
  if (!["yes", "no", "skip"].includes(options.side)) {
    throw new Error("side must be one of: yes, no, skip");
  }
  if (!Number.isFinite(options.amount_sol) || options.amount_sol <= 0) {
    throw new Error("amount-sol must be > 0");
  }

  return options;
};

const options = parse_args();

const port = Number(env_or("PORT", "3001"));
const host = env_or("HOST", "0.0.0.0");
const api_base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/api/v1`;
const health_url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/health`;
const er_rpc_url = env_or("ER_RPC_URL", "https://devnet-us.magicblock.app");
const er_ws_url = env_or("ER_WS_URL", "wss://devnet-us.magicblock.app");
const base_rpc_url = env_or("SOLANA_RPC_URL", "https://api.devnet.solana.com");

const log = (message) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
};

const sleep = async (ms) => {
  await new Promise((resolve_sleep) => setTimeout(resolve_sleep, ms));
};

const is_retryable_relay_error = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("blockhash not found") ||
    normalized.includes("transactionexpiredblockheightexceeded") ||
    normalized.includes("block height exceeded")
  );
};

const normalized_keypair_path = isAbsolute(options.keypair_path)
  ? options.keypair_path
  : resolve(server_dir, options.keypair_path);

const load_keypair = async (keypair_path) => {
  const raw = await readFile(keypair_path, "utf8").catch(() => null);
  if (!raw) {
    throw new Error(
      `missing smoke wallet keypair at ${keypair_path}. Run: npm run generate-smoke-keypair`
    );
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length < 64) {
    throw new Error("invalid smoke wallet keypair format");
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
};

const load_admin_public_key = () => {
  const raw = env_or("UBALANCE_ADMIN_SECRET_KEY", "");
  if (!raw) {
    throw new Error("UBALANCE_ADMIN_SECRET_KEY is required for server lifecycle transactions");
  }

  const trimmed = raw.trim();
  const secret = trimmed.startsWith("[")
    ? Uint8Array.from(JSON.parse(trimmed))
    : bs58.decode(trimmed);

  return Keypair.fromSecretKey(secret).publicKey;
};

const parse_json = async (response) => {
  return response.json().catch(() => ({}));
};

const api_get = async (path, token) => {
  const response = await fetch(`${api_base}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  const body = await parse_json(response);
  if (!response.ok) {
    throw new Error(body.message || `GET ${path} failed with ${response.status}`);
  }
  return body;
};

const api_post = async (path, payload, token) => {
  const response = await fetch(`${api_base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload)
  });

  const body = await parse_json(response);
  if (!response.ok) {
    throw new Error(body.message || `POST ${path} failed with ${response.status}`);
  }
  return body;
};

const wait_for_health = async (timeout_ms) => {
  const started_at = Date.now();
  while (Date.now() - started_at < timeout_ms) {
    try {
      const response = await fetch(health_url);
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  return false;
};

const maybe_start_server = async () => {
  const already_up = await wait_for_health(1200);
  if (already_up) {
    log("server already running, reusing existing instance");
    return { process: null, started_here: false };
  }

  if (!options.boot_server) {
    throw new Error("server is not running and --reuse-server was set");
  }

  log("starting server process for smoke run");
  const server_process = spawn("npm", ["run", "start"], {
    cwd: server_dir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  server_process.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  server_process.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  const became_healthy = await wait_for_health(90_000);
  if (!became_healthy) {
    server_process.kill("SIGTERM");
    throw new Error("server failed to become healthy within timeout");
  }

  log("server is healthy");
  return { process: server_process, started_here: true };
};

const wait_for_predicting_round = async (market_slug, min_round_window_ms, timeout_ms) => {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    const active = await api_get("/rounds/active");
    const rounds = Array.isArray(active.data) ? active.data : [];

    const candidates = rounds
      .filter((round) => round.status === "predicting")
      .filter((round) => !market_slug || round.market.slug === market_slug)
      .filter((round) => Number(round.closeAtMs) - Date.now() > min_round_window_ms)
      .sort((a, b) => Number(a.closeAtMs) - Number(b.closeAtMs));

    if (candidates.length > 0) {
      return candidates[0];
    }

    await sleep(options.poll_ms);
  }

  throw new Error("timed out waiting for a usable predicting round");
};

const authenticate = async (wallet_keypair) => {
  const wallet = wallet_keypair.publicKey.toBase58();
  const challenge_response = await api_post("/auth/challenge", { wallet });
  const message = challenge_response?.data?.message;
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("invalid auth challenge response");
  }

  const message_bytes = new TextEncoder().encode(message);
  const signature_bytes = nacl.sign.detached(message_bytes, wallet_keypair.secretKey);
  const signature = bs58.encode(signature_bytes);

  const verify_response = await api_post("/auth/verify", { wallet, signature });
  const token = verify_response?.data?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("invalid auth verify response");
  }

  return token;
};

const place_prediction_via_relay = async (wallet_keypair, round_id, side, amount_lamports, session_token) => {
  const connection = new Connection(er_rpc_url, {
    commitment: "confirmed",
    wsEndpoint: er_ws_url
  });
  const max_attempts = 2;
  let last_error = null;

  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    try {
      const prepared = await api_post(
        `/rounds/${round_id}/actions/relay-prepare`,
        {
          side,
          amountLamports: amount_lamports
        },
        session_token
      );
      const transaction_base64 = prepared?.data?.transactionBase64;
      const blockhash = prepared?.data?.blockhash;
      const last_valid_block_height = prepared?.data?.lastValidBlockHeight;
      if (
        typeof transaction_base64 !== "string" ||
        typeof blockhash !== "string" ||
        !Number.isFinite(last_valid_block_height)
      ) {
        throw new Error("invalid relay-prepare response");
      }

      const transaction = Transaction.from(Buffer.from(transaction_base64, "base64"));
      transaction.partialSign(wallet_keypair);

      const tx_signature = await connection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: "confirmed",
        maxRetries: 3
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature: tx_signature,
          blockhash,
          lastValidBlockHeight: last_valid_block_height
        },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(JSON.stringify(confirmation.value.err));
      }

      return tx_signature;
    } catch (error) {
      last_error = error;
      if (attempt < max_attempts && is_retryable_relay_error(error)) {
        continue;
      }
      throw error;
    }
  }

  throw (last_error instanceof Error ? last_error : new Error("relay prediction failed"));
};

const claim_payout_via_relay = async (wallet_keypair, round_id, session_token) => {
  const connection = new Connection(base_rpc_url, "confirmed");
  const max_attempts = 2;
  let last_error = null;

  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    try {
      const prepared = await api_post(
        `/rounds/${round_id}/claims/relay-prepare`,
        {},
        session_token
      );
      const transaction_base64 = prepared?.data?.transactionBase64;
      const blockhash = prepared?.data?.blockhash;
      const last_valid_block_height = prepared?.data?.lastValidBlockHeight;
      if (
        typeof transaction_base64 !== "string" ||
        typeof blockhash !== "string" ||
        !Number.isFinite(last_valid_block_height)
      ) {
        throw new Error("invalid claim relay-prepare response");
      }

      const transaction = Transaction.from(Buffer.from(transaction_base64, "base64"));
      transaction.partialSign(wallet_keypair);

      const tx_signature = await connection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: "confirmed",
        maxRetries: 3
      });

      const confirmation = await connection.confirmTransaction(
        {
          signature: tx_signature,
          blockhash,
          lastValidBlockHeight: last_valid_block_height
        },
        "confirmed"
      );
      if (confirmation.value.err) {
        throw new Error(JSON.stringify(confirmation.value.err));
      }

      return tx_signature;
    } catch (error) {
      last_error = error;
      if (attempt < max_attempts && is_retryable_relay_error(error)) {
        continue;
      }
      throw error;
    }
  }

  throw (last_error instanceof Error ? last_error : new Error("relay claim failed"));
};

const wait_for_round_status = async (round_id, expected_status, timeout_ms) => {
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    const round_response = await api_get(`/rounds/${round_id}`);
    const round = round_response.data;
    if (round?.status === expected_status) {
      return round;
    }
    await sleep(options.poll_ms);
  }

  throw new Error(`timed out waiting for round ${round_id} to reach status ${expected_status}`);
};

const wait_for_round_delegated = async (round_pda_base58, timeout_ms) => {
  const base_connection = new Connection(base_rpc_url, "confirmed");
  const round_pda = new PublicKey(round_pda_base58);
  const started_at = Date.now();

  while (Date.now() - started_at < timeout_ms) {
    const account = await base_connection.getAccountInfo(round_pda, "confirmed");
    if (account && account.owner.equals(DELEGATION_PROGRAM_ID)) {
      return;
    }
    await sleep(options.poll_ms);
  }

  throw new Error(`timed out waiting for delegation of round ${round_pda_base58}`);
};

const ensure_wallet_funded = async (wallet_keypair) => {
  const base_connection = new Connection(base_rpc_url, "confirmed");
  const balance = await base_connection.getBalance(wallet_keypair.publicKey, "confirmed");
  const minimum = Math.floor(options.min_balance_sol * LAMPORTS_PER_SOL);

  if (balance < minimum) {
    throw new Error(
      `smoke wallet ${wallet_keypair.publicKey.toBase58()} balance too low: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, need >= ${options.min_balance_sol.toFixed(4)} SOL`
    );
  }

  log(`smoke wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
};

const ensure_admin_wallet_funded = async () => {
  const base_connection = new Connection(base_rpc_url, "confirmed");
  const admin_public_key = load_admin_public_key();
  const balance = await base_connection.getBalance(admin_public_key, "confirmed");
  const minimum = Math.floor(options.min_admin_balance_sol * LAMPORTS_PER_SOL);

  if (balance < minimum) {
    throw new Error(
      `admin wallet ${admin_public_key.toBase58()} balance too low: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, need >= ${options.min_admin_balance_sol.toFixed(4)} SOL`
    );
  }

  log(`admin wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
};

const run_iteration = async (iteration_index, session_token, wallet_keypair) => {
  const round = await wait_for_predicting_round(
    options.market_slug,
    options.min_round_window_ms,
    options.timeout_ms
  );

  const round_id = round.id;
  const amount_lamports = Math.max(1, Math.round(options.amount_sol * LAMPORTS_PER_SOL));

  log(`iteration ${iteration_index}: selected ${round_id} (${round.market.slug}), closes in ${Math.max(0, Math.round((Number(round.closeAtMs) - Date.now()) / 1000))}s`);
  await wait_for_round_delegated(round.roundPda, options.timeout_ms);

  const tx_signature = await place_prediction_via_relay(
    wallet_keypair,
    round_id,
    options.side,
    amount_lamports,
    session_token
  );
  log(`iteration ${iteration_index}: on-chain prediction tx ${tx_signature}`);

  await api_post(
    `/rounds/${round_id}/actions`,
    {
      side: options.side,
      amountLamports: amount_lamports,
      txSignature: tx_signature
    },
    session_token
  );
  log(`iteration ${iteration_index}: backend action recorded`);

  const locked_round = await wait_for_round_status(round_id, "locked", options.timeout_ms);
  if (!locked_round.lockTxSignature) {
    throw new Error(`iteration ${iteration_index}: round locked without lock tx signature`);
  }
  log(`iteration ${iteration_index}: round locked (${locked_round.lockTxSignature})`);

  const resolved_round = await wait_for_round_status(round_id, "resolved", options.timeout_ms);
  if (!resolved_round.resolveTxSignature) {
    throw new Error(`iteration ${iteration_index}: round resolved without resolve tx signature`);
  }

  log(
    `iteration ${iteration_index}: round resolved (${resolved_round.resolveTxSignature}), winner=${resolved_round.winningSide ?? "unknown"}, reference=${resolved_round.referencePrice}, settlement=${resolved_round.settlementPrice}`
  );

  if (options.side !== "skip" && resolved_round.winningSide === options.side) {
    const claim_signature = await claim_payout_via_relay(wallet_keypair, round_id, session_token);
    log(`iteration ${iteration_index}: claim submitted (${claim_signature})`);
  } else {
    log(`iteration ${iteration_index}: claim skipped (side=${options.side}, winner=${resolved_round.winningSide ?? "unknown"})`);
  }
};

const main = async () => {
  log("starting ER lifecycle smoke test");
  log(`api base: ${api_base}`);
  log(`er rpc: ${er_rpc_url}`);

  const wallet_keypair = await load_keypair(normalized_keypair_path);
  log(`smoke wallet: ${wallet_keypair.publicKey.toBase58()}`);

  await ensure_wallet_funded(wallet_keypair);
  await ensure_admin_wallet_funded();

  const server_handle = await maybe_start_server();

  const stop_server = async () => {
    if (server_handle.started_here && server_handle.process) {
      log("stopping server process");
      server_handle.process.kill("SIGTERM");
      await sleep(800);
    }
  };

  try {
    const session_token = await authenticate(wallet_keypair);
    log("authenticated with backend session token");

    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      await run_iteration(iteration, session_token, wallet_keypair);
    }

    log(`smoke lifecycle completed successfully (${options.iterations} iteration${options.iterations > 1 ? "s" : ""})`);
  } finally {
    await stop_server();
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
