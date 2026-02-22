import { api } from "@/lib/api";
import type { market } from "@/types/market";

export const markets_api = {
  list() {
    return api.get<{ success: true; data: market[] }>("/markets");
  }
};
