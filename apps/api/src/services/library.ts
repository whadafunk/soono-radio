import { eq, and, ne } from 'drizzle-orm';
import { rename, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import type { Media } from '../db/schema.js';
import { mediaPathForSha, STAGING_DIR } from './ingest/paths.js';
import { ffprobe } from './ingest/ffprobe.js';
import { measureLoudness } from './ingest/loudnorm.js';
import { reTranscodeMp3, ReTranscodeOptions } from './ingest/transcode.js';
import { sha256File } from './ingest/hash.js';

const TARGET_LUFS = -23;

async function loadMedia(id: number): Promise<Media> {
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
  if (rows.length === 0) throw new Error(`Media ${id} not found`);
  return rows[0];
}

export async function deleteMedia(id: number): Promise<void> {
  const row = await loadMedia(id);
  const path = mediaPathForSha(row.sha256);
  await db.delete(media).where(eq(media.id, id));
  await safeUnlink(path);
}

/**
 * Re-run loudness measurement on the existing media file and update the
 * row's loudness_* fields in place. The audio data isn't touched.
 */
export async function reMeasureMedia(id: number): Promise<Media> {
  const row = await loadMedia(id);
  const path = mediaPathForSha(row.sha256);
  await stat(path); // throws if missing

  const loudness = await measureLoudness(path);

  const result = await db
    .update(media)
    .set({
      loudness_lufs: loudness.measurement.integrated_lufs,
      loudness_lra: loudness.measurement.loudness_range,
      loudness_peak: loudness.measurement.true_peak_db,
      loudness_gain_db: Number.isFinite(loudness.measurement.integrated_lufs)
        ? TARGET_LUFS - loudness.measurement.integrated_lufs
        : 0,
      loudness_warning: loudness.warning,
      updated_at: new Date(),
    })
    .where(eq(media.id, id))
    .returning();
  return result[0];
}

/**
 * Re-encode the existing MP3 with operator-chosen options. Quality degrades
 * slightly per pass — exposed deliberately, with a UI warning. After the
 * encode succeeds, ffprobe + measureLoudness run on the new file so the
 * media row reflects the post-encode reality.
 */
export async function reTranscodeMedia(
  id: number,
  options: ReTranscodeOptions,
): Promise<Media> {
  const row = await loadMedia(id);
  const sourcePath = mediaPathForSha(row.sha256);
  await stat(sourcePath); // throws if missing

  const tempPath = join(STAGING_DIR, `retranscode-${id}-${Date.now()}.mp3`);

  try {
    await reTranscodeMp3(sourcePath, tempPath, options);

    const probe = await ffprobe(tempPath);
    const loudness = await measureLoudness(tempPath);
    const newSha = await sha256File(tempPath);

    // If the new sha collides with a different existing row, refuse to
    // proceed: that would orphan the dedup target. Vanishingly rare in
    // practice but worth handling cleanly.
    if (newSha !== row.sha256) {
      const conflicts = await db
        .select({ id: media.id })
        .from(media)
        .where(and(eq(media.sha256, newSha), ne(media.id, id)))
        .limit(1);
      if (conflicts.length > 0) {
        throw new Error(
          `Re-transcoded content matches an existing track (id=${conflicts[0].id}); refusing to overwrite. Delete the duplicate first or change the encode options.`,
        );
      }
    }

    const fileStat = await stat(tempPath);
    const newPath = mediaPathForSha(newSha);

    if (newSha !== row.sha256) {
      await rename(tempPath, newPath);
      await safeUnlink(sourcePath);
    } else {
      // Bit-identical output: drop the temp, keep the original.
      await safeUnlink(tempPath);
    }

    const result = await db
      .update(media)
      .set({
        sha256: newSha,
        bitrate_kbps: probe.bitrate_kbps,
        samplerate_hz: probe.samplerate_hz,
        channels: probe.channels,
        filesize_bytes: fileStat.size,
        was_transcoded: true,
        loudness_lufs: loudness.measurement.integrated_lufs,
        loudness_lra: loudness.measurement.loudness_range,
        loudness_peak: loudness.measurement.true_peak_db,
        loudness_gain_db: Number.isFinite(loudness.measurement.integrated_lufs)
          ? TARGET_LUFS - loudness.measurement.integrated_lufs
          : 0,
        loudness_warning: loudness.warning,
        updated_at: new Date(),
      })
      .where(eq(media.id, id))
      .returning();
    return result[0];
  } catch (err) {
    await safeUnlink(tempPath);
    throw err;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}
