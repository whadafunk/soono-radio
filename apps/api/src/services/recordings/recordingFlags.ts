// Flags on recordings (docs/reports-recordings-list-design.md). The only
// module that reads or writes recording_flags. Rows are keyed by file name;
// a recording that is deleted takes its flags with it (removeFlagsFor).
import { and, eq, inArray } from 'drizzle-orm';
import { RECORDING_FLAGS, type RecordingFlag, type RecordingFlagEntry } from '@soono/shared';
import { db } from '../../db/index.js';
import { recordingFlags } from '../../db/schema.js';

// SQLite caps the number of bound values in one statement; a selection can be
// thousands of recordings.
const CHUNK = 500;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

// File name → its flags, in the fixed display order.
export async function loadFlags(): Promise<Map<string, RecordingFlagEntry[]>> {
  const rows = await db.select({ name: recordingFlags.name, flag: recordingFlags.flag, note: recordingFlags.note }).from(recordingFlags);
  const byName = new Map<string, RecordingFlagEntry[]>();
  for (const r of rows) {
    const list = byName.get(r.name) ?? [];
    list.push({ flag: r.flag, note: r.note });
    byName.set(r.name, list);
  }
  for (const list of byName.values()) {
    list.sort((a, b) => RECORDING_FLAGS.indexOf(a.flag) - RECORDING_FLAGS.indexOf(b.flag));
  }
  return byName;
}

// Names of the recordings no clean-up or delete may remove.
export async function protectedNames(): Promise<Set<string>> {
  const rows = await db.select({ name: recordingFlags.name }).from(recordingFlags).where(eq(recordingFlags.flag, 'protect'));
  return new Set(rows.map((r) => r.name));
}

// Sets the flag on every name. A note replaces the note of a flag that is
// already set; an empty note leaves it alone — protecting a whole day must not
// erase the reference someone wrote on one of its hours.
export async function setFlag(names: string[], flag: RecordingFlag, note: string): Promise<number> {
  const createdAt = Date.now();
  for (const part of chunks(names)) {
    const insert = db.insert(recordingFlags).values(part.map((name) => ({ name, flag, note, created_at_ms: createdAt })));
    if (note === '') {
      await insert.onConflictDoNothing({ target: [recordingFlags.name, recordingFlags.flag] });
    } else {
      await insert.onConflictDoUpdate({ target: [recordingFlags.name, recordingFlags.flag], set: { note } });
    }
  }
  return names.length;
}

export async function clearFlag(names: string[], flag: RecordingFlag): Promise<number> {
  let cleared = 0;
  for (const part of chunks(names)) {
    const removed = await db
      .delete(recordingFlags)
      .where(and(eq(recordingFlags.flag, flag), inArray(recordingFlags.name, part)))
      .returning({ id: recordingFlags.id });
    cleared += removed.length;
  }
  return cleared;
}

// Called by everything that deletes recordings.
export async function removeFlagsFor(names: string[]): Promise<void> {
  for (const part of chunks(names)) {
    await db.delete(recordingFlags).where(inArray(recordingFlags.name, part));
  }
}
