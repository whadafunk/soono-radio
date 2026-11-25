// Builds the zip of a selection of recordings as a stream: nothing is written
// to disk first, so an archive of any size needs no temporary space. Entries
// are stored, not compressed — MP3 does not shrink. Large archives (over
// 4 GB, or tens of thousands of files) get ZIP64 headers from the library.
// See docs/reports-recordings-list-design.md.
//
// Recordings are opened here, one at a time, and handed to the library as
// streams. Its own "add this path" call keeps the file it was reading open
// when a download is aborted (archiver 8.0.0) — one leaked file handle per
// download a browser walks away from.
import { open } from 'fs/promises';
import type { Readable } from 'stream';
import { ZipArchive } from 'archiver';

export interface ArchiveEntry {
  name: string;       // the recording's file name on disk
  path: string;       // file on disk
  entryPath: string;  // path inside the archive
  startMs: number;    // shown as the entry's date in the archive
}

export interface ArchiveJob {
  stream: Readable;
  // Resolves when the archive is complete, rejects when it fails.
  done: Promise<void>;
  // Stops reading and closes the open recording; for a download whose
  // browser went away.
  abort: () => void;
}

export function createArchive(
  input: {
    entries: ArchiveEntry[];
    // The listing.csv, given the names that really went into the archive.
    // Asked for last: a long download can outlive a recording (the hourly
    // clean-up, another operator's Delete), and a listing written up front
    // would then claim a recording the archive does not hold.
    buildListing: (includedNames: ReadonlySet<string>) => string;
  },
  // Told about a recording that vanished between selection and archiving;
  // the archive carries on without it.
  onSkipped: (err: Error) => void,
): ArchiveJob {
  const archive = new ZipArchive({ store: true });
  const included = new Set<string>();
  let current: Readable | null = null;
  let stopped = false;
  let index = 0;
  let listingAdded = false;

  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });

  const addNext = async (): Promise<void> => {
    current = null;
    while (!stopped && index < input.entries.length) {
      const entry = input.entries[index++];
      try {
        // Once open, the whole recording stays readable even if it is
        // deleted while it is being sent.
        const handle = await open(entry.path, 'r');
        if (stopped) { await handle.close(); return; }
        current = handle.createReadStream(); // closes the handle when it ends or is destroyed
        included.add(entry.name);
        archive.append(current, { name: entry.entryPath, date: new Date(entry.startMs) });
        return; // the 'entry' event calls addNext again
      } catch (err) {
        onSkipped(err as Error);
      }
    }
    if (stopped) return;
    if (!listingAdded) {
      listingAdded = true;
      archive.append(input.buildListing(included), { name: 'listing.csv' });
      return; // its 'entry' event brings us back to finalize
    }
    // A failure here reaches `done` through the 'error' event.
    archive.finalize().catch(() => {});
  };

  // Fires once per finished entry.
  archive.on('entry', () => {
    void addNext().catch((err: Error) => archive.destroy(err));
  });
  void addNext().catch((err: Error) => archive.destroy(err));

  return {
    stream: archive,
    done,
    abort: () => {
      stopped = true;
      current?.destroy();
      archive.abort();
      archive.destroy();
    },
  };
}
