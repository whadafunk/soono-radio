// What to do with an item that was handed to the mix engine when the station
// goes off air. Items flip to 'playing' at PUSH time, so at any moment up to
// two of them are in flight: the one genuinely airing and the one pre-queued
// behind it. They need opposite bookkeeping — and the difference decides
// whether a sold spot is reported as delivered:
//
//   never_aired — pushed but the mix engine never confirmed it started. Its
//                 play_history row is only a push-time placeholder; campaign
//                 delivery counts don't filter on `confirmed`, so leaving the
//                 row would report a spot that never aired as delivered.
//                 The row is removed.
//   finished    — confirmed on air and already past its planned end (it
//                 played out; nothing started after it to close its row).
//                 A complete play — closed at its planned end.
//   cut         — confirmed on air and still inside its planned duration:
//                 going off air cut it short. Marked aborted, which campaign
//                 billing/pacing already excludes (Decision 63).
//
// Dependency-free so it can be unit-tested without the DB or the bus.

export type InFlightDisposition = 'never_aired' | 'finished' | 'cut';

export interface InFlightItem {
  // play_history.confirmed — null when the item has no play_history row.
  confirmed: boolean | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  plannedDurationSeconds: number;
}

export function classifyInFlightItem(item: InFlightItem, nowMs: number): InFlightDisposition {
  if (!item.confirmed || item.startedAtMs == null) return 'never_aired';
  if (item.endedAtMs != null) return 'finished';
  const plannedEndMs = item.startedAtMs + item.plannedDurationSeconds * 1_000;
  return plannedEndMs <= nowMs ? 'finished' : 'cut';
}

export function plannedEndMs(item: InFlightItem): number | null {
  if (item.startedAtMs == null) return null;
  return item.startedAtMs + item.plannedDurationSeconds * 1_000;
}
