import { randomUUID } from 'crypto';
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

  // Runs the supervisor's full reconcile() pass immediately instead of
  // waiting for the next start/restart. Handles cases the old standalone
  // trim-only logic couldn't: no active plan at all, calendar-segment
  // identity mismatches, and next-segment runway — see
  // supervisor-reconciler-redesign design notes. The route can't call the
  // supervisor process directly (it's registered before that process
  // exists), so this just nudges it via the bus, same pattern as resume().
  fastify.post('/supervisor/v2/align-to-wall-clock', async (_request, reply) => {
    bus.emit({
      type: 'RECONCILE_REQUESTED',
      request_id: randomUUID(),
      now_ms: Date.now(),
    });
    return reply.send({ ok: true });
  });
}
