import { eq, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backgroundJobs } from '../db/schema.js';
import type { JobType, JobStatus } from '../db/schema.js';
import type { LookupIdResults, AnalyseResults } from '@radio/shared';

function newJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function createJob(
  type: JobType,
  label: string,
  total: number,
): Promise<string> {
  const id = newJobId();
  await db.insert(backgroundJobs).values({ id, type, label, total, status: 'running' });
  return id;
}

export async function completeLookupIdJob(
  jobId: string,
  results: LookupIdResults,
): Promise<void> {
  const reviewPending = results.skipped.filter((s) => !s.resolved).length;
  const status: JobStatus = reviewPending > 0 ? 'review_pending' : 'completed';
  await db
    .update(backgroundJobs)
    .set({
      status,
      succeeded: results.applied.length,
      failed: results.failed.length,
      review_pending: reviewPending,
      results_json: JSON.stringify(results),
      completed_at: new Date(),
    })
    .where(eq(backgroundJobs.id, jobId));
}

export async function completeAnalyseJob(
  jobId: string,
  results: AnalyseResults,
): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({
      status: 'completed',
      succeeded: results.succeeded.length,
      failed: results.failed.length,
      results_json: JSON.stringify(results),
      completed_at: new Date(),
    })
    .where(eq(backgroundJobs.id, jobId));
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({
      status: 'completed',
      results_json: JSON.stringify({ error }),
      completed_at: new Date(),
    })
    .where(eq(backgroundJobs.id, jobId));
}

// When a new batch includes tracks that already have a pending review,
// remove those tracks from the old job (last-batch-wins per track).
export async function supersedePendingReviews(trackIds: number[]): Promise<void> {
  if (trackIds.length === 0) return;
  const pendingJobs = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.status, 'review_pending'));

  for (const job of pendingJobs) {
    if (!job.results_json) continue;
    let results: LookupIdResults;
    try {
      results = JSON.parse(job.results_json) as LookupIdResults;
    } catch {
      continue;
    }
    const before = results.skipped.filter((s) => !s.resolved).length;
    results.skipped = results.skipped.map((s) =>
      trackIds.includes(s.id) ? { ...s, resolved: true } : s,
    );
    const after = results.skipped.filter((s) => !s.resolved).length;
    if (after === before) continue; // nothing changed

    const newStatus: JobStatus = after === 0 ? 'done' : 'review_pending';
    await db
      .update(backgroundJobs)
      .set({
        status: newStatus,
        review_pending: after,
        results_json: JSON.stringify(results),
      })
      .where(eq(backgroundJobs.id, job.id));
  }
}
