// What the recordings folder means — pure functions over file names, sizes
// and times. No filesystem access here (that is recordingStore.ts), so the
// rules are unit-tested (recordingIndex.test.ts).
//
// Layout written by the mix engine (liquidsoap/mix-engine.liq.hbs):
//   /recordings/<UTC date>/<UTC start>Z.mp3
//   e.g. /recordings/2026-11-24/2026-11-24T23-00-00Z.mp3
// The folder is the only source of truth: there is no table of recordings.
// Anything in it that is not named like a recording (the mix engine's
// .write-test probe, a stray file someone dropped there) is ignored
// everywhere — never listed, never counted, never deleted.
// See docs/reports-recordings-design.md.

export interface RecordingFile {
  day: string;        // UTC date folder, YYYY-MM-DD
  name: string;       // file name inside it
  startMs: number;    // from the name
  endMs: number;      // last write, clamped to the next file's start
  sizeBytes: number;
  recordingNow: boolean;
}

export interface RecordingGap {
  startMs: number;
  endMs: number;
  label: 'off_air' | 'interruption' | 'no_recording';
}

export type RecordingItem = ({ kind: 'file' } & RecordingFile) | ({ kind: 'gap' } & RecordingGap);

// A file still growing within this long of "now" is the one being written.
const RECORDING_NOW_WINDOW_MS = 60_000;
// A gap shorter than this is what every mix-engine restart leaves behind
// (settings save, deploy) — shown, but not as a problem.
const INTERRUPTION_MAX_MS = 120_000;
// The longest a single file can be (segment_minutes tops out at 60).
const MAX_FILE_MS = 3_600_000;

const NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.mp3$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// UTC start of a recording from its file name, or null when the name is not
// a recording's.
export function parseRecordingFileName(name: string): number | null {
  const m = NAME_PATTERN.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => parseInt(x, 10));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Reject impossible dates/times that Date.UTC would silently roll over.
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d ||
    back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s
  ) return null;
  return ms;
}

// True only for a recording inside its own day folder. Everything that takes
// a day/name from a request goes through this before touching the disk.
export function isSafeRecordingRef(day: string, name: string): boolean {
  return DAY_PATTERN.test(day) && parseRecordingFileName(name) != null && name.slice(0, 10) === day;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The UTC date folders that can hold a file overlapping [fromMs, toMs]:
// from one file-length before the window (a file that started earlier may
// still be running into it) through the window's end.
export function utcFoldersForWindow(fromMs: number, toMs: number): string[] {
  const folders: string[] = [];
  const last = utcDay(toMs);
  let cursor = Date.UTC(
    new Date(fromMs - MAX_FILE_MS).getUTCFullYear(),
    new Date(fromMs - MAX_FILE_MS).getUTCMonth(),
    new Date(fromMs - MAX_FILE_MS).getUTCDate(),
  );
  for (;;) {
    const day = utcDay(cursor);
    folders.push(day);
    if (day >= last) break;
    cursor += 86_400_000; // UTC days are always 24 hours
  }
  return folders;
}

// Directory entries → recordings, oldest first. A file's end is its last
// write, not size ÷ bitrate: that stays right when the quality setting
// changes from one file to the next.
export function buildRecordingFiles(
  raw: Array<{ day: string; name: string; sizeBytes: number; mtimeMs: number }>,
  nowMs: number,
): RecordingFile[] {
  const parsed = raw
    .map((r) => ({ r, startMs: parseRecordingFileName(r.name) }))
    .filter((x): x is { r: (typeof raw)[number]; startMs: number } => x.startMs != null && isSafeRecordingRef(x.r.day, x.r.name))
    .sort((a, b) => a.startMs - b.startMs);

  return parsed.map(({ r, startMs }, i) => {
    const next = parsed[i + 1];
    const lastWrite = Math.max(startMs, r.mtimeMs);
    return {
      day: r.day,
      name: r.name,
      startMs,
      endMs: next ? Math.min(lastWrite, next.startMs) : lastWrite,
      sizeBytes: r.sizeBytes,
      // Any file written in the last minute counts, not just the newest name:
      // a stray file with a later name must not strip the live file of its
      // protection from deletion.
      recordingNow: nowMs - r.mtimeMs <= RECORDING_NOW_WINDOW_MS,
    };
  });
}

// The recordings that overlap a window, with the gaps between them inside
// that window. The part of a gap spent off air is "off air"; of the rest, a
// short stretch is an "interruption" and anything longer is "no recording" —
// the one that matters.
export function describeWindow(
  files: RecordingFile[],
  offAir: Array<{ fromMs: number; toMs: number | null }>,
  windowStartMs: number,
  windowEndMs: number,
): RecordingItem[] {
  const items: RecordingItem[] = [];

  // A gap is split at off-air boundaries and each piece labelled on its own.
  // Labelling the whole gap "off air" because it touches an off-air period
  // would let a five-minute restart hide hours of recording that went
  // missing before it — and this list must never hide missing minutes.
  const pushGap = (startMs: number, endMs: number): void => {
    const off = offAir
      .map((p) => ({ from: Math.max(p.fromMs, startMs), to: Math.min(p.toMs ?? Number.POSITIVE_INFINITY, endMs) }))
      .filter((p) => p.to > p.from)
      .sort((a, b) => a.from - b.from);
    const unexplained = (from: number, to: number): void => {
      if (to > from) items.push({ kind: 'gap', startMs: from, endMs: to, label: to - from < INTERRUPTION_MAX_MS ? 'interruption' : 'no_recording' });
    };
    let at = startMs;
    for (const p of off) {
      if (p.to <= at) continue; // overlapping off-air periods
      unexplained(at, p.from);
      items.push({ kind: 'gap', startMs: Math.max(at, p.from), endMs: p.to, label: 'off_air' });
      at = p.to;
    }
    unexplained(at, endMs);
  };

  let cursor = windowStartMs;
  let recordingNow = false;
  for (const file of files) {
    if (file.endMs <= windowStartMs || file.startMs >= windowEndMs) continue;
    recordingNow = file.recordingNow;
    if (file.startMs > cursor) pushGap(cursor, file.startMs);
    items.push({ kind: 'file', ...file });
    cursor = Math.max(cursor, file.endMs);
  }
  // While the last file is still being written, the stretch from its last
  // write to "now" is recording in progress, not a gap.
  if (cursor < windowEndMs && !recordingNow) {
    pushGap(cursor, windowEndMs);
  }
  return items;
}
