import { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supervisorState, planItems } from '../db/schema.js';
import { HarborClient } from '../services/supervisor2/harborClient.js';
import { bus } from '../services/supervisor2/bus.js';

export async function supervisorControlRoutes(fastify: FastifyInstance) {
  fastify.post('/supervisor/v2/skip', async (_request, reply) => {
    try {
      await HarborClient.skip();
      // Mark the currently-playing item as operator_skipped so the plan
      // reflects what actually happened.
      await db.update(planItems)
        .set({ status: 'operator_skipped' })
        .where(eq(planItems.status, 'playing'));
      return reply.send({ ok: true });
    } catch (err) {
      fastify.log.error(err, 'supervisor skip failed');
      return reply.status(500).send({ ok: false, error: 'Skip failed' });
    }
  });

  fastify.post('/supervisor/v2/pause', async (_request, reply) => {
    await db.update(supervisorState)
      .set({ paused: true })
      .where(eq(supervisorState.id, 1));
    return reply.send({ ok: true });
  });

  fastify.post('/supervisor/v2/resume', async (_request, reply) => {
    await db.update(supervisorState)
      .set({ paused: false })
      .where(eq(supervisorState.id, 1));
    bus.emit({ type: 'PUSH_NEXT_REQUESTED', reason: 'resume' });
    return reply.send({ ok: true });
  });
}
