// Decides what to do with the plan held in the supervisor's "next" slot at
// the moment a plan goes on air. Pure — no DB, no bus — so the decision table
// is unit-testable (see nextPlanSlot.test.ts).
//
// The slot is protected elsewhere from being replaced while its plan still
// has unplayed content (handlePlanDraftReady), but nothing used to check that
// the held plan still FOLLOWS whatever just activated. After a reconcile /
// Align to Clock / restart re-anchors the active plan, a plan drafted for a
// different occurrence stays in the slot and airs out of order. Confirmed
// live 2026-11-10: last night's leftover plan activated 11h late, and after
// an Align the 07:45 stop-set aired straight after the 07:30 one, skipping
// the music segment between them.

export interface HeldNextPlan {
  segment_id: number;
  clock_instance_started_at: number | null;
  status: string;
  // At least one of its items has been pushed to LiquidSoap and not finished
  // (plan_items.status = 'playing').
  hasPushedItem: boolean;
}

export interface ExpectedNextOccurrence {
  segmentId: number;
  clockInstanceStartedAt: number;
}

// 'keep'       — it is the right plan, or its content is (or may be) sitting
//                in LiquidSoap's queue and will air regardless of DB state.
// 'release'    — clear the slot; the plan row is left as-is so it can still
//                be adopted later if its own occurrence comes up.
// 'invalidate' — clear the slot AND mark the plan Invalid: it was promoted to
//                'Transitioning' for a push that LiquidSoap no longer holds,
//                so it can neither confirm on air nor be adopted.
export type NextSlotVerdict = 'keep' | 'release' | 'invalidate';

export function judgeHeldNextPlan(
  held: HeldNextPlan | null,
  expected: ExpectedNextOccurrence,
  // LiquidSoap's queue depth right now; null = unknown (not asked, or
  // LiquidSoap unreachable).
  lsQueueDepth: number | null,
): NextSlotVerdict {
  if (held == null) return 'release'; // pointer to a row that no longer exists

  const followsActivePlan =
    held.segment_id === expected.segmentId &&
    held.clock_instance_started_at === expected.clockInstanceStartedAt;
  if (followsActivePlan) return 'keep';

  // Mid-activation by another path — not ours to touch.
  if (held.status === 'active') return 'keep';

  // Pushed content can't be recalled from LiquidSoap's queue. Only when
  // LiquidSoap positively reports an empty queue do we know the push is gone
  // (LiquidSoap restarted, or the item already played out); unknown or
  // non-empty means it may still air, so the plan must stay tracked.
  if (held.hasPushedItem && lsQueueDepth !== 0) return 'keep';

  return held.status === 'Transitioning' ? 'invalidate' : 'release';
}
