import { FastifyInstance } from 'fastify';
import { getStatus } from '../services/supervisor/index.js';
import {
  getPlayById,
  getRecentPlays,
} from '../services/supervisor/playHistory.js';

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
}

function clampLimit(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(200, Math.max(1, n));
}
