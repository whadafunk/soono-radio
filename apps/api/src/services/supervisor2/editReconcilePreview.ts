// D108 — route-side preview of the edit-reconcile gate.
//
// Schedule-editing routes fire a reconcile on save; the supervisor's gate
// (reconcile() in processes/supervisor.ts) defers that reconcile when a plan
// is actively airing and the wall-clock state is ambiguous. The routes want
// to tell the operator which of the two happened, but the bus is
// fire-and-forget — so they call this preview, which mirrors the gate's
// decision from persisted state.
//
// Approximation, not oracle: the gate's trusted-plan check additionally
// consults pending items and the runway threshold (in-process playhead
// state this preview can't see). In the edge where those alone flip the
// decision, the airing plan is within seconds of its boundary anyway — the
// next draft re-resolves the schedule fresh, so answering 'immediate' there
// is honest in effect if not in mechanism.

import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import { plans, supervisorState } from '../../db/schema.js';
import { resolveCurrentSegment, computeResolutionIdentity } from './clockResolver.js';

export type EditReconcileOutcome = 'immediate' | 'deferred' | 'idle';

export async function previewEditReconcile(
  nowMs: number = Date.now(),
  db: typeof defaultDb = defaultDb,
): Promise<EditReconcileOutcome> {
  const [state] = await db
    .select({ active_plan_id: supervisorState.active_plan_id })
    .from(supervisorState)
    .where(eq(supervisorState.id, 1));
  if (state?.active_plan_id == null) return 'idle';

  const [plan] = await db
    .select({
      status: plans.status,
      segment_id: plans.segment_id,
      clock_instance_started_at: plans.clock_instance_started_at,
      resolution_identity: plans.resolution_identity,
    })
    .from(plans)
    .where(and(eq(plans.id, state.active_plan_id), inArray(plans.status, ['active'])));
  if (!plan) return 'idle';

  const resolved = await resolveCurrentSegment(nowMs, db);
  if (!resolved) return 'deferred';

  const matchesWallClock =
    plan.segment_id === resolved.segment.id &&
    plan.clock_instance_started_at === resolved.clockInstanceStartedAt &&
    plan.resolution_identity === computeResolutionIdentity(resolved);
  return matchesWallClock ? 'immediate' : 'deferred';
}
