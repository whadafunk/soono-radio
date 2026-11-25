// The listing.csv that travels inside an archive of recordings: what the
// archive holds and — just as important for a file handed over as proof —
// what it does not. Every recording and every gap between the first and the
// last selected recording gets a row, so missing time cannot go unnoticed.
// Pure; unit-tested in archiveListing.test.ts.
import { RECORDING_FLAG_LABELS, type RecordingFlagEntry } from '@soono/shared';
import { stationFileName } from './archiveNames.js';
import { describeWindow, type RecordingFile, type RecordingGap } from './recordingIndex.js';

const GAP_TYPE: Record<RecordingGap['label'], string> = {
  off_air: 'off air',
  interruption: 'interruption',
  no_recording: 'no recording',
};

const p2 = (n: number): string => String(n).padStart(2, '0');

// Station time, YYYY-MM-DD HH:MM:SS.
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// H:MM:SS
function length(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 3600)}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)}`;
}

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildListingCsv(input: {
  files: RecordingFile[];                          // everything on disk around the selection
  included: ReadonlySet<string>;                   // file names that are in the archive
  offAir: Array<{ fromMs: number; toMs: number | null }>;
  flags: Map<string, RecordingFlagEntry[]>;
  entryPaths: Map<string, string>;                 // file name → path inside the archive
}): string {
  const lines = ['start,end,length,type,file,included,flags,notes'];
  const included = input.files.filter((f) => input.included.has(f.name)).sort((a, b) => a.startMs - b.startMs);
  if (included.length > 0) {
    const spanStartMs = included[0].startMs;
    const spanEndMs = included[included.length - 1].endMs;
    const inSpan = input.files
      .filter((f) => f.startMs >= spanStartMs && f.startMs < spanEndMs)
      .sort((a, b) => a.startMs - b.startMs);
    for (const item of describeWindow(inSpan, input.offAir, spanStartMs, spanEndMs)) {
      const times = [stamp(item.startMs), stamp(item.endMs), length(item.endMs - item.startMs)];
      if (item.kind === 'gap') {
        lines.push([...times, GAP_TYPE[item.label], '', '', '', ''].join(','));
        continue;
      }
      const isIncluded = input.included.has(item.name);
      const flags = input.flags.get(item.name) ?? [];
      lines.push([
        ...times,
        'recorded',
        field(isIncluded ? input.entryPaths.get(item.name) ?? stationFileName(item.startMs) : stationFileName(item.startMs)),
        isIncluded ? 'yes' : 'no',
        field(flags.map((f) => RECORDING_FLAG_LABELS[f.flag]).join('; ')),
        field(flags.map((f) => f.note).filter((n) => n !== '').join('; ')),
      ].join(','));
    }
  }
  // The byte-order mark makes spreadsheet programs read the notes as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}
