import { eq, asc, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ingestJobs } from '../../db/schema.js';
import { runIngestJob } from './worker.js';

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
 */
export async function recoverInterruptedJobs(): Promise<number> {
  const result = await db
    .update(ingestJobs)
    .set({
      status: 'failed',
      error_message: 'Interrupted by API restart',
      completed_at: new Date(),
    })
    .where(inArray(ingestJobs.status, ['analyzing', 'transcoding']));
  // libsql's update result type doesn't expose count directly; the return
  // value here is the recovery count consumers of this function don't need.
  return Number((result as any).rowsAffected ?? 0);
}

export const ingestQueue = new IngestQueue();
