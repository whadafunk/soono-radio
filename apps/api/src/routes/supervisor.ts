import { FastifyInstance } from 'fastify';
import { SupervisorConfigSchema } from '@radio/shared';
import {
  getStatus,
  start as supervisorStart,
  stop as supervisorStop,
  pauseSupervisor,
  resumeSupervisor,
  resyncNow,
  holdCurrentSegment,
  releaseHold,
} from '../services/supervisor/index.js';
import {
  getPlayById,
  getRecentPlays,
} from '../services/supervisor/playHistory.js';
import {
  getSupervisorConfig,
  writeSupervisorConfig,
} from '../services/supervisor/config.js';
import { computeWeeklyCapacity } from '../services/supervisor/capacity.js';
import { simulate } from '../services/supervisor/simulator.js';

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

  // Schedule preview / dry-run. Walks the predictor forward from `from` to `to`
  // and returns the would-be picks. No side effects — see simulator.ts.
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/supervisor/simulate',
    async (request, reply) => {
      const from = parseDate(request.query.from);
      const to = parseDate(request.query.to);
      if (!from || !to) {
        return reply
          .status(400)
          .send({ error: 'from and to are required ISO timestamps' });
      }
      if (to.getTime() <= from.getTime()) {
        return reply.status(400).send({ error: 'to must be after from' });
      }
      const plays = await simulate(from, to);
      return reply.send({ plays });
    },
  );

  fastify.post('/supervisor/restart', async (_request, reply) => {
    // In-process restart — stops the supervisor module and starts it
    // again, picking up any config changes. Doesn't touch the API
    // server itself or any other routes.
    await supervisorStop();
    await supervisorStart();
    return reply.send({ success: true });
  });

  // ─── Controls ──────────────────────────────────────────────────────────────

  fastify.post('/supervisor/pause', async (_request, reply) => {
    try {
      pauseSupervisor();
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  fastify.post('/supervisor/resume', async (_request, reply) => {
    try {
      resumeSupervisor();
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  // Resync triggers an immediate scheduler tick. Phase F v1 limitation: does
  // not flush LS's existing queue — newly-pushed picks land behind whatever
  // is already queued. Aggressive flush requires Pause → drain → Resume.
  fastify.post('/supervisor/resync', async (_request, reply) => {
    try {
      await resyncNow();
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  fastify.post('/supervisor/hold', async (_request, reply) => {
    try {
      const hold = holdCurrentSegment();
      return reply.send({ success: true, ...hold });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });

  fastify.post('/supervisor/release-hold', async (_request, reply) => {
    try {
      releaseHold();
      return reply.send({ success: true });
    } catch (err) {
      return reply.status(409).send({ error: (err as Error).message });
    }
  });
}

function clampLimit(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(200, Math.max(1, n));
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
