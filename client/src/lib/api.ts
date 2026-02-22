import { env } from "@/lib/env";

export const api = {
  async get<T>(path: string, token?: string): Promise<T> {
    const response = await fetch(`${env.apiUrl}${path}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      cache: "no-store"
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "request failed");
    }

    return response.json();
  },

  async post<T>(path: string, payload: unknown, token?: string): Promise<T> {
    const response = await fetch(`${env.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || "request failed");
    }

    return response.json();
  }
};
