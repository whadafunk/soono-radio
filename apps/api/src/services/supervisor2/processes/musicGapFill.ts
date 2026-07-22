// D114: pure helpers behind finalize-time music gap-fill (planner.ts,
// `finalizeMusicGapFill`). Pulled into their own dependency-free module so
// they're unit-testable without pulling in the DB client or the bus — see
// docs/supervisor-v2-design.md Decision 114 for the full design.

import type { PlanItem } from '../../../db/schema.js';
import type { MusicCandidate } from '../types.js';

// Groups a position-ordered list of plan items into contiguous runs of
// invalidated music items ("gaps"). Anything that isn't an invalidated music
// item — a non-music item (envelope, interstitial survivor — never
// invalidated by isItemStillValid, which only special-cases music/campaign/
// promo) or a still-valid music item — closes out the current run, since
// neither one moves. Also returns how many still-valid music items survive
// outside any gap, the seed for the tail fill's interstitial cadence count.
export function groupInvalidMusicRuns(
  ordered: PlanItem[],
  isInvalidMusic: (item: PlanItem) => boolean,
): { runs: PlanItem[][]; survivorMusicCount: number } {
  const runs: PlanItem[][] = [];
  let current: PlanItem[] = [];
  let survivorMusicCount = 0;
  for (const it of ordered) {
    if (isInvalidMusic(it)) {
      current.push(it);
      continue;
    }
    if (current.length > 0) {
      runs.push(current);
      current = [];
    }
    if (it.content_type === 'music') survivorMusicCount += 1;
  }
  if (current.length > 0) runs.push(current);
  return { runs, survivorMusicCount };
}

// The gap-fill replacement rule: smallest still-eligible candidate, with no
// attempt to match the gap's original duration — the tail fill (the normal
// draft budget-walk, seeded to resume where this leaves off) absorbs
// whatever difference that leaves, the same way draft assembly already
// absorbs the gap between its last placed track and the segment boundary.
//
// Excluding anything already in `usedMediaIds` is the actual fix for the
// reported bug: two invalidated items in the same finalize pass (plan 9386,
// 2026-07-21) both resolved to the same fresh candidate (media 654) because
// nothing recorded what the loop had already handed out earlier in the same
// pass. Callers must add each pick's media_id to the same set before the
// next call — survivors, every gap filler, and the tail fill all share one
// set spanning the whole pass.
export function pickSmallestEligibleCandidate(
  candidates: MusicCandidate[],
  usedMediaIds: ReadonlySet<number>,
): MusicCandidate | null {
  let best: MusicCandidate | null = null;
  for (const c of candidates) {
    if (usedMediaIds.has(c.media_id)) continue;
    if (best == null || c.duration_seconds < best.duration_seconds) best = c;
  }
  return best;
}
