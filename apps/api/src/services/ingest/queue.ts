import { eq, asc, inArray, isNull, isNotNull, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestJobs, backgroundJobs } from '../../db/schema.js';
import { runIngestJob } from './worker.js';
import { identifyForIngest } from '../acoustid.js';
import { maybeFinalizeLookupJob } from '../backgroundJobs.js';

/**
 * Single-flight in-process queue. Phase 2 ships intentionally minimal — one
 * job at a time, no parallelism, no Redis. When upload throughput becomes a
 * concern, swap in BullMQ behind the same enqueue() / signal() interface.
 */
class IngestQueue {
  private running = false;
  private signalled = false;

  /**
   * Wake the queue. Safe to call repeatedly. If the queue is already
   * running, the next iteration will pick up newly-enqueued jobs.
   */
  signal(): void {
    this.signalled = true;
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.signalled) {
        this.signalled = false;
        const next = await pickNextQueued();
        if (!next) break;
        try {
          await runIngestJob(next);
        } catch (err) {
          // runIngestJob handles its own error→DB write, but defend against
          // unexpected throws so the queue doesn't wedge.
          console.error(`[ingest] runIngestJob threw for ${next}:`, err);
        }
        // After each job, re-check for more. signal() raises the flag if any
        // arrived during processing.
        this.signalled = true;
      }
    } finally {
      this.running = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

async function pickNextQueued(): Promise<string | null> {
  const rows = await db
    .select({ id: ingestJobs.id })
    .from(ingestJobs)
    .where(eq(ingestJobs.status, 'queued'))
    .orderBy(asc(ingestJobs.created_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * On boot, mark any in-progress jobs as failed (they were interrupted) and
 * leave queued jobs alone — the queue will pick them up.
 * Also writes lookup_result='failed' so they don't block batch finalization.
 */
export async function recoverInterruptedJobs(): Promise<number> {
  const result = await db
    .update(ingestJobs)
    .set({
      status: 'failed',
      error_message: 'Interrupted by API restart',
      completed_at: new Date(),
      lookup_result: 'failed',
      lookup_result_json: JSON.stringify({ error: 'Interrupted by API restart' }),
    })
    .where(inArray(ingestJobs.status, ['analyzing', 'transcoding']));
  return Number((result as any).rowsAffected ?? 0);
}

/**
 * On boot, re-run identification for any ingest jobs that completed
 * successfully but whose fire-and-forget identification was cut short by a
 * restart. Then attempts to finalize any lookup batch whose last job is now
 * accounted for. Queued jobs are left alone — the queue handles them normally.
 */
export async function recoverLookupJobs(): Promise<void> {
  // Re-identify ingest jobs that completed but whose identification was cut short.
  const orphans = await db
    .select()
    .from(ingestJobs)
    .where(
      and(
        isNotNull(ingestJobs.lookup_job_id),
        isNull(ingestJobs.lookup_result),
        eq(ingestJobs.status, 'completed'),
      ),
    );

  const affectedLookupJobIds = new Set<string>();

  for (const job of orphans) {
    if (!job.media_id || !job.lookup_job_id) continue;
    const result = await identifyForIngest(job.media_id, job.uploaded_filename);
    await db.update(ingestJobs).set({
      lookup_result: result.outcome,
      lookup_result_json: JSON.stringify(result),
    }).where(eq(ingestJobs.id, job.id));
    affectedLookupJobIds.add(job.lookup_job_id);
  }

  for (const lookupJobId of affectedLookupJobIds) {
    await maybeFinalizeLookupJob(lookupJobId);
  }

  // Also finalize any 'running' lookup jobs that have no linked ingest rows —
  // these were created before the upload failed and have nothing to wait for.
  const stuckJobs = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(and(eq(backgroundJobs.type, 'lookup_id'), eq(backgroundJobs.status, 'running')));

  for (const job of stuckJobs) {
    if (affectedLookupJobIds.has(job.id)) continue; // already being handled above
    await maybeFinalizeLookupJob(job.id);
  }
}

export const ingestQueue = new IngestQueue();
