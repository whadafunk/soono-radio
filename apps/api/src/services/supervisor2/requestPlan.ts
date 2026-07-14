// Decision 85/86 — the universal Request Plan target formula.
//
// Before this module existed, `computeFirstPassTarget` (draft time) and
// `maybeRequestFinalization` (T-30s finalize) each computed "what should
// this segment's target duration be" via two separately hand-written
// formulas that had drifted apart:
//   - first pass:  correction = clamp(boundaryDrift + plannedOvershoot, ±cap)
//                  target = clamp(nominal - correction, [30, nominal*1.5])
//   - second pass: target = clamp(nominal - boundaryDrift, [0.6, 1.4] * nominal)
//                  (no plannedOvershoot term, no cap applied at all)
// Since boundaryDriftSeconds/plannedOvershootSeconds are stable for the
// entire lifetime of the currently active segment (both only change at the
// next activation), these two formulas should produce the same answer in
// the ordinary case — and didn't, which is exactly the "target jumps even
// though nothing about drift moved" bug class Decision 67/86 describe.
//
// Fix: one formula, called at both passes (and by any future mid-flight
// replan that needs an ordinary drift-corrected target). Stop-sets bypass
// it entirely (Decision 73) — this function returns nominal unmodified for
// them, same as before, just as a single shared guard instead of two.

export interface DriftAdjustedTarget {
  targetSeconds: number;
  // The correction actually applied (capped) — callers persist this as
  // intentional_offset_seconds once the plan it backs actually activates
  // (Decision 45/78). 0 for stop-sets (Decision 73 — no drift correction).
  appliedCorrectionSeconds: number;
}

export function computeDriftAdjustedTarget(
  segment: { type: string; duration_seconds: number },
  inputs: { boundaryDriftSeconds: number; plannedOvershootSeconds: number; capSeconds: number },
): DriftAdjustedTarget {
  const nominal = segment.duration_seconds;

  if (segment.type === 'stop_set') {
    // D73: stop-sets never participate in wall-clock drift correction —
    // their content is governed by campaign/promo pacing on its own
    // (daily/monthly) timescale. D75's campaign-driven recovery multiplier
    // is applied downstream inside assembleStopSetPlan, not here.
    return { targetSeconds: nominal, appliedCorrectionSeconds: 0 };
  }

  const rawCorrection = inputs.boundaryDriftSeconds + inputs.plannedOvershootSeconds;
  // D71: cap the correction itself, not just the resulting target — a very
  // large drift shouldn't get crammed into one plan just because the
  // floor/ceiling below would otherwise allow it. No recovery ledger
  // needed: boundaryDriftSeconds is recomputed from real wall-clock-vs-
  // schedule facts at every activation, so whatever this cap leaves
  // uncorrected persists and gets another chance next cycle.
  const appliedCorrection = Math.max(-inputs.capSeconds, Math.min(inputs.capSeconds, rawCorrection));

  // Proportional clamp, chosen over a flat floor deliberately: a segment's
  // safe correction range should scale with its own length, so a long
  // segment can't be squeezed down to a fixed near-nothing floor under heavy
  // correction pressure the way a flat 30s floor would allow.
  const targetSeconds = Math.max(nominal * 0.6, Math.min(nominal * 1.4, nominal - appliedCorrection));
  return { targetSeconds, appliedCorrectionSeconds: appliedCorrection };
}
