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

export async function ensureDirs(): Promise<void> {
  await mkdir(STAGING_DIR, { recursive: true });
  await mkdir(MEDIA_DIR, { recursive: true });
}
