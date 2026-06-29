import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supervisorState, planItems } from '../db/schema.js';
import { HarborClient } from '../services/supervisor2/harborClient.js';
import { bus } from '../services/supervisor2/bus.js';
import { resolveCurrentSegment } from '../services/supervisor2/clockResolver.js';

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

  // Rebuild the remaining pending items in the active plan so they fill
  // exactly to the current segment's wall-clock boundary. Equivalent to
  // manually forcing a hard-start trim/fill for the current segment.
  fastify.post('/supervisor/v2/align-to-wall-clock', async (_request, reply) => {
    try {
      const nowMs = Date.now();

      const [stateRow] = await db.select().from(supervisorState).where(eq(supervisorState.id, 1));
      const activePlanId = stateRow?.active_plan_id ?? null;
      if (activePlanId == null) {
        return reply.status(400).send({ ok: false, error: 'No active plan' });
      }

      const resolved = await resolveCurrentSegment(nowMs, db);
      if (!resolved) {
        return reply.status(400).send({ ok: false, error: 'No current segment' });
      }

      const remainingSeconds = Math.max(0, (resolved.segmentEndMs - nowMs) / 1000);
      if (remainingSeconds < 10) {
        return reply.status(400).send({ ok: false, error: 'Too close to segment boundary' });
      }

      const [firstPending] = await db
        .select({ position: planItems.position })
        .from(planItems)
        .where(and(eq(planItems.plan_id, activePlanId), eq(planItems.status, 'pending')))
        .orderBy(asc(planItems.position))
        .limit(1);

      const fromPosition = firstPending?.position ?? 0;

      bus.emit({
        type: 'PLAN_REPLAN_REQUESTED',
        request_id: randomUUID(),
        plan_id: activePlanId,
        from_position: fromPosition,
        remaining_seconds: Math.floor(remainingSeconds),
        now_ms: nowMs,
      });

      return reply.send({ ok: true });
    } catch (err) {
      fastify.log.error(err, 'supervisor align-to-wall-clock failed');
      return reply.status(500).send({ ok: false, error: 'Align failed' });
    }
  });
}
