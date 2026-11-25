import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'soono-store-test-'));
process.env.RECORDINGS_DIR = join(root, 'recordings');
const { diskUsage, listAllRawFiles, listRawFiles } = await import('./recordingStore.js');

afterAll(() => {
  try { chmodSync(process.env.RECORDINGS_DIR!, 0o755); } catch { /* never created */ }
  rmSync(root, { recursive: true, force: true });
});

describe('recordingStore on a folder that cannot be used', () => {
  it('treats a missing folder as empty', async () => {
    expect(await listAllRawFiles()).toEqual([]);
    expect(await listRawFiles(['2026-11-24'])).toEqual([]);
    expect(await diskUsage()).toBeNull();
  });
  it('treats an unreadable folder as empty instead of failing', async () => {
    const dir = process.env.RECORDINGS_DIR!;
    mkdirSync(join(dir, '2026-11-24'), { recursive: true });
    writeFileSync(join(dir, '2026-11-24', '2026-11-24T10-00-00Z.mp3'), 'x');
    expect((await listAllRawFiles()).map((f) => f.name)).toEqual(['2026-11-24T10-00-00Z.mp3']);
    chmodSync(dir, 0o000);
    expect(await listAllRawFiles()).toEqual([]);
    expect(await listRawFiles(['2026-11-24'])).toEqual([]);
  });
});
