import { FastifyInstance } from 'fastify';
import { SupervisorConfigSchema } from '@radio/shared';
import { getStatus, start as supervisorStart, stop as supervisorStop } from '../services/supervisor/index.js';
import {
  getPlayById,
  getRecentPlays,
} from '../services/supervisor/playHistory.js';
import {
  getSupervisorConfig,
  writeSupervisorConfig,
} from '../services/supervisor/config.js';
import { computeWeeklyCapacity } from '../services/supervisor/capacity.js';

export async function supervisorRoutes(fastify: FastifyInstance) {
  fastify.get('/supervisor/status', async (_request, reply) => {
    return reply.send(getStatus());
  });

  fastify.get('/supervisor/now-playing', async (_request, reply) => {
    // Source of truth: the supervisor's current_play_id, set by the
    // metadata watcher from LS's request.on_air poll. Falls back to
    // null when the watcher hasn't ticked yet or LS isn't reachable.
    const status = getStatus();
    if (status.current_play_id === null) {
      return reply.send(null);
    }
    const row = await getPlayById(status.current_play_id);
    return reply.send(row);
  });

  fastify.get<{ Querystring: { limit?: string } }>(
    '/supervisor/recent-plays',
    async (request, reply) => {
      const limit = clampLimit(parseInt(request.query.limit ?? '20', 10), 20);
      const rows = await getRecentPlays(limit);
      return reply.send({ plays: rows });
    },
  );

  fastify.post('/supervisor/skip', async (_request, reply) => {
    return reply.status(501).send({
      error: 'skip arrives with a later supervisor phase (Live Assist)',
    });
  });

  fastify.get('/supervisor/config', async (_request, reply) => {
    return reply.send(getSupervisorConfig());
  });

  fastify.post<{ Body: unknown }>('/supervisor/config', async (request, reply) => {
    const parsed = SupervisorConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }
    await writeSupervisorConfig(parsed.data);
    return reply.send({ success: true });
  });

  fastify.get('/supervisor/capacity', async (_request, reply) => {
    const capacity = await computeWeeklyCapacity();
    return reply.send(capacity);
  });

  fastify.post('/supervisor/restart', async (_request, reply) => {
    // In-process restart — stops the supervisor module and starts it
    // again, picking up any config changes. Doesn't touch the API
    // server itself or any other routes.
    await supervisorStop();
    await supervisorStart();
    return reply.send({ success: true });
  });
}

function clampLimit(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(200, Math.max(1, n));
}
