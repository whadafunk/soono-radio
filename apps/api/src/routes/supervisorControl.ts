import { randomUUID } from 'crypto';
import { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supervisorState, planItems, plans, clockSegments } from '../db/schema.js';
import { HarborClient } from '../services/supervisor2/harborClient.js';
import { bus } from '../services/supervisor2/bus.js';
import { resolveCurrentSegment, segmentBoundsWithinClock } from '../services/supervisor2/clockResolver.js';
import { abortRow } from '../services/supervisor2/playHistoryService.js';

export async function supervisorControlRoutes(fastify: FastifyInstance) {
  fastify.post('/supervisor/v2/skip', async (_request, reply) => {
    try {
      const nowMs = Date.now();
      // Capture play_history_id before flipping status — the item is being
      // cut mid-air, not skipped before it ever played, so its play_history
      // row needs marking aborted (Decision 63), not just its plan_items
      // status changed.
      const playingItems = await db
        .select({ id: planItems.id, play_history_id: planItems.play_history_id })
        .from(planItems)
        .where(eq(planItems.status, 'playing'));

      await HarborClient.skip();
      // Mark the currently-playing item as operator_skipped so the plan
      // reflects what actually happened.
      await db.update(planItems)
        .set({ status: 'operator_skipped' })
        .where(eq(planItems.status, 'playing'));

      for (const item of playingItems) {
        if (item.play_history_id != null) {
          await abortRow(db, item.play_history_id, nowMs);
        }
      }

      return reply.send({ ok: true });
    } catch (err) {
      fastify.log.error(err, 'supervisor skip failed');
      return reply.status(500).send({ ok: false, error: 'Skip failed' });
    }
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
      trigger: 'operator',
    });
    return reply.send({ ok: true });
  });

  // Forceful counterpart to align-to-wall-clock (Decision 56): explicitly
  // retires the active plan first, so the reconcile pass that follows is
  // guaranteed a full wall-clock rebuild instead of possibly trusting the
  // active plan as-is. Forward-only: if the active plan's segment already
  // starts at or after where a fresh wall-clock resolve says we should be,
  // this is a no-op — already-consumed content can't be un-consumed, and
  // reactivating an earlier segment's plan would just recreate a
  // behind-schedule condition, achieving nothing.
  fastify.post('/supervisor/v2/align-to-clock', async (_request, reply) => {
    const nowMs = Date.now();
    const [state] = await db.select({ active_plan_id: supervisorState.active_plan_id }).from(supervisorState).where(eq(supervisorState.id, 1));
    const activePlanId = state?.active_plan_id ?? null;

    let invalidated = false;
    if (activePlanId != null) {
      const [plan] = await db
        .select({
          status: plans.status,
          clock_instance_started_at: plans.clock_instance_started_at,
          segment_id: plans.segment_id,
          clock_id: clockSegments.clock_id,
        })
        .from(plans)
        .innerJoin(clockSegments, eq(clockSegments.id, plans.segment_id))
        .where(eq(plans.id, activePlanId));

      if (plan) {
        const resolved = await resolveCurrentSegment(nowMs, db);
        const activeBounds = await segmentBoundsWithinClock(db, plan.clock_id, plan.segment_id, plan.clock_instance_started_at);
        const isAheadOrCurrent = resolved != null && activeBounds != null && activeBounds.startMs >= resolved.segmentStartMs;

        if (!isAheadOrCurrent) {
          await db.update(plans)
            .set({ status: 'completed' })
            .where(and(eq(plans.id, activePlanId), eq(plans.status, 'active')));
          invalidated = true;
        }
      }
    }

    bus.emit({
      type: 'RECONCILE_REQUESTED',
      request_id: randomUUID(),
      now_ms: nowMs,
      trigger: 'align_to_clock',
    });
    return reply.send({ ok: true, invalidated });
  });
}
