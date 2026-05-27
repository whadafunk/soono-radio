import { join } from 'path';
import { mkdir } from 'fs/promises';

const REPO_ROOT = process.env.RADIO_REPO_ROOT || join(process.cwd(), '..', '..');

export const STAGING_DIR = process.env.RADIO_STAGING_DIR || join(REPO_ROOT, 'data', 'incoming');
export const MEDIA_DIR = process.env.RADIO_MEDIA_DIR || join(REPO_ROOT, 'media');

// Path prefix used when building annotated URIs for LiquidSoap. When LS runs
// in Docker the media directory is mounted at a different path than on the
// host (typically /media). Set LS_MEDIA_DIR=/media in the API's environment
// when running LS via Docker so the URIs it receives are resolvable inside
// the container.
export const LS_MEDIA_DIR = process.env.LS_MEDIA_DIR ?? MEDIA_DIR;

export function stagingPathFor(jobId: string): string {
  return join(STAGING_DIR, jobId);
}

export function mediaPathForSha(sha256: string): string {
  return join(MEDIA_DIR, `${sha256}.mp3`);
}

export function lsMediaPathForSha(sha256: string): string {
  return join(LS_MEDIA_DIR, `${sha256}.mp3`);
}

export async function ensureDirs(): Promise<void> {
  await mkdir(STAGING_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
}
