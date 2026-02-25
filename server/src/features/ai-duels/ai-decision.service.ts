import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/config/env";
import { app_error } from "@/shared/app-error";
import type { market } from "@/features/markets/markets.model";
import type { decision_side } from "@/features/rounds/rounds.model";
import type { round_document } from "@/shared/mongo";
import type { oracle_service } from "@/features/oracle/oracle.service";

const openai_response_schema = z.object({
  side: z.enum(["yes", "no"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(8).max(300),
  horizon: z.string().min(2).max(80)
});

type ai_decision_output = z.infer<typeof openai_response_schema>;

type ai_price_point = {
  label: string;
  timestamp_ms: number;
  price: number | null;
};

type ai_decision_request = {
  wallet: string;
  market: market;
  round: round_document;
  player_side: decision_side;
  amount_lamports: number;
  recent_user_performance: {
    overall: ai_user_performance_summary;
    market: ai_user_performance_summary;
  };
  recent_resolved_rounds: round_document[];
};

export type ai_user_performance_summary = {
  sample_size: number;
  player_wins: number;
  house_wins: number;
  pushes: number;
  player_win_rate_ex_push: number | null;
  avg_stake_lamports: number | null;
  avg_player_roi_pct: number | null;
  recent_outcomes: Array<"player_win" | "house_win" | "push">;
};

export type ai_decision_result = {
  side: decision_side;
  confidence: number;
  rationale: string;
  model: string;
};

export class ai_decision_service {
  constructor(private readonly oracle: oracle_service) {}

  async decide_side(input: ai_decision_request): Promise<ai_decision_result> {
    if (!env.OPENAI_API_KEY) {
      throw new app_error("OPENAI_API_KEY is not configured", 500);
    }

    const now = Date.now();
    const latest_price = await this.oracle.get_latest_price(input.market.oracle_symbol);
    const price_points = await this.collect_price_points(input.market.oracle_symbol, input.round, now);

    const context = this.build_context(input, latest_price, price_points, now);
    const model_output = await this.request_openai_decision(context, input.wallet);

    if (model_output.confidence < env.AI_MODEL_MIN_CONFIDENCE) {
      throw new app_error(
        `AI confidence too low (${model_output.confidence.toFixed(2)} < ${env.AI_MODEL_MIN_CONFIDENCE.toFixed(2)})`,
        409
      );
    }

    return {
      side: model_output.side,
      confidence: model_output.confidence,
      rationale: model_output.rationale,
      model: env.OPENAI_MODEL
    };
  }

  private async collect_price_points(
    oracle_symbol: string,
    round: round_document,
    now_ms: number
  ): Promise<ai_price_point[]> {
    const open_at_ms = Number(round.open_at_ms);
    const close_at_ms = Number(round.close_at_ms);
    const round_mid_ms = Math.floor((open_at_ms + close_at_ms) / 2);
    const lookback_1m = now_ms - 60_000;
    const lookback_3m = now_ms - 180_000;

    const points: Array<Omit<ai_price_point, "price"> & { query_ms: number }> = [
      { label: "open", timestamp_ms: open_at_ms, query_ms: open_at_ms },
      { label: "mid", timestamp_ms: round_mid_ms, query_ms: round_mid_ms },
      { label: "now-3m", timestamp_ms: lookback_3m, query_ms: lookback_3m },
      { label: "now-1m", timestamp_ms: lookback_1m, query_ms: lookback_1m },
      { label: "now", timestamp_ms: now_ms, query_ms: now_ms }
    ];

    return Promise.all(
      points.map(async (point): Promise<ai_price_point> => {
        try {
          const price = await this.oracle.get_price_near_timestamp(oracle_symbol, point.query_ms);
          return {
            label: point.label,
            timestamp_ms: point.timestamp_ms,
            price
          };
        } catch {
          return {
            label: point.label,
            timestamp_ms: point.timestamp_ms,
            price: null
          };
        }
      })
    );
  }

  private build_context(
    input: ai_decision_request,
    latest_price: number,
    price_points: ai_price_point[],
    now_ms: number
  ): Record<string, unknown> {
    const reference_price = Number(input.round.reference_price);
    const remaining_ms = Math.max(0, Number(input.round.close_at_ms) - now_ms);
    const elapsed_ms = Math.max(0, now_ms - Number(input.round.open_at_ms));

    const point_by_label = new Map(price_points.map((point) => [point.label, point]));
    const price_open = point_by_label.get("open")?.price ?? null;
    const price_now_1m = point_by_label.get("now-1m")?.price ?? null;
    const price_now_3m = point_by_label.get("now-3m")?.price ?? null;

    const pct = (current: number | null, base: number | null): number | null => {
      if (current === null || base === null || base === 0) {
        return null;
      }
      return ((current - base) / base) * 100;
    };

    const values = price_points
      .map((point) => point.price)
      .filter((value): value is number => typeof value === "number");
    const price_min = values.length > 0 ? Math.min(...values) : null;
    const price_max = values.length > 0 ? Math.max(...values) : null;

    const recent_summary = this.summarize_recent_rounds(input.recent_resolved_rounds);

    return {
      generated_at_ms: now_ms,
      market: {
        slug: input.market.slug,
        display_name: input.market.display_name,
        base_symbol: input.market.base_symbol,
        quote_symbol: input.market.quote_symbol,
        oracle_symbol: input.market.oracle_symbol,
        timeframe_minutes: input.market.timeframe_minutes
      },
      round: {
        id: input.round.id,
        round_number: Number(input.round.round_number),
        reference_price: reference_price,
        open_at_ms: Number(input.round.open_at_ms),
        close_at_ms: Number(input.round.close_at_ms),
        elapsed_ms,
        remaining_ms,
        totals: {
          yes_lamports: Number(input.round.totals.yes_lamports),
          no_lamports: Number(input.round.totals.no_lamports),
          action_count: Number(input.round.totals.action_count)
        }
      },
      player: {
        side: input.player_side,
        amount_lamports: input.amount_lamports,
        recent_performance: input.recent_user_performance
      },
      prices: {
        latest_price,
        price_points,
        delta_vs_reference_pct: pct(latest_price, reference_price),
        delta_now_vs_open_pct: pct(latest_price, price_open),
        delta_now_vs_1m_pct: pct(latest_price, price_now_1m),
        delta_now_vs_3m_pct: pct(latest_price, price_now_3m),
        sampled_range_pct: pct(price_max, price_min)
      },
      market_recent: recent_summary,
      rules: {
        choose_yes_if_expected_settlement_above_reference: true,
        choose_no_if_expected_settlement_below_reference: true,
        consider_player_side_and_stake: true,
        consider_recent_player_performance: true,
        must_choose_one_of: ["yes", "no"]
      }
    };
  }

  private summarize_recent_rounds(rows: round_document[]): {
    resolved_count: number;
    yes_wins: number;
    no_wins: number;
    skip_wins: number;
    avg_move_pct: number | null;
  } {
    if (rows.length === 0) {
      return {
        resolved_count: 0,
        yes_wins: 0,
        no_wins: 0,
        skip_wins: 0,
        avg_move_pct: null
      };
    }

    let yes_wins = 0;
    let no_wins = 0;
    let skip_wins = 0;
    const moves: number[] = [];

    for (const row of rows) {
      if (row.winning_side === "yes") {
        yes_wins += 1;
      } else if (row.winning_side === "no") {
        no_wins += 1;
      } else if (row.winning_side === "skip") {
        skip_wins += 1;
      }

      if (row.settlement_price !== null && row.reference_price > 0) {
        const move_pct = ((row.settlement_price - row.reference_price) / row.reference_price) * 100;
        if (Number.isFinite(move_pct)) {
          moves.push(move_pct);
        }
      }
    }

    const avg_move_pct = moves.length > 0
      ? moves.reduce((sum, item) => sum + item, 0) / moves.length
      : null;

    return {
      resolved_count: rows.length,
      yes_wins,
      no_wins,
      skip_wins,
      avg_move_pct
    };
  }

  private async request_openai_decision(
    context: Record<string, unknown>,
    wallet: string
  ): Promise<ai_decision_output> {
    const endpoint = `${env.OPENAI_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
    const model_name = env.OPENAI_MODEL.trim();
    const is_gpt5_family = /^gpt-5/i.test(model_name);

    const wallet_hash = createHash("sha256").update(wallet).digest("hex").slice(0, 16);

    const payload: Record<string, unknown> = {
      model: model_name,
      max_completion_tokens: env.OPENAI_MAX_COMPLETION_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "pvai_decision",
          strict: true,
          schema: {
            type: "object",
            properties: {
              side: {
                type: "string",
                enum: ["yes", "no"]
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1
              },
              rationale: {
                type: "string",
                minLength: 8,
                maxLength: 300
              },
              horizon: {
                type: "string",
                minLength: 2,
                maxLength: 80
              }
            },
            required: ["side", "confidence", "rationale", "horizon"],
            additionalProperties: false
          }
        }
      },
      messages: [
        {
          role: "system",
          content:
            "You are a market decision engine for a short-horizon prediction game. Decide whether the round settlement price at close is ABOVE (yes) or BELOW (no) the reference price. Use only the provided context, including player side, stake size, and recent player performance. Return strict JSON matching schema."
        },
        {
          role: "user",
          content: JSON.stringify(context)
        }
      ],
      user: wallet_hash
    };
    if (is_gpt5_family) {
      payload.reasoning_effort = env.OPENAI_REASONING_EFFORT;
    } else {
      payload.temperature = env.OPENAI_TEMPERATURE;
    }

    let last_error: unknown = null;

    for (let attempt = 1; attempt <= env.AI_MODEL_DECISION_RETRIES; attempt += 1) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.OPENAI_API_KEY}`
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(env.OPENAI_TIMEOUT_MS)
        });

        const raw_body = await response.text();
        if (!response.ok) {
          throw new Error(`openai ${response.status}: ${raw_body.slice(0, 400)}`);
        }

        const parsed = JSON.parse(raw_body) as {
          choices?: Array<{
            message?: {
              content?: string | Array<{ type?: string; text?: string }>;
            };
          }>;
        };

        const content = this.extract_assistant_content(parsed);
        if (!content) {
          throw new Error("openai response missing assistant content");
        }

        return openai_response_schema.parse(JSON.parse(content));
      } catch (error) {
        last_error = error;
      }
    }

    throw new app_error(`openai decision request failed: ${this.format_error(last_error)}`, 502);
  }

  private extract_assistant_content(payload: {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  }): string {
    const message_content = payload.choices?.[0]?.message?.content;
    if (typeof message_content === "string") {
      return message_content;
    }

    if (Array.isArray(message_content)) {
      const text_chunk = message_content.find((item) => typeof item?.text === "string");
      if (text_chunk?.text) {
        return text_chunk.text;
      }
    }

    return "";
  }

  private format_error(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return "unknown error";
  }
}
