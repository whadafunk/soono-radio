import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { media } from '../db/schema.js';
import { mediaPathForSha } from './ingest/paths.js';
import { runAudioAnalysis } from './ingest/audioAnalysis.js';
import { getIntegrationsConfig } from './integrations/config.js';

/**
 * On boot, mark any media row left at 'analysing' as failed — it was
 * interrupted by a restart. The in-process concurrency queue in
 * ingest/audioAnalysis.ts (acquireAnalysisSlot) lives only in memory, so a
 * restart silently drops whatever was running or queued with no other trace.
 * Mirrors recoverInterruptedJobs() in services/ingest/queue.ts for the same
 * class of problem on the ingest side.
 */
export async function recoverInterruptedAnalysis(): Promise<number> {
  const result = await db
    .update(media)
    .set({
      analysis_status: 'failed',
      analysis_error: 'Interrupted by API restart',
      updated_at: new Date(),
    })
    .where(eq(media.analysis_status, 'analysing'));
  return Number((result as any).rowsAffected ?? 0);
}

export async function analyseMedia(mediaId: number): Promise<void> {
  const rows = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (rows.length === 0) throw new Error(`Media ${mediaId} not found`);
  const row = rows[0];
  const filePath = mediaPathForSha(row.sha256);

  await db
    .update(media)
    .set({ analysis_status: 'analysing', updated_at: new Date() })
    .where(eq(media.id, mediaId));

  try {
    const result = await runAudioAnalysis(filePath);
    await db
      .update(media)
      .set({
        bpm: result.bpm,
        musical_key: result.musical_key,
        key_scale: result.key_scale,
        mood_tags: result.mood_tags.length > 0 ? JSON.stringify(result.mood_tags) : null,
        energy: result.energy,
        danceability: result.danceability,
        analysis_status: 'completed',
        analysis_error: null,
        updated_at: new Date(),
      })
      .where(eq(media.id, mediaId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(media)
      .set({ analysis_status: 'failed', analysis_error: message, updated_at: new Date() })
      .where(eq(media.id, mediaId));
    throw err;
  }
}

export async function autoAnalyseOnIngest(mediaId: number): Promise<void> {
  const config = getIntegrationsConfig();
  if (!config.audio_analysis_enabled) return;
  try {
    await analyseMedia(mediaId);
  } catch {
    // Best-effort — failures must never surface to the ingest caller.
  }
}
