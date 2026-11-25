import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createArchive } from './archiveStream.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'soono-archive-'));
  await writeFile(join(dir, 'a.mp3'), 'AAAA-audio');
  await writeFile(join(dir, 'b.mp3'), 'BBBB-audio');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const entry = (file: string, entryPath: string) => ({ name: file, path: join(dir, file), entryPath, startMs: Date.UTC(2026, 10, 25, 8) });
// The listing names what it was told is in the archive.
const listing = (included: ReadonlySet<string>) => `listing of ${[...included].sort().join('+')}`;

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('latin1');
}

it('stores the listing and every recording under its archive path', async () => {
  const skipped: Error[] = [];
  const job = createArchive(
    { entries: [entry('a.mp3', 'day/one.mp3'), entry('b.mp3', 'day/two.mp3')], buildListing: listing },
    (err) => skipped.push(err),
  );
  const zip = await collect(job.stream);
  await job.done;
  expect(skipped).toEqual([]);
  // Stored, not compressed: names and contents are readable as they are.
  for (const text of ['listing.csv', 'listing of a.mp3+b.mp3', 'day/one.mp3', 'AAAA-audio', 'day/two.mp3', 'BBBB-audio']) {
    expect(zip).toContain(text);
  }
});

it('skips a recording that is gone, and the listing does not claim it', async () => {
  const skipped: Error[] = [];
  const job = createArchive(
    { entries: [entry('gone.mp3', 'day/gone.mp3'), entry('b.mp3', 'day/two.mp3')], buildListing: listing },
    (err) => skipped.push(err),
  );
  const zip = await collect(job.stream);
  await job.done;
  expect(skipped).toHaveLength(1);
  expect(zip).not.toContain('day/gone.mp3');
  // Built after the files were read, from what was really added.
  expect(zip).toContain('listing of b.mp3');
  expect(zip).not.toContain('gone.mp3+');
  expect(zip).toContain('BBBB-audio');
});

it('abort ends the stream without finishing the archive', async () => {
  const job = createArchive({ entries: [entry('a.mp3', 'day/one.mp3')], buildListing: listing }, () => {});
  job.abort();
  await new Promise((resolve) => job.stream.once('close', resolve));
  expect(job.stream.destroyed).toBe(true);
});
