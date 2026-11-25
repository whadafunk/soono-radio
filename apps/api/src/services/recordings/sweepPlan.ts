// Which recordings the automatic sweep deletes — the decision only, no disk
// access, so every rule is unit-tested (sweepPlan.test.ts).
//
// Two passes, in this order:
//   1. Retention: anything that ended more than `retentionDays` ago.
//   2. Disk floor: if free space is still below the floor, the oldest
//      remaining recordings — but never one younger than `protectedDays`.
//      When the floor cannot be met without crossing that age, nothing more
//      is deleted and `floorUnmet` says so (the page warns). The operator
//      accepted that the disk can then really fill.
// Never deleted, in either pass: a recording flagged Protect, and the file
// being written. See docs/reports-recordings-design.md and
// docs/reports-recordings-list-design.md.
import type { RecordingFile } from './recordingIndex.js';

const DAY_MS = 86_400_000;

export interface SweepDeletion {
  day: string;
  name: string;
  reason: 'retention' | 'disk_floor';
}

export function planSweep(input: {
  files: RecordingFile[];
  protectedNames: ReadonlySet<string>; // file names flagged Protect
  nowMs: number;
  retentionDays: number;
  protectedDays: number;
  freeBytes: number;
  minFreeBytes: number;
}): { deletions: SweepDeletion[]; floorUnmet: boolean } {
  const deletions: SweepDeletion[] = [];
  let freeBytes = input.freeBytes;
  const ageMs = (f: RecordingFile): number => input.nowMs - f.endMs;

  const deletable = input.files
    .filter((f) => !f.recordingNow && !input.protectedNames.has(f.name))
    .sort((a, b) => a.startMs - b.startMs);

  const kept: RecordingFile[] = [];
  for (const f of deletable) {
    if (ageMs(f) > input.retentionDays * DAY_MS) {
      deletions.push({ day: f.day, name: f.name, reason: 'retention' });
      freeBytes += f.sizeBytes;
    } else {
      kept.push(f);
    }
  }

  for (const f of kept) {
    if (freeBytes >= input.minFreeBytes) break;
    if (ageMs(f) < input.protectedDays * DAY_MS) break; // oldest-first: everything after is younger still
    deletions.push({ day: f.day, name: f.name, reason: 'disk_floor' });
    freeBytes += f.sizeBytes;
  }

  return { deletions, floorUnmet: freeBytes < input.minFreeBytes };
}
