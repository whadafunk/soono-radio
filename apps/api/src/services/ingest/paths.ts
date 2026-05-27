import { join } from 'path';
import { mkdir } from 'fs/promises';

const REPO_ROOT = process.env.RADIO_REPO_ROOT || join(process.cwd(), '..', '..');

export const STAGING_DIR = process.env.RADIO_STAGING_DIR || join(REPO_ROOT, 'data', 'incoming');
export const MEDIA_DIR = process.env.RADIO_MEDIA_DIR || join(REPO_ROOT, 'media');

export function stagingPathFor(jobId: string): string {
  return join(STAGING_DIR, jobId);
}

export function mediaPathForSha(sha256: string): string {
  return join(MEDIA_DIR, `${sha256}.mp3`);
}

// Read LS_MEDIA_DIR lazily so that index.ts can load .env before the first
// call, even though the module itself initialises before index.ts body runs.
// When LS runs in Docker the media dir is mounted at /media; set
// LS_MEDIA_DIR=/media (written automatically by start-liquidsoap.sh).
export function lsMediaPathForSha(sha256: string): string {
  return join(process.env.LS_MEDIA_DIR ?? MEDIA_DIR, `${sha256}.mp3`);
}

export async function ensureDirs(): Promise<void> {
  await mkdir(STAGING_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
}
