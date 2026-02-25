import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ok } from "@/shared/http-response";
import { app_error } from "@/shared/app-error";
import type { ai_duels_service } from "@/features/ai-duels/ai-duels.service";

const list_query_schema = z.object({
  status: z.enum(["prepared", "open", "revealed", "settled", "cancelled"]).optional(),
  marketSlug: z.string().optional(),
  wallet: z.string().optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const open_duel_schema = z.object({
  roundId: z.string().min(1),
  playerSide: z.enum(["yes", "no"]),
  amountLamports: z.coerce.number().int().positive()
});

const append_turn_schema = z.object({
  playerSide: z.enum(["yes", "no"]),
  amountLamports: z.coerce.number().int().positive()
});

const confirm_tx_schema = z.object({
  txSignature: z.string().min(20).max(128)
});

const lamports_amount_schema = z.object({
  amountLamports: z.coerce.number().int().positive()
});

const bankroll_active_schema = z.object({
  active: z.coerce.boolean()
});

export class ai_duels_controller {
  constructor(private readonly service: ai_duels_service) {}

  list = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = list_query_schema.parse(request.query ?? {});
      if (query.mine && !request.auth_wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }
      const wallet = query.mine ? request.auth_wallet : query.wallet;
      const rows = await this.service.list({
        wallet: wallet ?? undefined,
        status: query.status,
        market_slug: query.marketSlug,
        limit: query.limit
      });
      reply.send(ok(rows));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  get_by_id = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const duel_id = (request.params as any).duelId as string;
      reply.send(ok(await this.service.get_by_id(duel_id)));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  ensure_house_bankroll = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const data = await this.service.ensure_house_bankroll({
        admin_wallet: wallet
      });
      reply.send(ok({
        houseBankrollPda: data.house_bankroll_pda,
        initializeTxSignature: data.initialize_tx_signature
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  fund_house_bankroll = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const payload = lamports_amount_schema.parse(request.body ?? {});
      const result = await this.service.fund_house_bankroll({
        admin_wallet: wallet,
        amount_lamports: payload.amountLamports
      });

      reply.send(ok({
        txSignature: result.tx_signature,
        balanceLamports: result.balance_lamports
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  withdraw_house_bankroll = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const payload = lamports_amount_schema.parse(request.body ?? {});
      const result = await this.service.withdraw_house_bankroll({
        admin_wallet: wallet,
        amount_lamports: payload.amountLamports
      });

      reply.send(ok({
        txSignature: result.tx_signature,
        balanceLamports: result.balance_lamports
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  set_house_bankroll_active = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const payload = bankroll_active_schema.parse(request.body ?? {});
      const result = await this.service.set_house_bankroll_active({
        admin_wallet: wallet,
        active: payload.active
      });

      reply.send(ok({
        txSignature: result.tx_signature
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_open_relay = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const payload = open_duel_schema.parse(request.body ?? {});
      const prepared = await this.service.prepare_open_relay({
        wallet,
        round_id: payload.roundId,
        player_side: payload.playerSide,
        amount_lamports: payload.amountLamports
      });

      reply.send(ok({
        duelRecordId: prepared.duel_record_id,
        transactionBase64: prepared.transaction_base64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
        feePayer: prepared.fee_payer,
        marketPda: prepared.market_pda,
        roundPda: prepared.round_pda,
        houseBankrollPda: prepared.house_bankroll_pda,
        aiDuelPda: prepared.ai_duel_pda
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  confirm_open = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const payload = confirm_tx_schema.parse(request.body ?? {});
      const updated = await this.service.confirm_open({
        duel_record_id: duel_id,
        wallet,
        tx_signature: payload.txSignature
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_append_turn_relay = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const payload = append_turn_schema.parse(request.body ?? {});
      const prepared = await this.service.prepare_append_turn_relay({
        duel_record_id: duel_id,
        wallet,
        player_side: payload.playerSide,
        amount_lamports: payload.amountLamports
      });

      reply.send(ok({
        turnIndex: prepared.turn_index,
        transactionBase64: prepared.transaction_base64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
        feePayer: prepared.fee_payer,
        marketPda: prepared.market_pda,
        roundPda: prepared.round_pda,
        houseBankrollPda: prepared.house_bankroll_pda,
        aiDuelPda: prepared.ai_duel_pda
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  confirm_append_turn = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const payload = confirm_tx_schema.parse(request.body ?? {});
      const updated = await this.service.confirm_append_turn({
        duel_record_id: duel_id,
        wallet,
        tx_signature: payload.txSignature
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  reveal_and_settle = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const updated = await this.service.reveal_and_settle({
        duel_record_id: duel_id,
        wallet
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  prepare_claim_relay = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const prepared = await this.service.prepare_claim_relay({
        duel_record_id: duel_id,
        wallet
      });

      reply.send(ok({
        transactionBase64: prepared.transaction_base64,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.last_valid_block_height,
        feePayer: prepared.fee_payer,
        aiDuelPda: prepared.ai_duel_pda
      }));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  confirm_claim = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallet = request.auth_wallet;
      if (!wallet) {
        reply.code(401).send({ success: false, message: "unauthorized" });
        return;
      }

      const duel_id = (request.params as any).duelId as string;
      const payload = confirm_tx_schema.parse(request.body ?? {});
      const updated = await this.service.confirm_claim({
        duel_record_id: duel_id,
        wallet,
        tx_signature: payload.txSignature
      });

      reply.send(ok(updated));
    } catch (error: unknown) {
      this.handle_error(error, reply);
    }
  };

  private handle_error(error: unknown, reply: FastifyReply): void {
    if (error instanceof app_error) {
      reply.code(error.status_code).send({ success: false, message: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.code(400).send({ success: false, message: error.issues[0]?.message ?? "invalid payload" });
      return;
    }
    reply.code(500).send({ success: false, message: "internal server error" });
  }
}
