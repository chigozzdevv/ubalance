import type { FastifyInstance } from "fastify";
import { auth_service } from "@/features/auth/auth.service";
import { auth_controller } from "@/features/auth/auth.controller";
import { build_auth_guard } from "@/features/auth/auth.guard";
import { register_auth_routes } from "@/features/auth/auth.routes";
import { chain_admin_service } from "@/features/chain/chain-admin.service";
import { markets_service } from "@/features/markets/markets.service";
import { markets_controller } from "@/features/markets/markets.controller";
import { register_markets_routes } from "@/features/markets/markets.routes";
import { oracle_service } from "@/features/oracle/oracle.service";
import { rounds_service } from "@/features/rounds/rounds.service";
import { rounds_controller } from "@/features/rounds/rounds.controller";
import { register_rounds_routes } from "@/features/rounds/rounds.routes";
import { matches_service } from "@/features/matches/matches.service";
import { matches_controller } from "@/features/matches/matches.controller";
import { register_matches_routes } from "@/features/matches/matches.routes";
import { ai_duels_service } from "@/features/ai-duels/ai-duels.service";
import { ai_decision_service } from "@/features/ai-duels/ai-decision.service";
import { ai_duels_controller } from "@/features/ai-duels/ai-duels.controller";
import { register_ai_duels_routes } from "@/features/ai-duels/ai-duels.routes";
import { er_service } from "@/features/er/er.service";
import { er_controller } from "@/features/er/er.controller";
import { register_er_routes } from "@/features/er/er.routes";
import { mongo_service } from "@/shared/mongo";

export const register_routes = async (fastify: FastifyInstance) => {
  const mongo_service_instance = new mongo_service();
  const auth_service_instance = new auth_service(mongo_service_instance);
  const chain_admin_service_instance = new chain_admin_service();
  const oracle_service_instance = new oracle_service();
  const markets_service_instance = new markets_service(
    mongo_service_instance,
    chain_admin_service_instance,
    oracle_service_instance
  );
  const rounds_service_instance = new rounds_service(
    mongo_service_instance,
    markets_service_instance,
    oracle_service_instance,
    chain_admin_service_instance
  );
  const ai_decision_service_instance = new ai_decision_service(oracle_service_instance);
  const matches_service_instance = new matches_service(
    mongo_service_instance,
    markets_service_instance,
    chain_admin_service_instance
  );
  const ai_duels_service_instance = new ai_duels_service(
    mongo_service_instance,
    markets_service_instance,
    chain_admin_service_instance,
    ai_decision_service_instance
  );
  const er_service_instance = new er_service();

  const auth_controller_instance = new auth_controller(auth_service_instance);
  const markets_controller_instance = new markets_controller(markets_service_instance);
  const rounds_controller_instance = new rounds_controller(rounds_service_instance);
  const matches_controller_instance = new matches_controller(matches_service_instance);
  const ai_duels_controller_instance = new ai_duels_controller(ai_duels_service_instance);
  const er_controller_instance = new er_controller(er_service_instance);

  const require_auth = build_auth_guard(auth_service_instance);

  await fastify.register(async (auth_scope) => {
    await register_auth_routes(auth_scope, auth_controller_instance, require_auth);
  }, { prefix: "/auth" });

  await fastify.register(async (market_scope) => {
    await register_markets_routes(market_scope, markets_controller_instance);
  }, { prefix: "/markets" });

  await fastify.register(async (round_scope) => {
    await register_rounds_routes(round_scope, rounds_controller_instance, require_auth);
  }, { prefix: "/rounds" });

  await fastify.register(async (match_scope) => {
    await register_matches_routes(match_scope, matches_controller_instance, require_auth);
  }, { prefix: "/matches" });

  await fastify.register(async (ai_duel_scope) => {
    await register_ai_duels_routes(ai_duel_scope, ai_duels_controller_instance, require_auth);
  }, { prefix: "/ai-duels" });

  await fastify.register(async (er_scope) => {
    await register_er_routes(er_scope, er_controller_instance);
  }, { prefix: "/er" });

  const bootstrap_state = {
    in_progress: false,
    complete: false
  };

  const run_background_bootstrap = async () => {
    if (bootstrap_state.in_progress || bootstrap_state.complete) {
      return;
    }

    bootstrap_state.in_progress = true;
    try {
      await markets_service_instance.seed_markets();
      await markets_service_instance.sync_chain_markets();
      await rounds_service_instance.bootstrap();
      bootstrap_state.complete = true;
      fastify.log.info("background bootstrap complete");
    } catch (error) {
      fastify.log.error({ err: error }, "background bootstrap failed");
    } finally {
      bootstrap_state.in_progress = false;
    }
  };

  void run_background_bootstrap();

  const retry_timer = setInterval(() => {
    if (bootstrap_state.complete) {
      clearInterval(retry_timer);
      return;
    }
    void run_background_bootstrap();
  }, 15_000);
  retry_timer.unref();
};
