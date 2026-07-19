/**
 * Spot budget API routes.
 *
 * GET /api/spot-budget              → overview (inventory + demand + available)
 * GET /api/spot-budget/details      → per-day inventory breakdown + coverage source
 * GET /api/spot-budget/campaign/:id → campaign-specific available + pacing
 * GET /api/spot-budget/campaign/:id/pacing → pacing only
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BudgetModeSchema } from '@soono/shared';
import {
  getOverview,
  getBudgetDayDetails,
  getCampaignAvailable,
  getPacing,
} from '../services/spotBudget.js';

const QuerySchema = z.object({
  mode: BudgetModeSchema.default('estimated'),
  start: z.string().min(1),
  end: z.string().min(1),
});

export async function spotBudgetRoutes(fastify: FastifyInstance) {
  // ── GET /api/spot-budget ─────────────────────────────────────────────────
  fastify.get<{ Querystring: unknown }>('/spot-budget', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }
    const { mode, start, end } = parsed.data;
    const period = { start: new Date(start), end: new Date(end) };

    try {
      const overview = await getOverview(period, mode);
      return reply.send(overview);
    } catch (err) {
      fastify.log.error(err, 'spot-budget overview failed');
      return reply.status(500).send({ error: 'Failed to compute spot budget' });
    }
  });

  // ── GET /api/spot-budget/details ─────────────────────────────────────────
  fastify.get<{ Querystring: unknown }>('/spot-budget/details', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }
    const { mode, start, end } = parsed.data;
    const period = { start: new Date(start), end: new Date(end) };

    try {
      const days = await getBudgetDayDetails(period, mode);
      return reply.send({ days });
    } catch (err) {
      fastify.log.error(err, 'spot-budget details failed');
      return reply.status(500).send({ error: 'Failed to compute spot budget details' });
    }
  });

  // ── GET /api/spot-budget/campaign/:id ────────────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: unknown }>(
    '/spot-budget/campaign/:id',
    async (request, reply) => {
      const campaignId = Number(request.params.id);
      if (!Number.isFinite(campaignId)) {
        return reply.status(400).send({ error: 'Invalid campaign id' });
      }

      const parsed = QuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ errors: parsed.error.errors });
      }
      const { mode, start, end } = parsed.data;
      const period = { start: new Date(start), end: new Date(end) };

      try {
        const [available, pacing] = await Promise.all([
          getCampaignAvailable(campaignId, period, mode),
          getPacing(campaignId),
        ]);
        return reply.send({ ...available, pacing });
      } catch (err) {
        fastify.log.error(err, 'spot-budget campaign available failed');
        return reply.status(500).send({ error: 'Failed to compute campaign availability' });
      }
    },
  );

  // ── GET /api/spot-budget/campaign/:id/pacing ─────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/spot-budget/campaign/:id/pacing',
    async (request, reply) => {
      const campaignId = Number(request.params.id);
      if (!Number.isFinite(campaignId)) {
        return reply.status(400).send({ error: 'Invalid campaign id' });
      }

      try {
        const pacing = await getPacing(campaignId);
        return reply.send(pacing);
      } catch (err) {
        fastify.log.error(err, 'spot-budget pacing failed');
        return reply.status(500).send({ error: 'Failed to compute pacing' });
      }
    },
  );
}
