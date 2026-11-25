// The only module that touches the recordings folder on disk. Every path is
// built from a validated (day, name) pair — nothing from a request is ever
// joined into a path unchecked. A missing folder (first boot, volume not
// mounted) is an empty one, never an error.
import { readdir, rm, rmdir, stat, statfs } from 'fs/promises';
import { join } from 'path';
import { isSafeRecordingRef } from './recordingIndex.js';

export const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? '/recordings';

export interface RawRecordingFile {
  day: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Missing or not readable: either way there is nothing to list, and a page
// load or the Dashboard's status poll must not turn into a 500 over it. The
// status then reports that nothing is being recorded.
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
}

// Entries of the given UTC date folders. Folders that do not exist are
// skipped; names are returned as found — recordingIndex decides what counts.
export async function listRawFiles(folders: string[]): Promise<RawRecordingFile[]> {
  const out: RawRecordingFile[] = [];
  for (const day of folders) {
    if (!DAY_PATTERN.test(day)) continue;
    let names: string[];
    try {
      names = await readdir(join(RECORDINGS_DIR, day));
    } catch (err) {
      if (isMissing(err)) continue;
      throw err;
    }
    for (const name of names) {
      try {
        const st = await stat(join(RECORDINGS_DIR, day, name));
        if (st.isFile()) out.push({ day, name, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        if (!isMissing(err)) throw err; // deleted between readdir and stat: skip
      }
    }
  }
  return out;
}

// Every date folder present.
export async function listAllRawFiles(): Promise<RawRecordingFile[]> {
  let entries: string[];
  try {
    entries = await readdir(RECORDINGS_DIR);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  return listRawFiles(entries.filter((e) => DAY_PATTERN.test(e)).sort());
}

// Absolute path of a recording. Throws for anything that is not a recording
// inside its own day folder.
export function filePath(day: string, name: string): string {
  if (!isSafeRecordingRef(day, name)) throw new Error('Not a recording');
  return join(RECORDINGS_DIR, day, name);
}

// Deletes one recording, and its day folder if that leaves it empty.
export async function deleteFile(day: string, name: string): Promise<void> {
  await rm(filePath(day, name), { force: true });
  try {
    await rmdir(join(RECORDINGS_DIR, day));
  } catch {
    // not empty (or already gone) — leave it
  }
}

// Free and total space of the disk the recordings live on; null when the
// folder is missing.
export async function diskUsage(): Promise<{ freeBytes: number; totalBytes: number } | null> {
  try {
    const fs = await statfs(RECORDINGS_DIR);
    return { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}
