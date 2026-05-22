import { eq, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backgroundJobs, ingestJobs } from '../db/schema.js';
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

/**
 * Called after each ingest job writes its lookup_result. Once all ingest jobs
 * linked to the lookup job have a result, builds the final LookupIdResults and
 * transitions the background job to completed or review_pending.
 */
export async function maybeFinalizeLookupJob(lookupJobId: string): Promise<void> {
  const jobs = await db
    .select()
    .from(ingestJobs)
    .where(eq(ingestJobs.lookup_job_id, lookupJobId));

  if (jobs.some((j) => j.lookup_result === null)) return; // still waiting

  const results: LookupIdResults = { applied: [], skipped: [], failed: [] };
  for (const job of jobs) {
    const mediaId = job.media_id;
    if (!mediaId) continue;
    let data: Record<string, unknown> = {};
    try { data = job.lookup_result_json ? JSON.parse(job.lookup_result_json) : {}; } catch { /* ignore */ }

    if (job.lookup_result === 'applied') {
      const c = data.appliedCandidate as { title?: string | null; artist?: string | null; album?: string | null; year?: number | null; score?: number } | undefined;
      results.applied.push({ id: mediaId, filename: job.uploaded_filename, title: c?.title ?? null, artist: c?.artist ?? null, album: c?.album ?? null, year: c?.year ?? null, score: c?.score ?? 0 });
    } else if (job.lookup_result === 'skipped') {
      results.skipped.push({ id: mediaId, filename: job.uploaded_filename, reason: (data.reason as string) ?? 'Unknown', candidates: (data.candidates as LookupIdResults['skipped'][number]['candidates']) ?? [], resolved: false });
    } else if (job.lookup_result === 'failed') {
      results.failed.push({ id: mediaId, filename: job.uploaded_filename, error: (data.error as string) ?? 'Unknown error' });
    }
  }

  await completeLookupIdJob(lookupJobId, results);
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
