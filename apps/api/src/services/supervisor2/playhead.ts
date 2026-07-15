// Decision 83 — the unified playhead resolver.
//
// Today "where are we" has no single answer: the Supervisor's plan-playhead
// (computePlanPlayhead, plan-item accounting), the wall-clock resolver
// (resolveCurrentSegment, used only at cold-start/reconcile), the
// per-activation drift snapshot, and the hard-segment lookahead's own
// starting point are four separately-computed beliefs about position, each
// capable of disagreeing with the others under drift.
//
// resolvePlayhead() answers one question — given "now," which calendar/
// template/default-clock segment are we in, and how far into it — derived
// from real ground truth (the active plan's own segment identity, Decision
// 61's "trust the plan, don't re-resolve wall clock" pattern, plus elapsed
// time since the last confirmed on-air event) whenever an active plan
// exists. It falls back to an independent wall-clock resolve only when
// there's genuinely no ground truth to anchor to (no active plan) — the
// same "cold start / orphan / restart-ambiguous" territory Decision 84's
// `Invalid` state covers.
//
// Status: Phase 2 shadow mode — computed and logged for comparison
// alongside the existing computePlanPlayhead; not yet the source of truth
// for any decision. Phase 6 cuts the tick loop over to depend on this.

import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../../db/index.js';
import {
  planItems as planItemsTable,
  playHistory as playHistoryTable,
  supervisorState as supervisorStateTable,
} from '../../db/schema.js';
import { resolveActivePlanSegment, resolveCurrentSegment, type ResolvedSegment } from './clockResolver.js';

const TERMINAL_STATUSES = new Set(['played', 'supervisor_skipped', 'operator_skipped']);

export interface PlayheadResolution {
  // Null only when there's no active plan AND no wall-clock schedule
  // coverage at all (unconfigured default clock — a startup misconfiguration,
  // not something this function papers over).
  resolved: ResolvedSegment | null;
  // How far into `resolved`'s segment the playhead sits, in seconds —
  // ground truth (consumed plan-item time + elapsed in what's playing) when
  // an active plan resolved; wall-clock offset into the segment otherwise.
  offsetIntoSegmentSeconds: number;
  // Unix ms this segment is expected to end, if knowable (mirrors
  // computePlanPlayhead's expectedEndMs when ground truth is available).
  expectedSegmentEndMs: number | null;
  // 'ground_truth' — anchored to a real confirmed on-air event via the active
  // plan. 'wall_clock_only' — no active plan to anchor to; this is the
  // low-confidence case that should read as `restart_ambiguous`/orphan
  // territory to any caller deciding whether to trust the result outright.
  confidence: 'ground_truth' | 'wall_clock_only';
}

export async function resolvePlayhead(
  nowMs: number,
  db: typeof defaultDb = defaultDb,
): Promise<PlayheadResolution> {
  const [state] = await db
    .select({ active_plan_id: supervisorStateTable.active_plan_id })
    .from(supervisorStateTable)
    .where(eq(supervisorStateTable.id, 1));

  if (state?.active_plan_id != null) {
    const resolved = await resolveActivePlanSegment(db, state.active_plan_id);
    if (resolved) {
      const { consumedSeconds, expectedEndMs } = await consumedSecondsForPlan(db, state.active_plan_id, nowMs);
      return {
        resolved,
        offsetIntoSegmentSeconds: consumedSeconds,
        expectedSegmentEndMs: expectedEndMs,
        confidence: 'ground_truth',
      };
    }
    // Active plan id set but its segment/clock instance no longer resolves
    // (deleted segment, corrupt row) — fall through to wall-clock, same as
    // genuinely having no active plan. No logger here by design (this
    // function is a pure resolver); the caller (realityCheckAndDispatch)
    // logs PLAYHEAD_ACTIVE_PLAN_UNRESOLVED when it sees activePlanId set
    // alongside a 'wall_clock_only' result, since only it knows activePlanId
    // was actually set going in.
  }

  const wallClock = await resolveCurrentSegment(nowMs, db);
  if (!wallClock) {
    return { resolved: null, offsetIntoSegmentSeconds: 0, expectedSegmentEndMs: null, confidence: 'wall_clock_only' };
  }
  return {
    resolved: wallClock,
    offsetIntoSegmentSeconds: (nowMs - wallClock.segmentStartMs) / 1000,
    expectedSegmentEndMs: wallClock.segmentEndMs,
    confidence: 'wall_clock_only',
  };
}

// Sum the planned duration of every terminal-status item, then add elapsed
// time in whatever item is currently 'playing' — but only once its
// play_history row is confirmed. insertPushed writes started_at as a
// push-time placeholder (the column is NOT NULL, so it can't stay empty
// until confirmation); stampStarted overwrites it with the real on-air time
// and sets confirmed=true once LS_TRACK_STARTED lands. Until then, this
// item's real start is genuinely unknown — crediting elapsed time against
// the placeholder would count time that hasn't necessarily been consumed
// yet (queue-ahead pushes can sit unconfirmed for as long as whatever's
// still genuinely playing takes to finish). So the playhead holds at the
// last confirmed point instead of advancing on a guess; it jumps forward for
// real the moment confirmation lands. Found and fixed 2026-07-15 — this was
// the exact cause of the Supervisor UI's drift figure appearing to grow
// then snap to a stable value after a fresh plan activation.
async function consumedSecondsForPlan(
  db: typeof defaultDb,
  planId: number,
  nowMs: number,
): Promise<{ consumedSeconds: number; expectedEndMs: number | null }> {
  const items = await db
    .select()
    .from(planItemsTable)
    .where(eq(planItemsTable.plan_id, planId))
    .orderBy(asc(planItemsTable.position));

  let consumedSeconds = 0;
  let expectedEndMs: number | null = null;

  for (const item of items) {
    if (TERMINAL_STATUSES.has(item.status)) {
      consumedSeconds += item.planned_duration_seconds ?? 0;
    } else if (item.status === 'playing') {
      if (item.play_history_id != null) {
        const [ph] = await db
          .select({ started_at: playHistoryTable.started_at, confirmed: playHistoryTable.confirmed })
          .from(playHistoryTable)
          .where(eq(playHistoryTable.id, item.play_history_id));
        if (ph?.confirmed && ph.started_at) {
          const startedAtMs = new Date(ph.started_at).getTime();
          consumedSeconds += (nowMs - startedAtMs) / 1000;
          expectedEndMs = startedAtMs + (item.planned_duration_seconds ?? 0) * 1_000;
        }
      }
      break;
    } else {
      break;
    }
  }
  return { consumedSeconds, expectedEndMs };
}
