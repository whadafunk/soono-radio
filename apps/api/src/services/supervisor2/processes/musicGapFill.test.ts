import { describe, expect, it } from 'vitest';
import type { PlanItem } from '../../../db/schema.js';
import type { MusicCandidate } from '../types.js';
import { groupInvalidMusicRuns, pickSmallestEligibleCandidate } from './musicGapFill.js';

// Minimal PlanItem builder — only the fields groupInvalidMusicRuns reads.
function planItem(overrides: Partial<PlanItem> & Pick<PlanItem, 'id' | 'position'>): PlanItem {
  return {
    plan_id: 9386,
    media_id: 0,
    content_type: 'music',
    campaign_id: null,
    music_campaign_id: null,
    planned_duration_seconds: 0,
    mandatory: false,
    status: 'pending',
    reason: '',
    play_history_id: null,
    cut_allowed: 1,
    skip_allowed: 1,
    ...overrides,
  };
}

function candidate(overrides: Partial<MusicCandidate> & Pick<MusicCandidate, 'id' | 'media_id' | 'duration_seconds'>): MusicCandidate {
  return {
    source: 'rotation',
    rotation_id: 1,
    reason_hint: '',
    ...overrides,
  };
}

describe('groupInvalidMusicRuns', () => {
  it('groups a plan where every music item was invalidated into one run (plan 9386)', () => {
    // The actual 2026-07-21 incident: 3 music items, all invalidated in the
    // same finalize pass, positions 0/1/2, durations 207.9/227.4/207.9.
    const items = [
      planItem({ id: 19860, position: 0, media_id: 654, planned_duration_seconds: 207.908571 }),
      planItem({ id: 19861, position: 1, media_id: 484, planned_duration_seconds: 227.369796 }),
      planItem({ id: 19862, position: 2, media_id: 999, planned_duration_seconds: 207.908571 }),
    ];
    const { runs, survivorMusicCount } = groupInvalidMusicRuns(items, () => true);
    expect(runs).toHaveLength(1);
    expect(runs[0].map((it) => it.id)).toEqual([19860, 19861, 19862]);
    expect(survivorMusicCount).toBe(0);
  });

  it('splits into separate gaps when a valid survivor sits between invalidated items', () => {
    const items = [
      planItem({ id: 1, position: 0, content_type: 'music' }), // invalid
      planItem({ id: 2, position: 1, content_type: 'music' }), // valid survivor
      planItem({ id: 3, position: 2, content_type: 'music' }), // invalid
    ];
    const invalidIds = new Set([1, 3]);
    const { runs, survivorMusicCount } = groupInvalidMusicRuns(items, (it) => invalidIds.has(it.id));
    expect(runs).toHaveLength(2);
    expect(runs[0].map((it) => it.id)).toEqual([1]);
    expect(runs[1].map((it) => it.id)).toEqual([3]);
    expect(survivorMusicCount).toBe(1);
  });

  it('a non-music survivor (envelope/interstitial) also closes out a run', () => {
    const items = [
      planItem({ id: 1, position: 0, content_type: 'music' }),
      planItem({ id: 2, position: 1, content_type: 'station_id' }),
      planItem({ id: 3, position: 2, content_type: 'music' }),
    ];
    const { runs, survivorMusicCount } = groupInvalidMusicRuns(items, (it) => it.content_type === 'music');
    expect(runs).toHaveLength(2);
    expect(runs[0].map((it) => it.id)).toEqual([1]);
    expect(runs[1].map((it) => it.id)).toEqual([3]);
    expect(survivorMusicCount).toBe(0); // both music items were "invalid" here
  });

  it('returns no runs when nothing is invalidated', () => {
    const items = [
      planItem({ id: 1, position: 0, content_type: 'music' }),
      planItem({ id: 2, position: 1, content_type: 'music' }),
    ];
    const { runs, survivorMusicCount } = groupInvalidMusicRuns(items, () => false);
    expect(runs).toHaveLength(0);
    expect(survivorMusicCount).toBe(2);
  });
});

describe('pickSmallestEligibleCandidate', () => {
  it('picks the smallest candidate not already used', () => {
    const candidates = [
      candidate({ id: 1, media_id: 100, duration_seconds: 300 }),
      candidate({ id: 2, media_id: 101, duration_seconds: 90 }),
      candidate({ id: 3, media_id: 102, duration_seconds: 200 }),
    ];
    const pick = pickSmallestEligibleCandidate(candidates, new Set());
    expect(pick?.media_id).toBe(101);
  });

  it('skips already-used media ids', () => {
    const candidates = [
      candidate({ id: 1, media_id: 100, duration_seconds: 90 }),
      candidate({ id: 2, media_id: 101, duration_seconds: 120 }),
    ];
    const pick = pickSmallestEligibleCandidate(candidates, new Set([100]));
    expect(pick?.media_id).toBe(101);
  });

  it('returns null once every candidate is used', () => {
    const candidates = [candidate({ id: 1, media_id: 100, duration_seconds: 90 })];
    const pick = pickSmallestEligibleCandidate(candidates, new Set([100]));
    expect(pick).toBeNull();
  });

  // The actual regression: this is what plan 9386 got wrong. Two gaps in one
  // finalize pass both needed a filler; nothing recorded that the first gap
  // had already used a candidate, so both picked the same one (media 654).
  it('never returns the same candidate for two gaps in the same pass', () => {
    const candidates = [
      candidate({ id: 1, media_id: 654, duration_seconds: 90 }), // "smallest" both times
      candidate({ id: 2, media_id: 484, duration_seconds: 120 }),
      candidate({ id: 3, media_id: 999, duration_seconds: 150 }),
    ];
    const usedMediaIds = new Set<number>();

    const firstGapPick = pickSmallestEligibleCandidate(candidates, usedMediaIds);
    expect(firstGapPick?.media_id).toBe(654);
    usedMediaIds.add(firstGapPick!.media_id); // caller's contract: mark used before the next gap

    const secondGapPick = pickSmallestEligibleCandidate(candidates, usedMediaIds);
    expect(secondGapPick?.media_id).not.toBe(654);
    expect(secondGapPick?.media_id).toBe(484);
  });
});
