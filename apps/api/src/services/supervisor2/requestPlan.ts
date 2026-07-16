// Decision 85/86 — the universal Request Plan target formula.
// Decision 91/92 (2026-07-16) — prediction-based rewrite.
//
// History: the original formula sized targets from two snapshots taken at
// activation (boundaryDrift + plannedOvershoot) and needed a hand-maintained
// credit for every event that happened after the snapshot (skipped empty
// segments, replans, top-ups, stalls). The abandoned-plan credit shipped
// 2026-07-15 had an inverted sign — skipping a segment makes the station
// arrive EARLY at what follows, but the credit shrank the next plan as if it
// were arriving late. Decision 91 removes the ledger entirely: the caller
// derives predicted lateness fresh from ground truth at call time
// (now + estimated remaining content vs the target segment's own scheduled
// start) and passes it in. There is nothing left to credit and no snapshot
// to go stale.
//
// Decision 92 — two authority regimes, one formula:
//   correction = clamp(predicted, ±cap)                    (D71/78, unchanged)
//   |correction| ≤ fullAuthorityThreshold:
//       target = clamp(nominal − correction, [0.6, 1.4]×nominal)
//       (the comfort band; at the default 100s threshold it rarely binds)
//   |correction| > threshold:
//       target = max(30, nominal − correction)
//       (full authority — at that magnitude landing the boundary matters
//        more than one segment's fullness; growth is naturally bounded by
//        nominal + cap via the correction clamp)
//
// Stop-sets bypass everything (Decision 73): target = nominal, correction 0 —
// their content is governed by campaign pacing on its own timescale.
//
// appliedCorrectionSeconds is nominal − target AFTER all clamps — the honest
// value for the drift ledger (Decision 93). The old implementation recorded
// the pre-clamp capped value, overstating what was actually applied whenever
// the proportional band bit.

// Full-authority floor: the smallest plan worth assembling at all. Below
// this the planner would place at most one short branding item anyway.
const MIN_PLAN_TARGET_S = 30;

export interface DriftAdjustedTarget {
  targetSeconds: number;
  // nominal − target after all clamps. Persisted to the plans row
  // (Decision 93) and carried into intentional_offset_seconds at activation.
  appliedCorrectionSeconds: number;
}

export function computeDriftAdjustedTarget(
  segment: { type: string; duration_seconds: number },
  inputs: {
    // Decision 91: predicted lateness (seconds) at the target segment's
    // boundary, derived fresh by the caller. Positive = will arrive late.
    predictedDriftSeconds: number;
    capSeconds: number;
    fullAuthorityThresholdSeconds: number;
  },
): DriftAdjustedTarget {
  const nominal = segment.duration_seconds;

  if (segment.type === 'stop_set') {
    // D73: stop-sets never participate in wall-clock drift correction.
    // D75's campaign-driven recovery multiplier is applied downstream inside
    // assembleStopSetPlan, not here.
    return { targetSeconds: nominal, appliedCorrectionSeconds: 0 };
  }

  // D71: cap the correction itself — a very large drift shouldn't get
  // crammed into one plan. No recovery ledger needed: predicted drift is
  // re-derived from real facts at every evaluation, so whatever the cap
  // leaves uncorrected simply reappears next time.
  const correction = Math.max(
    -inputs.capSeconds,
    Math.min(inputs.capSeconds, inputs.predictedDriftSeconds),
  );

  let targetSeconds: number;
  if (Math.abs(correction) <= inputs.fullAuthorityThresholdSeconds) {
    // Comfort band — proportional clamp so a segment's ordinary correction
    // scales with its own length.
    targetSeconds = Math.max(nominal * 0.6, Math.min(nominal * 1.4, nominal - correction));
  } else {
    // Full authority (D92): the operator requirement is that any drift past
    // the threshold is gone by the next boundary. The plan may shrink far
    // below the comfort floor or grow up to nominal + cap.
    targetSeconds = Math.max(MIN_PLAN_TARGET_S, nominal - correction);
  }

  return { targetSeconds, appliedCorrectionSeconds: nominal - targetSeconds };
}
