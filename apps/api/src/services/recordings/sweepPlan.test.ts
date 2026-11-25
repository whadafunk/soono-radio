import { expect, it } from 'vitest';
import { planSweep } from './sweepPlan.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 24, 12);
const f = (daysOld: number, sizeBytes = 100, recordingNow = false) => {
  const startMs = now - daysOld * DAY;
  return { day: 'd', name: `f${daysOld}`, startMs, endMs: startMs + 3_600_000, sizeBytes, recordingNow };
};
const base = { holds: [], nowMs: now, retentionDays: 60, protectedDays: 30, freeBytes: 1_000_000, minFreeBytes: 0 };

it('deletes only what is older than the retention', () => {
  const r = planSweep({ ...base, files: [f(61), f(59), f(1)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f61', reason: 'retention' }]);
  expect(r.floorUnmet).toBe(false);
});
it('never deletes a held recording, however old', () => {
  const old = f(90);
  const r = planSweep({ ...base, files: [old], holds: [{ fromMs: old.startMs + 60_000, toMs: old.startMs + 120_000 }] });
  expect(r.deletions).toEqual([]);
});
it('never deletes the file being written', () => {
  expect(planSweep({ ...base, files: [f(90, 100, true)] }).deletions).toEqual([]);
});
it('frees space oldest-first until the floor is met', () => {
  const r = planSweep({ ...base, freeBytes: 50, minFreeBytes: 200, files: [f(50), f(45), f(40), f(35)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f50', reason: 'disk_floor' }, { day: 'd', name: 'f45', reason: 'disk_floor' }]);
  expect(r.floorUnmet).toBe(false);
});
it('counts retention deletions toward the floor before deleting more', () => {
  const r = planSweep({ ...base, freeBytes: 50, minFreeBytes: 140, files: [f(61), f(50)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f61', reason: 'retention' }]);
});
it('stops at the protected age and says the floor is unmet', () => {
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 1_000, files: [f(40), f(29), f(10)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f40', reason: 'disk_floor' }]);
  expect(r.floorUnmet).toBe(true);
});
it('skips held files when freeing space and reports the floor unmet if that is all there is', () => {
  const held = f(50);
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 50, files: [held], holds: [{ fromMs: held.startMs, toMs: held.endMs }] });
  expect(r).toEqual({ deletions: [], floorUnmet: true });
});
it('does nothing with no files', () => {
  expect(planSweep({ ...base, files: [] })).toEqual({ deletions: [], floorUnmet: false });
});
