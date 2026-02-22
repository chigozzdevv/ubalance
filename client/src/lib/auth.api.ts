import { api } from "@/lib/api";
import type { challenge_response, verify_response } from "@/types/auth";

export const auth_api = {
  request_challenge(wallet: string) {
    return api.post<{ success: true; data: challenge_response }>("/auth/challenge", { wallet });
  },

  verify_challenge(wallet: string, signature: string) {
    return api.post<{ success: true; data: verify_response }>("/auth/verify", { wallet, signature });
  }
};
