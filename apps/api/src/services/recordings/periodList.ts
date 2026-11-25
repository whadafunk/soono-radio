// One station day of the Recordings list, and its totals — pure, so the rules
// are unit-tested (periodList.test.ts). The route builds a period by calling
// these once per day. See docs/reports-recordings-list-design.md.
import { describeWindow, type RecordingFile, type RecordingItem } from './recordingIndex.js';

// The recordings and gaps of the station day [dayStartMs, dayEndMs).
//
// A recording belongs to the day it STARTS in. One that runs past midnight is
// left off the next day's list — a selectable row that appeared twice would
// be selected, counted and archived twice — but the time it covers there is
// still not a gap.
export function dayItems(
  files: RecordingFile[],
  offAir: Array<{ fromMs: number; toMs: number | null }>,
  dayStartMs: number,
  dayEndMs: number,
): RecordingItem[] {
  return describeWindow(files, offAir, dayStartMs, dayEndMs)
    .filter((item) => item.kind === 'gap' || item.startMs >= dayStartMs);
}

// The day's summary line. Taken from the items themselves, so a 23- or
// 25-hour day adds up to its real length.
export function summariseDay(items: RecordingItem[]): { recordedMs: number; noRecordingMs: number; sizeBytes: number } {
  let recordedMs = 0;
  let noRecordingMs = 0;
  let sizeBytes = 0;
  for (const item of items) {
    if (item.kind === 'file') {
      recordedMs += item.endMs - item.startMs;
      sizeBytes += item.sizeBytes;
    } else if (item.label === 'no_recording') {
      noRecordingMs += item.endMs - item.startMs;
    }
  }
  return { recordedMs, noRecordingMs, sizeBytes };
}
