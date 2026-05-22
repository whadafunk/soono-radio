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
  LookupIdResults,
  AnalyseResults,
} from '@radio/shared';
import { inArray as inArrayOp } from 'drizzle-orm';
import { deleteMedia, reMeasureMedia, reTranscodeMedia } from '../services/library.js';
import { identifyMedia, isAutoApply } from '../services/acoustid.js';
import { analyseMedia } from '../services/audioAnalysis.js';
import { db } from '../db/index.js';
import { ingestJobs, media, MEDIA_CATEGORIES } from '../db/schema.js';
import type { MediaCategory } from '../db/schema.js';
import { ensureDirs, STAGING_DIR, mediaPathForSha, stagingPathFor } from '../services/ingest/paths.js';
import { ingestQueue } from '../services/ingest/queue.js';
import { createJob, completeLookupIdJob, completeAnalyseJob, failJob, supersedePendingReviews } from '../services/backgroundJobs.js';

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

      // Rename each temp file to its final staging path and insert ingest rows.
      // lookup_job_id is set in a follow-up UPDATE after all rows exist, so a
      // partial failure never leaves an orphaned background job.
      const ingestJobIds: string[] = [];
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

        ingestJobIds.push(jobId);
        created.push({ job_id: jobId, filename: p.filename, size_bytes: p.size });
      }

      // For music uploads, create one lookup_id background job for the batch
      // and link all ingest rows to it. Done after inserts so a DB error above
      // can't leave a background job with no ingest rows attached.
      if (category === 'music') {
        const lookupJobId = await createJob(
          'lookup_id',
          `Auto lookup — ${ingestJobIds.length} track${ingestJobIds.length !== 1 ? 's' : ''}`,
          ingestJobIds.length,
        );
        await db.update(ingestJobs)
          .set({ lookup_job_id: lookupJobId })
          .where(inArray(ingestJobs.id, ingestJobIds));
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

  const VALID_MOODS = new Set(['happy', 'sad', 'aggressive', 'relaxed', 'party', 'acoustic', 'electronic']);

  function buildBaseFilters(params: { q?: string; category?: string; favorite?: string }): SQL<unknown>[] {
    const filters: SQL<unknown>[] = [];
    const { q, category, favorite } = params;
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
    return filters;
  }

  function buildFacetFilters(params: {
    genre?: string;
    artist?: string;
    decade?: string;
    dur_bucket?: string;
    energy_bucket?: string;
    identified?: string;
    bpm_min?: string;
    bpm_max?: string;
    mood?: string;
    key?: string;
  }): SQL<unknown>[] {
    const filters: SQL<unknown>[] = [];
    const { genre, artist, decade, dur_bucket, energy_bucket, identified, bpm_min, bpm_max, mood, key } = params;

    if (genre) {
      const genres = genre.split(',').map((g) => g.trim()).filter(Boolean);
      if (genres.length === 1) filters.push(eq(media.genre, genres[0]));
      else if (genres.length > 1) filters.push(inArray(media.genre, genres));
    }
    if (artist) {
      const artists = artist.split(',').map((a) => a.trim()).filter(Boolean);
      if (artists.length === 1) filters.push(eq(media.artist, artists[0]));
      else if (artists.length > 1) filters.push(inArray(media.artist, artists));
    }
    if (decade) {
      const decades = decade.split(',').map((d) => parseInt(d.trim(), 10)).filter((d) => !isNaN(d));
      if (decades.length > 0) {
        const conds = decades.map((d) => sql`(${media.year} >= ${d} AND ${media.year} < ${d + 10})`);
        filters.push(conds.length === 1 ? conds[0] : or(...conds)!);
      }
    }
    if (dur_bucket) {
      const buckets = dur_bucket.split(',').map((b) => b.trim());
      const conds: SQL<unknown>[] = [];
      if (buckets.includes('short'))  conds.push(sql`${media.duration_seconds} < 120`);
      if (buckets.includes('medium')) conds.push(sql`(${media.duration_seconds} >= 120 AND ${media.duration_seconds} < 300)`);
      if (buckets.includes('long'))   conds.push(sql`${media.duration_seconds} >= 300`);
      if (conds.length > 0) filters.push(conds.length === 1 ? conds[0] : or(...conds)!);
    }
    if (identified === 'yes')  filters.push(sql`${media.title} IS NOT NULL`);
    if (identified === 'no')   filters.push(sql`${media.title} IS NULL`);
    if (bpm_min) {
      const v = parseFloat(bpm_min);
      if (!isNaN(v)) filters.push(sql`${media.bpm} >= ${v}`);
    }
    if (bpm_max) {
      const v = parseFloat(bpm_max);
      if (!isNaN(v)) filters.push(sql`${media.bpm} <= ${v}`);
    }
    if (mood) {
      const moods = mood.split(',').map((m) => m.trim()).filter((m) => VALID_MOODS.has(m));
      if (moods.length > 0) {
        const conds = moods.map((m) =>
          sql`EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value, '$.tag') = ${m} AND json_extract(value, '$.score') >= 0.4)`
        );
        filters.push(conds.length === 1 ? conds[0] : or(...conds)!);
      }
    }
    if (key) {
      const keys = key.split(',').map((k) => k.trim()).filter(Boolean);
      if (keys.length === 1) filters.push(eq(media.musical_key, keys[0]));
      else if (keys.length > 1) filters.push(inArray(media.musical_key, keys));
    }
    if (energy_bucket) {
      const buckets = energy_bucket.split(',').map((b) => b.trim());
      const conds: SQL<unknown>[] = [];
      if (buckets.includes('low'))    conds.push(sql`${media.energy} < 0.3`);
      if (buckets.includes('medium')) conds.push(sql`(${media.energy} >= 0.3 AND ${media.energy} < 0.7)`);
      if (buckets.includes('high'))   conds.push(sql`${media.energy} >= 0.7`);
      if (conds.length > 0) filters.push(conds.length === 1 ? conds[0] : or(...conds)!);
    }
    return filters;
  }

  fastify.get<{
    Querystring: {
      q?: string;
      category?: string;
      favorite?: string;
      sort?: string;
      order?: string;
      limit?: string;
      offset?: string;
      genre?: string;
      artist?: string;
      decade?: string;
      dur_bucket?: string;
      energy_bucket?: string;
      identified?: string;
      bpm_min?: string;
      bpm_max?: string;
      mood?: string;
      key?: string;
    };
  }>('/library', async (request, reply) => {
    const { q, category, favorite, sort, order, limit, offset,
            genre, artist, decade, dur_bucket, energy_bucket, identified, bpm_min, bpm_max, mood, key } = request.query;

    const filters = [
      ...buildBaseFilters({ q, category, favorite }),
      ...buildFacetFilters({ genre, artist, decade, dur_bucket, energy_bucket, identified, bpm_min, bpm_max, mood, key }),
    ];
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

  fastify.get<{
    Querystring: { q?: string; category?: string; favorite?: string };
  }>('/library/facets', async (request, reply) => {
    const baseFilters = buildBaseFilters(request.query);
    const wc = baseFilters.length > 0 ? and(...baseFilters) : undefined;

    const [genreRows, artistRows, yearRows, durRows, identRows, keyRows, moodRows, bpmRows, energyRows] =
      await Promise.all([
        db.select({ value: media.genre, count: count() })
          .from(media)
          .where(and(wc, sql`${media.genre} IS NOT NULL`))
          .groupBy(media.genre)
          .orderBy(sql`count(*) DESC`)
          .limit(100),

        db.select({ value: media.artist, count: count() })
          .from(media)
          .where(and(wc, sql`${media.artist} IS NOT NULL`))
          .groupBy(media.artist)
          .orderBy(sql`count(*) DESC`)
          .limit(50),

        db.select({ year: media.year, count: count() })
          .from(media)
          .where(and(wc, sql`${media.year} IS NOT NULL`))
          .groupBy(media.year),

        db.select({
          short:  sql<number>`SUM(CASE WHEN ${media.duration_seconds} < 120 THEN 1 ELSE 0 END)`,
          medium: sql<number>`SUM(CASE WHEN ${media.duration_seconds} >= 120 AND ${media.duration_seconds} < 300 THEN 1 ELSE 0 END)`,
          long:   sql<number>`SUM(CASE WHEN ${media.duration_seconds} >= 300 THEN 1 ELSE 0 END)`,
        }).from(media).where(wc),

        db.select({
          yes: sql<number>`SUM(CASE WHEN ${media.title} IS NOT NULL THEN 1 ELSE 0 END)`,
          no:  sql<number>`SUM(CASE WHEN ${media.title} IS NULL THEN 1 ELSE 0 END)`,
        }).from(media).where(wc),

        db.select({ value: media.musical_key, count: count() })
          .from(media)
          .where(and(wc, sql`${media.musical_key} IS NOT NULL`))
          .groupBy(media.musical_key)
          .orderBy(sql`count(*) DESC`),

        db.select({
          happy:      sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='happy'      AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          sad:        sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='sad'        AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          aggressive: sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='aggressive' AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          relaxed:    sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='relaxed'    AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          party:      sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='party'      AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          acoustic:   sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='acoustic'   AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
          electronic: sql<number>`SUM(CASE WHEN EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value,'$.tag')='electronic' AND json_extract(value,'$.score')>=0.4) THEN 1 ELSE 0 END)`,
        }).from(media).where(wc),

        db.select({
          min: sql<number | null>`MIN(${media.bpm})`,
          max: sql<number | null>`MAX(${media.bpm})`,
        }).from(media).where(and(wc, sql`${media.bpm} IS NOT NULL`)),

        db.select({
          low:    sql<number>`SUM(CASE WHEN ${media.energy} < 0.3 THEN 1 ELSE 0 END)`,
          medium: sql<number>`SUM(CASE WHEN ${media.energy} >= 0.3 AND ${media.energy} < 0.7 THEN 1 ELSE 0 END)`,
          high:   sql<number>`SUM(CASE WHEN ${media.energy} >= 0.7 THEN 1 ELSE 0 END)`,
        }).from(media).where(and(wc, sql`${media.energy} IS NOT NULL`)),
      ]);

    // Group years by decade in JS
    const decadeMap = new Map<number, number>();
    for (const r of yearRows) {
      if (r.year == null) continue;
      const decade = Math.floor(r.year / 10) * 10;
      decadeMap.set(decade, (decadeMap.get(decade) ?? 0) + r.count);
    }
    const decades = [...decadeMap.entries()]
      .sort(([a], [b]) => b - a)
      .map(([value, cnt]) => ({ value, label: `${value}s`, count: cnt }));

    const dur = durRows[0] ?? { short: 0, medium: 0, long: 0 };
    const ident = identRows[0] ?? { yes: 0, no: 0 };
    const mood = moodRows[0] as Record<string, number> | undefined ?? {};
    const bpm = bpmRows[0] ?? { min: null, max: null };
    const energy = energyRows[0] ?? { low: 0, medium: 0, high: 0 };

    const MOOD_KEYS = ['happy', 'sad', 'aggressive', 'relaxed', 'party', 'acoustic', 'electronic'];
    const moods = MOOD_KEYS
      .map((k) => ({ value: k, count: mood[k] ?? 0 }))
      .sort((a, b) => b.count - a.count);

    return reply.send({
      genres:           genreRows.map((r) => ({ value: r.value!, count: r.count })),
      artists:          artistRows.map((r) => ({ value: r.value!, count: r.count })),
      decades,
      duration_buckets: [
        { value: 'short',  label: '< 2 min', count: dur.short  ?? 0 },
        { value: 'medium', label: '2–5 min', count: dur.medium ?? 0 },
        { value: 'long',   label: '> 5 min', count: dur.long   ?? 0 },
      ].filter((b) => b.count > 0),
      identified: { yes: ident.yes ?? 0, no: ident.no ?? 0 },
      keys:    keyRows.map((r) => ({ value: r.value!, count: r.count })),
      moods,
      bpm_range: { min: bpm.min ?? null, max: bpm.max ?? null },
      energy_buckets: [
        { value: 'low',    label: 'Low (< 30%)',    count: energy.low    ?? 0 },
        { value: 'medium', label: 'Medium (30–70%)', count: energy.medium ?? 0 },
        { value: 'high',   label: 'High (> 70%)',    count: energy.high   ?? 0 },
      ],
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

  fastify.post<{ Params: { id: string } }>('/library/:id/acoustid', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    try {
      const candidates = await identifyMedia(id);
      return reply.send({ candidates, auto_apply: isAutoApply(candidates) });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{ Params: { id: string } }>('/library/:id/analyse', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: 'Invalid id' });
    // Fire-and-forget — returns 202 immediately; client polls analysis_status on the media row.
    analyseMedia(id).catch(() => undefined);
    return reply.status(202).send({ queued: true });
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

  fastify.post<{ Body: unknown }>('/library/bulk-acoustid', async (request, reply) => {
    const parsed = BulkIdsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const ids = parsed.data.ids;
    await supersedePendingReviews(ids);
    const jobId = await createJob('lookup_id', `Lookup ID — ${ids.length} track${ids.length !== 1 ? 's' : ''}`, ids.length);
    runBulkLookupId(jobId, ids).catch(() => undefined);
    return reply.status(202).send({ job_id: jobId });
  });

  fastify.post<{ Body: unknown }>('/library/bulk-analyse', async (request, reply) => {
    const parsed = BulkIdsSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const ids = parsed.data.ids;
    const jobId = await createJob('analyse', `Audio analysis — ${ids.length} track${ids.length !== 1 ? 's' : ''}`, ids.length);
    runBulkAnalyse(jobId, ids).catch(() => undefined);
    return reply.status(202).send({ job_id: jobId });
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

  fastify.delete<{ Querystring: { status: string } }>('/library/ingest', async (request, reply) => {
    const { status } = request.query;
    if (status !== 'completed' && status !== 'failed') {
      return reply.status(400).send({ error: 'status must be completed or failed' });
    }
    await db.delete(ingestJobs).where(eq(ingestJobs.status, status as 'completed' | 'failed'));
    return reply.status(204).send();
  });
}

async function runBulkLookupId(jobId: string, ids: number[]): Promise<void> {
  const results: LookupIdResults = { applied: [], skipped: [], failed: [] };
  try {
    const mediaRows = await db
      .select({ id: media.id, original_filename: media.original_filename })
      .from(media)
      .where(inArrayOp(media.id, ids));
    const filenameMap = new Map(mediaRows.map((r) => [r.id, r.original_filename]));

    for (const mediaId of ids) {
      const filename = filenameMap.get(mediaId) ?? `#${mediaId}`;
      try {
        const candidates = await identifyMedia(mediaId);
        if (candidates.length === 0 || !isAutoApply(candidates, { allowMusicBrainz: true })) {
          let reason: string;
          if (candidates.length === 0) {
            reason = 'No matches found';
          } else if (candidates[0].source === 'filename') {
            reason = 'Cover detected — not in MusicBrainz. Use per-track Lookup ID to apply.';
          } else if (candidates[0].source === 'musicbrainz' && candidates[0].fromFreeText) {
            reason = 'Loose text match only — cannot auto-apply. Use per-track Lookup ID to verify.';
          } else if (candidates[0].source === 'musicbrainz') {
            reason = `Filename search — low confidence (${Math.round(candidates[0].score * 100)}%). Use per-track Lookup ID to pick manually.`;
          } else {
            reason = `Low confidence (${Math.round(candidates[0].score * 100)}%)`;
          }
          results.skipped.push({
            id: mediaId,
            filename,
            reason,
            candidates: candidates.map((c) => ({
              acoustid: c.acoustid,
              score: c.score,
              title: c.title,
              artist: c.artist,
              album: c.album,
              year: c.year,
              source: c.source,
              fromFreeText: c.fromFreeText,
            })),
            resolved: false,
          });
        } else {
          const top = candidates[0];
          await db
            .update(media)
            .set({
              title: top.title,
              artist: top.artist,
              album: top.album,
              year: top.year,
              notes: sql`COALESCE(${media.notes}, ${media.original_filename})`,
              updated_at: new Date(),
            })
            .where(eq(media.id, mediaId));
          results.applied.push({
            id: mediaId,
            filename,
            title: top.title,
            artist: top.artist,
            album: top.album,
            year: top.year,
            score: top.score,
          });
        }
      } catch (err) {
        results.failed.push({ id: mediaId, filename, error: (err as Error).message });
      }
    }
    await completeLookupIdJob(jobId, results);
  } catch (err) {
    await failJob(jobId, (err as Error).message);
  }
}

async function runBulkAnalyse(jobId: string, ids: number[]): Promise<void> {
  const results: AnalyseResults = { succeeded: [], failed: [] };
  try {
    const mediaRows = await db
      .select({ id: media.id, original_filename: media.original_filename })
      .from(media)
      .where(inArrayOp(media.id, ids));
    const filenameMap = new Map(mediaRows.map((r) => [r.id, r.original_filename]));

    for (const mediaId of ids) {
      const filename = filenameMap.get(mediaId) ?? `#${mediaId}`;
      try {
        await analyseMedia(mediaId);
        results.succeeded.push({ id: mediaId, filename });
      } catch (err) {
        results.failed.push({ id: mediaId, filename, error: (err as Error).message });
      }
    }
    await completeAnalyseJob(jobId, results);
  } catch (err) {
    await failJob(jobId, (err as Error).message);
  }
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
