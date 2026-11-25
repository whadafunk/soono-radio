// The Recordings list's filters (docs/reports-recordings-list-design.md).
// Pure and shared: the page runs them in the browser on the period it has
// loaded. Unit-tested from apps/api (services/recordings/recordingFilters.test.ts).
//
// "Local" time here is the browser's, which is the station's — the app is
// only used from the station's timezone (docs/station-timezone-design.md).
import type { RecordingFlag, RecordingListItem, RecordingPeriodDay } from './schemas/recordings.js';

export interface RecordingFilter {
  // Hours of the day, 0–24. Applied only when both are set and hourTo is
  // after hourFrom.
  hourFrom: number | null;
  hourTo: number | null;
  // ISO weekdays, 1 = Monday … 7 = Sunday. Empty = every day.
  weekdays: number[];
  flag: 'any' | 'unflagged' | RecordingFlag;
  noRecordingOnly: boolean;
}

export const EMPTY_RECORDING_FILTER: RecordingFilter = { hourFrom: null, hourTo: null, weekdays: [], flag: 'any', noRecordingOnly: false };

function ymdParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10));
  return [y, m, d];
}

function isoWeekday(date: string): number {
  const [y, m, d] = ymdParts(date);
  const js = new Date(y, m - 1, d).getDay();
  return js === 0 ? 7 : js;
}

function passesFlag(item: RecordingListItem, flag: RecordingFilter['flag']): boolean {
  if (flag === 'any') return true;
  // A filter must never hide missing recording time; the expected gaps (off
  // air, a restart's few seconds) would only be noise in a list of flagged
  // recordings.
  if (item.kind === 'gap') return item.label === 'no_recording';
  if (flag === 'unflagged') return item.flags.length === 0;
  return item.flags.some((f) => f.flag === flag);
}

// The days and rows that pass the filter. A day's totals are left as they
// are — they describe the whole day, filtered or not. Days left without rows
// are dropped.
export function filterPeriodDays(days: RecordingPeriodDay[], filter: RecordingFilter): RecordingPeriodDay[] {
  const useHours = filter.hourFrom != null && filter.hourTo != null && filter.hourTo > filter.hourFrom;
  const out: RecordingPeriodDay[] = [];
  for (const day of days) {
    if (filter.weekdays.length > 0 && !filter.weekdays.includes(isoWeekday(day.date))) continue;

    let items = day.items;
    if (useHours) {
      // Wall-clock hours on that date, built with the local constructor: on a
      // clock-change day "midnight + N hours" would be an hour off.
      const [y, m, d] = ymdParts(day.date);
      const fromMs = new Date(y, m - 1, d, filter.hourFrom!).getTime();
      const toMs = new Date(y, m - 1, d, filter.hourTo!).getTime();
      items = items.filter((i) => i.start_ms < toMs && i.end_ms > fromMs);
    }
    if (filter.noRecordingOnly) {
      items = items.filter((i) => i.kind === 'gap' && i.label === 'no_recording');
    } else {
      items = items.filter((i) => passesFlag(i, filter.flag));
    }
    if (items.length > 0) out.push({ ...day, items });
  }
  return out;
}
