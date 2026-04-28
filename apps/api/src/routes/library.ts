import { FastifyInstance } from 'fastify';
import { eq, and, or, like, desc, asc, inArray, sql, count, SQL } from 'drizzle-orm';
import { createWriteStream, createReadStream } from 'fs';
import { rename, stat, unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { basename, join } from 'path';
import {
  MediaPatchSchema,
  TranscodeOptionsSchema,
  BulkIdsSchema,
  BulkCategorySchema,
  BulkFavoriteSchema,
} from '@radio/shared';
import { inArray as inArrayOp } from 'drizzle-orm';
import { deleteMedia, reMeasureMedia, reTranscodeMedia } from '../services/library.js';
import { db } from '../db/index.js';
import { ingestJobs, media, MEDIA_CATEGORIES } from '../db/schema.js';
import type { MediaCategory } from '../db/schema.js';
import { ensureDirs, STAGING_DIR, mediaPathForSha, stagingPathFor } from '../services/ingest/paths.js';
import { ingestQueue } from '../services/ingest/queue.js';

const SORTABLE_FIELDS = [
  'title',
  'artist',
  'album',
  'created_at',
  'last_played_at',
  'play_count',
  'duration_seconds',
  'bitrate_kbps',
] as const;
type SortField = (typeof SORTABLE_FIELDS)[number];

function isSortField(value: string): value is SortField {
  return (SORTABLE_FIELDS as readonly string[]).includes(value);
}

function newJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isMediaCategory(value: string): value is MediaCategory {
  return (MEDIA_CATEGORIES as readonly string[]).includes(value);
}

interface UploadedJob {
  job_id: string;
  filename: string;
  size_bytes: number;
}

export async function libraryRoutes(fastify: FastifyInstance) {
  fastify.post('/library/upload', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.status(400).send({ error: 'multipart/form-data required' });
    }

    await ensureDirs();

    let category: MediaCategory | null = null;
    const created: UploadedJob[] = [];
    // Track temp files written before category arrives so we can rename them
    // once we have it (or unlink on failure).
    const pending: Array<{ tempPath: string; filename: string; size: number }> = [];

    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'category' && typeof part.value === 'string') {
            if (!isMediaCategory(part.value)) {
              return reply.status(400).send({
                error: `Invalid category. Must be one of: ${MEDIA_CATEGORIES.join(', ')}`,
              });
            }
            category = part.value;
          }
          continue;
        }

        // It's a file part. Stream it to a temp filename inside STAGING_DIR.
        const tempName = `pending-${newJobId()}`;
        const tempPath = join(STAGING_DIR, tempName);
        const filename = basename(part.filename || tempName);

        await pipeline(part.file, createWriteStream(tempPath));

        if (part.file.truncated) {
          await safeUnlink(tempPath);
          return reply.status(413).send({
            error: `File ${filename} exceeded the size limit`,
          });
        }

        const fileStat = await stat(tempPath);
        pending.push({ tempPath, filename, size: fileStat.size });
      }

      if (!category) {
        // Wipe staged files; we won't be able to use them without a category.
        await Promise.all(pending.map((p) => safeUnlink(p.tempPath)));
        return reply.status(400).send({ error: 'category field is required' });
      }

      if (pending.length === 0) {
        return reply.status(400).send({ error: 'No files uploaded' });
      }

      // Rename each temp file to its final staging path under the new job id,
      // then insert the ingest_jobs row.
      for (const p of pending) {
        const jobId = newJobId();
        const finalPath = stagingPathFor(jobId);
        await rename(p.tempPath, finalPath);

        await db.insert(ingestJobs).values({
          id: jobId,
          status: 'queued',
          uploaded_filename: p.filename,
          uploaded_size_bytes: p.size,
          staging_path: finalPath,
          category,
        });

        created.push({ job_id: jobId, filename: p.filename, size_bytes: p.size });
      }

      // Wake the worker. It picks up jobs serially; this is fire-and-forget.
      ingestQueue.signal();

      return reply.status(202).send({ jobs: created });
    } catch (err) {
      // Best-effort cleanup of any temp files we wrote before the throw.
      await Promise.all(pending.map((p) => safeUnlink(p.tempPath)));
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>('/library/ingest/:id', async (request, reply) => {
    const { id } = request.params;
    const rows = await db.select().from(ingestJobs).where(eq(ingestJobs.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ error: 'Ingest job not found' });
    }
    return reply.send(row);
  });

  fastify.get<{
    Querystring: {
      q?: string;
      category?: string;
      favorite?: string;
      sort?: string;
      order?: string;
      limit?: string;
      offset?: string;
    };
  }>('/library', async (request, reply) => {
    const { q, category, favorite, sort, order, limit, offset } = request.query;

    const filters: SQL<unknown>[] = [];
    if (category) {
      const categories = category
        .split(',')
        .map((c) => c.trim())
        .filter((c): c is MediaCategory => isMediaCategory(c));
      if (categories.length === 1) filters.push(eq(media.category, categories[0]));
      else if (categories.length > 1) filters.push(inArray(media.category, categories));
    }
    if (favorite === 'true') filters.push(eq(media.favorite, true));
    if (favorite === 'false') filters.push(eq(media.favorite, false));
    if (q && q.trim().length > 0) {
      const needle = `%${q.trim().toLowerCase()}%`;
      filters.push(
        or(
          like(sql`lower(${media.title})`, needle),
          like(sql`lower(${media.artist})`, needle),
          like(sql`lower(${media.album})`, needle),
          like(sql`lower(${media.original_filename})`, needle),
        )!,
      );
    }
    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const sortField: SortField = sort && isSortField(sort) ? sort : 'created_at';
    const sortDir = order === 'asc' ? asc : desc;
    const sortColumn = media[sortField as keyof typeof media] as any;

    const safeLimit = clamp(parseInt(limit ?? '50', 10) || 50, 1, 200);
    const safeOffset = Math.max(0, parseInt(offset ?? '0', 10) || 0);

    const itemsQuery = db
      .select()
      .from(media)
      .orderBy(sortDir(sortColumn))
      .limit(safeLimit)
      .offset(safeOffset);
    const totalQuery = db.select({ value: count() }).from(media);

    const [items, totalRows] = await Promise.all([
      whereClause ? itemsQuery.where(whereClause) : itemsQuery,
      whereClause ? totalQuery.where(whereClause) : totalQuery,
    ]);

    return reply.send({
      items,
      total: totalRows[0]?.value ?? 0,
      limit: safeLimit,
      offset: safeOffset,
    });
  });

  fastify.get<{ Params: { id: string } }>('/library/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    return reply.send(rows[0]);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/library/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });

    const parsed = MediaPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ errors: parsed.error.errors });
    }

    const updates: Record<string, unknown> = { ...parsed.data, updated_at: new Date() };
    if (Object.keys(parsed.data).length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    const result = await db
      .update(media)
      .set(updates)
      .where(eq(media.id, id))
      .returning();
    if (result.length === 0) return reply.status(404).send({ error: 'Not found' });
    return reply.send(result[0]);
  });

  fastify.delete<{ Params: { id: string } }>('/library/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    try {
      await deleteMedia(id);
      return reply.status(200).send({ success: true });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) return reply.status(404).send({ error: msg });
      return reply.status(500).send({ error: msg });
    }
  });

  fastify.post<{ Params: { id: string } }>('/library/:id/re-measure', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    try {
      const updated = await reMeasureMedia(id);
      return reply.send(updated);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/library/:id/re-transcode',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
      const parsed = TranscodeOptionsSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ errors: parsed.error.errors });
      }
      try {
        const updated = await reTranscodeMedia(id, parsed.data);
        return reply.send(updated);
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  fastify.post<{ Params: { id: string } }>('/library/:id/acoustid', async (_request, reply) => {
    return reply.status(501).send({
      error: 'AcoustID lookup is planned for Phase 6 of the library plan',
    });
  });

  // Bulk operations.
  fastify.delete<{ Body: unknown }>('/library', async (request, reply) => {
    const parsed = BulkIdsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const results = { succeeded: [] as number[], failed: [] as { id: number; error: string }[] };
    for (const id of parsed.data.ids) {
      try {
        await deleteMedia(id);
        results.succeeded.push(id);
      } catch (err) {
        results.failed.push({ id, error: (err as Error).message });
      }
    }
    return reply.send(results);
  });

  fastify.post<{ Body: unknown }>('/library/bulk-category', async (request, reply) => {
    const parsed = BulkCategorySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const result = await db
      .update(media)
      .set({ category: parsed.data.category, updated_at: new Date() })
      .where(inArrayOp(media.id, parsed.data.ids));
    return reply.send({ updated: parsed.data.ids.length, result });
  });

  fastify.post<{ Body: unknown }>('/library/bulk-favorite', async (request, reply) => {
    const parsed = BulkFavoriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    await db
      .update(media)
      .set({ favorite: parsed.data.favorite, updated_at: new Date() })
      .where(inArrayOp(media.id, parsed.data.ids));
    return reply.send({ updated: parsed.data.ids.length });
  });

  fastify.post<{ Body: unknown }>('/library/bulk-remeasure', async (request, reply) => {
    const parsed = BulkIdsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const results = { succeeded: [] as number[], failed: [] as { id: number; error: string }[] };
    // Sequential to avoid spawning N ffmpeg processes at once.
    for (const id of parsed.data.ids) {
      try {
        await reMeasureMedia(id);
        results.succeeded.push(id);
      } catch (err) {
        results.failed.push({ id, error: (err as Error).message });
      }
    }
    return reply.send(results);
  });

  fastify.post('/library/bulk-retranscode', async (_request, reply) => {
    return reply.status(501).send({
      error: 'Bulk re-transcode is a Phase 5+ placeholder; use the per-track action for now',
    });
  });

  fastify.post('/library/bulk-acoustid', async (_request, reply) => {
    return reply.status(501).send({
      error: 'AcoustID lookup is planned for Phase 6 of the library plan',
    });
  });

  fastify.get<{ Params: { id: string } }>('/library/:id/audio', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    const row = rows[0];

    const path = mediaPathForSha(row.sha256);
    const fileStat = await stat(path).catch(() => null);
    if (!fileStat) return reply.status(404).send({ error: 'Audio file missing on disk' });

    const range = request.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Content-Type', 'audio/mpeg');

    if (!range) {
      reply.header('Content-Length', fileStat.size);
      return reply.send(createReadStream(path));
    }

    // Parse `bytes=<start>-<end>`. Audio players send these for seeking.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return reply.status(416).send({ error: 'Invalid Range header' });
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileStat.size - 1;
    if (start >= fileStat.size || end >= fileStat.size || start > end) {
      reply.header('Content-Range', `bytes */${fileStat.size}`);
      return reply.status(416).send();
    }

    reply.status(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);
    reply.header('Content-Length', end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  });

  fastify.get('/library/ingest', async (_request, reply) => {
    // Return the most-recent jobs (cap to keep responses bounded).
    const rows = await db
      .select()
      .from(ingestJobs)
      .orderBy(ingestJobs.created_at)
      .limit(200);
    // Reverse so newest comes first without a separate desc() in case
    // we want to keep this query simple.
    return reply.send({ jobs: rows.reverse() });
  });
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
