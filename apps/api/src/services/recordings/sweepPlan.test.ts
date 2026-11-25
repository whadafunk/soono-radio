import { expect, it } from 'vitest';
import { planSweep } from './sweepPlan.js';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 24, 12);
const f = (daysOld: number, sizeBytes = 100, recordingNow = false) => {
  const startMs = now - daysOld * DAY;
  return { day: 'd', name: `f${daysOld}`, startMs, endMs: startMs + 3_600_000, sizeBytes, recordingNow };
};
const base = { protectedNames: new Set<string>(), nowMs: now, retentionDays: 60, protectedDays: 30, freeBytes: 1_000_000, minFreeBytes: 0 };

it('deletes only what is older than the retention', () => {
  const r = planSweep({ ...base, files: [f(61), f(59), f(1)] });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f61', reason: 'retention' }]);
  expect(r.floorUnmet).toBe(false);
});
it('keeps a protected recording past retention', () => {
  const r = planSweep({ ...base, files: [f(90)], protectedNames: new Set(['f90']) });
  expect(r.deletions).toEqual([]);
});
it('disk floor skips a protected recording and takes the next oldest', () => {
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 1_000, files: [f(40), f(35)], protectedNames: new Set(['f40']) });
  expect(r.deletions).toEqual([{ day: 'd', name: 'f35', reason: 'disk_floor' }]);
});
it('a protected recording does not stop the disk-floor pass', () => {
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 100, files: [f(40), f(35)], protectedNames: new Set(['f40']) });
  expect(r).toEqual({ deletions: [{ day: 'd', name: 'f35', reason: 'disk_floor' }], floorUnmet: false });
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
it('reports the floor unmet when only protected recordings are left', () => {
  const r = planSweep({ ...base, freeBytes: 0, minFreeBytes: 50, files: [f(50)], protectedNames: new Set(['f50']) });
  expect(r).toEqual({ deletions: [], floorUnmet: true });
});
it('does nothing with no files', () => {
  expect(planSweep({ ...base, files: [] })).toEqual({ deletions: [], floorUnmet: false });
});
