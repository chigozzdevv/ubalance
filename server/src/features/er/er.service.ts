import { env } from "@/config/env";
import { er_validators } from "@/config/validators";
import type { er_connection_config } from "@/features/er/er.model";

const normalize_er_url = (value: string): string => value.trim().replace(/\/+$/, "");

export class er_service {
  list_validators() {
    return er_validators;
  }

  get_connection_config(): er_connection_config {
    const erRpcUrl = normalize_er_url(env.ER_RPC_URL);
    return {
      erRpcUrl,
      erWsUrl: env.ER_WS_URL
    };
  }
}
