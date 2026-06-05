import { unlink, stat } from 'fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestJobs, media } from '../../db/schema.js';
import type { IngestJob, MediaInsert } from '../../db/schema.js';
import { ffprobe } from './ffprobe.js';
import { measureLoudness } from './loudnorm.js';
import { decideTranscode, transcodeToMp3, TRANSCODE_DEFAULTS } from './transcode.js';
import { sha256File } from './hash.js';
import { ensureDirs, mediaPathForSha, moveFile, stagingPathFor } from './paths.js';
import { identifyForIngest } from '../acoustid.js';
import { autoAnalyseOnIngest } from '../audioAnalysis.js';
import { maybeFinalizeLookupJob } from '../backgroundJobs.js';

export interface IngestOutcome {
  jobId: string;
  status: 'completed' | 'failed';
  mediaId: number | null;
  error: string | null;
  deduped: boolean;
}

/**
 * Run a single ingest job to completion. Updates the ingest_jobs row at each
 * stage so a polling client can show progress. On success, inserts (or
 * dedupes against) a media row and returns its id.
 */
export async function runIngestJob(jobId: string): Promise<IngestOutcome> {
  await ensureDirs();

  const job = await loadJob(jobId);
  if (!job) {
    throw new Error(`Ingest job ${jobId} not found`);
  }

  await markJobStarted(jobId, 'analyzing');

  let stagingPath = job.staging_path;
  let transcodedPath: string | null = null;

  try {
    // 1. Probe original.
    const probe = await ffprobe(stagingPath);

    await db
      .update(ingestJobs)
      .set({
        detected_format: probe.format_name,
        detected_bitrate: probe.bitrate_kbps,
      })
      .where(eq(ingestJobs.id, jobId));

    // 2. Loudness measurement on the original. Doing it before any transcode
    //    means we measure the *source*; gain stored is what we want to apply
    //    at playout regardless of whether we re-encoded for the bitrate cap.
    const loudness = await measureLoudness(stagingPath);

    await db
      .update(ingestJobs)
      .set({
        measured_lufs: loudness.measurement.integrated_lufs,
        measured_lra: loudness.measurement.loudness_range,
        measured_peak: loudness.measurement.true_peak_db,
      })
      .where(eq(ingestJobs.id, jobId));

    // 3. Transcode decision.
    const decision = decideTranscode(probe);

    await db
      .update(ingestJobs)
      .set({ needs_transcode: decision.needs_transcode })
      .where(eq(ingestJobs.id, jobId));

    let finalPath: string;
    let finalBitrate: number;
    let finalSampleRate: number;
    let finalChannels: number;

    if (decision.needs_transcode) {
      await db.update(ingestJobs).set({ status: 'transcoding' }).where(eq(ingestJobs.id, jobId));
      transcodedPath = `${stagingPath}.transcoded.mp3`;
      await transcodeToMp3(stagingPath, transcodedPath);
      finalPath = transcodedPath;
      finalBitrate = TRANSCODE_DEFAULTS.bitrate_kbps;
      finalSampleRate = TRANSCODE_DEFAULTS.samplerate_hz;
      finalChannels = TRANSCODE_DEFAULTS.channels;
    } else {
      finalPath = stagingPath;
      finalBitrate = probe.bitrate_kbps;
      finalSampleRate = probe.samplerate_hz;
      finalChannels = probe.channels;
    }

    // 4. Hash the final file (post-transcode if any).
    const sha = await sha256File(finalPath);

    // 5. Dedup check.
    const existing = await db.select().from(media).where(eq(media.sha256, sha)).limit(1);
    if (existing.length > 0) {
      await markJobCompleted(jobId, existing[0].id);
      // Clean up staging copies — we don't need them.
      await safeUnlink(stagingPath);
      if (transcodedPath) await safeUnlink(transcodedPath);

      if (job.lookup_job_id && job.category === 'music') {
        await db.update(ingestJobs).set({
          lookup_result: 'skipped',
          lookup_result_json: JSON.stringify({ reason: 'Duplicate — already in library' }),
        }).where(eq(ingestJobs.id, jobId));
        maybeFinalizeLookupJob(job.lookup_job_id).catch(() => undefined);
      }

      return {
        jobId,
        status: 'completed',
        mediaId: existing[0].id,
        error: null,
        deduped: true,
      };
    }

    // 6. Move final into the content-addressed media pool.
    const destPath = mediaPathForSha(sha);
    await moveFile(finalPath, destPath);

    // If we transcoded, the original staging file is still there; remove it.
    if (decision.needs_transcode && stagingPath !== finalPath) {
      await safeUnlink(stagingPath);
    }

    // 7. Insert the media row.
    const fileStat = await stat(destPath);
    const insert: MediaInsert = {
      sha256: sha,
      category: job.category,
      original_filename: job.uploaded_filename,
      duration_seconds: probe.duration_seconds,
      bitrate_kbps: finalBitrate,
      samplerate_hz: finalSampleRate,
      channels: finalChannels,
      filesize_bytes: fileStat.size,
      was_transcoded: decision.needs_transcode,
      loudness_lufs: loudness.measurement.integrated_lufs,
      loudness_lra: loudness.measurement.loudness_range,
      loudness_peak: loudness.measurement.true_peak_db,
      loudness_gain_db: loudness.gain_db,
      loudness_warning: loudness.warning,
      // title/artist/album/etc left null — the metadata-from-tags step lives
      // in Phase 6 (AcoustID). Operator can edit display fields in Phase 4.
      notes: job.uploaded_filename,
    };

    const result = await db.insert(media).values(insert).returning({ id: media.id });
    const mediaId = result[0].id;

    await markJobCompleted(jobId, mediaId);

    // For music tracks, run identification and audio analysis in the background.
    // Neither affects ingest status — fire-and-forget.
    if (job.category === 'music') {
      if (job.lookup_job_id) {
        identifyForIngest(mediaId, job.uploaded_filename).then(async (result) => {
          await db.update(ingestJobs).set({
            lookup_result: result.outcome,
            lookup_result_json: JSON.stringify(result),
          }).where(eq(ingestJobs.id, jobId));
          await maybeFinalizeLookupJob(job.lookup_job_id!);
        }).catch(() => undefined);
      }
      autoAnalyseOnIngest(mediaId).catch(() => undefined);
    }

    return { jobId, status: 'completed', mediaId, error: null, deduped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markJobFailed(jobId, message);
    if (job.lookup_job_id && job.category === 'music') {
      await db.update(ingestJobs).set({
        lookup_result: 'failed',
        lookup_result_json: JSON.stringify({ error: message }),
      }).where(eq(ingestJobs.id, jobId));
      maybeFinalizeLookupJob(job.lookup_job_id).catch(() => undefined);
    }
    return { jobId, status: 'failed', mediaId: null, error: message, deduped: false };
  }
}

async function loadJob(jobId: string): Promise<IngestJob | null> {
  const rows = await db.select().from(ingestJobs).where(eq(ingestJobs.id, jobId)).limit(1);
  return rows[0] ?? null;
}

async function markJobStarted(jobId: string, status: 'analyzing'): Promise<void> {
  await db
    .update(ingestJobs)
    .set({ status, started_at: new Date() })
    .where(eq(ingestJobs.id, jobId));
}

async function markJobCompleted(jobId: string, mediaId: number): Promise<void> {
  await db
    .update(ingestJobs)
    .set({ status: 'completed', completed_at: new Date(), media_id: mediaId, error_message: null })
    .where(eq(ingestJobs.id, jobId));
}

async function markJobFailed(jobId: string, message: string): Promise<void> {
  await db
    .update(ingestJobs)
    .set({ status: 'failed', completed_at: new Date(), error_message: message })
    .where(eq(ingestJobs.id, jobId));
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* ignore */
  }
}

export { stagingPathFor };
