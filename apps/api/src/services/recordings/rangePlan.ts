// Which recordings make up a requested time range, how much of each, and
// what is missing — the decision only (rangePlan.test.ts); rangeExport.ts
// does the joining. A range handed to the CNA must never hide missing
// minutes, so every gap inside the range is reported, including a missing
// start or end.
import type { RecordingFile } from './recordingIndex.js';

// Bounds the join job; a longer period is downloaded as several ranges.
export const MAX_RANGE_MS = 24 * 3_600_000;

export interface RangePart {
  day: string;
  name: string;
  skipMs: number; // from the start of the file
  takeMs: number;
}

export type RangePlan =
  | { parts: RangePart[]; gaps: Array<{ startMs: number; endMs: number }>; coveredMs: number }
  | { error: 'invalid_range' | 'too_long' | 'nothing_recorded' };

export function planRange(files: RecordingFile[], fromMs: number, toMs: number): RangePlan {
  if (!(toMs > fromMs)) return { error: 'invalid_range' };
  if (toMs - fromMs > MAX_RANGE_MS) return { error: 'too_long' };

  const overlapping = files
    .filter((f) => f.endMs > fromMs && f.startMs < toMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (overlapping.length === 0) return { error: 'nothing_recorded' };

  const parts: RangePart[] = [];
  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let coveredMs = 0;
  let cursor = fromMs;
  for (const f of overlapping) {
    const partStart = Math.max(f.startMs, fromMs);
    const partEnd = Math.min(f.endMs, toMs);
    if (partStart > cursor) gaps.push({ startMs: cursor, endMs: partStart });
    const takeMs = partEnd - partStart;
    if (takeMs > 0) {
      parts.push({ day: f.day, name: f.name, skipMs: partStart - f.startMs, takeMs });
      coveredMs += takeMs;
    }
    cursor = Math.max(cursor, partEnd);
  }
  if (cursor < toMs) gaps.push({ startMs: cursor, endMs: toMs });
  return { parts, gaps, coveredMs };
}
