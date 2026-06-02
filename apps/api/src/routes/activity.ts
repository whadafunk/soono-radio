import { FastifyInstance } from 'fastify';
import { eq, desc, count, sql, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backgroundJobs, media } from '../db/schema.js';
import type { LookupIdResults } from '@soono/shared';

export async function activityRoutes(fastify: FastifyInstance) {
  // Badge counts — running jobs and pending review count
  fastify.get('/activity/stats', async (_request, reply) => {
    const [running] = await db
      .select({ value: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, 'running'));
    const [reviewPending] = await db
      .select({ value: count() })
      .from(backgroundJobs)
      .where(eq(backgroundJobs.status, 'review_pending'));
    return reply.send({
      running: running?.value ?? 0,
      review_pending: reviewPending?.value ?? 0,
    });
  });

  // List all jobs, newest first (no pagination needed — jobs are few)
  fastify.get('/activity', async (_request, reply) => {
    const rows = await db
      .select({
        id: backgroundJobs.id,
        type: backgroundJobs.type,
        label: backgroundJobs.label,
        status: backgroundJobs.status,
        total: backgroundJobs.total,
        succeeded: backgroundJobs.succeeded,
        failed: backgroundJobs.failed,
        review_pending: backgroundJobs.review_pending,
        created_at: backgroundJobs.created_at,
        completed_at: backgroundJobs.completed_at,
      })
      .from(backgroundJobs)
      .orderBy(desc(backgroundJobs.created_at))
      .limit(200);
    return reply.send({ jobs: rows });
  });

  // Full job detail including results_json
  fastify.get<{ Params: { id: string } }>('/activity/:id', async (request, reply) => {
    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, request.params.id))
      .limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'Job not found' });
    return reply.send(rows[0]);
  });

  // Resolve a single skipped item: apply a candidate or dismiss
  fastify.post<{
    Params: { id: string };
    Body: unknown;
  }>('/activity/:id/resolve', async (request, reply) => {
    const body = request.body as { media_id: number; action: 'apply' | 'dismiss'; candidate_index?: number };
    if (!body || typeof body.media_id !== 'number' || !['apply', 'dismiss'].includes(body.action)) {
      return reply.status(400).send({ error: 'media_id and action (apply|dismiss) required' });
    }

    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, request.params.id))
      .limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'Job not found' });

    const job = rows[0];
    if (!job.results_json) return reply.status(400).send({ error: 'Job has no results' });

    let results: LookupIdResults;
    try {
      results = JSON.parse(job.results_json) as LookupIdResults;
    } catch {
      return reply.status(500).send({ error: 'Malformed results JSON' });
    }

    const itemIdx = results.skipped.findIndex((s) => s.id === body.media_id);
    if (itemIdx === -1) return reply.status(404).send({ error: 'Track not found in skipped list' });

    const item = results.skipped[itemIdx];
    if (item.resolved) return reply.status(400).send({ error: 'Already resolved' });

    if (body.action === 'apply') {
      const ci = body.candidate_index ?? 0;
      const candidate = item.candidates[ci];
      if (!candidate) return reply.status(400).send({ error: 'Invalid candidate_index' });
      await db
        .update(media)
        .set({
          title: candidate.title,
          artist: candidate.artist,
          album: candidate.album,
          year: candidate.year,
          notes: sql`COALESCE(${media.notes}, ${item.filename})`,
          updated_at: new Date(),
        })
        .where(eq(media.id, body.media_id));
    }

    results.skipped[itemIdx] = { ...item, resolved: true };
    const remainingReview = results.skipped.filter((s) => !s.resolved).length;
    const newStatus = remainingReview === 0 ? 'done' : 'review_pending';

    await db
      .update(backgroundJobs)
      .set({
        results_json: JSON.stringify(results),
        review_pending: remainingReview,
        status: newStatus,
      })
      .where(eq(backgroundJobs.id, request.params.id));

    return reply.send({ remaining: remainingReview, status: newStatus });
  });

  // Dismiss all pending review items at once
  fastify.post<{ Params: { id: string } }>('/activity/:id/dismiss-all', async (request, reply) => {
    const rows = await db
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.id, request.params.id))
      .limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'Job not found' });

    const job = rows[0];
    if (!job.results_json) return reply.status(400).send({ error: 'Job has no results' });

    let results: LookupIdResults;
    try {
      results = JSON.parse(job.results_json) as LookupIdResults;
    } catch {
      return reply.status(500).send({ error: 'Malformed results JSON' });
    }

    results.skipped = results.skipped.map((s) => ({ ...s, resolved: true }));
    await db
      .update(backgroundJobs)
      .set({ results_json: JSON.stringify(results), review_pending: 0, status: 'done' })
      .where(eq(backgroundJobs.id, request.params.id));

    return reply.send({ status: 'done' });
  });

  // Delete a job entry
  fastify.delete<{ Params: { id: string } }>('/activity/:id', async (request, reply) => {
    await db.delete(backgroundJobs).where(eq(backgroundJobs.id, request.params.id));
    return reply.send({ success: true });
  });
}
