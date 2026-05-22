import { FastifyInstance } from 'fastify';
import { eq, ne, asc, inArray, and, or, like, gte, lte, between, sql, SQL, isNull, getTableColumns } from 'drizzle-orm';
import {
  PlaylistCreateSchema,
  PlaylistPatchSchema,
  PlaylistMediaAddSchema,
  PlaylistMediaBulkAddSchema,
  PlaylistTracksReorderSchema,
  DynamicRulesSchema,
  MediaTagsUpdateSchema,
  PLAYLIST_DEFAULT_TYPES,
  playlistMediaCategory,
  type DynamicRuleCondition,
  type DynamicRules,
  type PlaylistType,
  type PlaylistSubcategory,
} from '@radio/shared';
import { db } from '../db/index.js';
import { playlists, playlistMedia, media, mediaTags, MEDIA_CATEGORIES, shows, rotations, clocks, musicCampaigns } from '../db/schema.js';

const DEFAULT_ELIGIBLE = new Set<PlaylistType>(PLAYLIST_DEFAULT_TYPES);

// ── Dynamic rule → SQL ────────────────────────────────────────────────────────

function conditionToSQL(cond: DynamicRuleCondition): SQL | null {
  const { field, op, value } = cond;

  if (field === 'tags') {
    const tags = Array.isArray(value) ? (value as string[]) : [String(value)];
    if (op === 'any_of') {
      return sql`EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = ${media.id} AND mt.tag IN (${sql.join(tags.map((t) => sql`${t}`), sql`, `)}))`;
    }
    if (op === 'all_of') {
      return sql`(SELECT COUNT(*) FROM media_tags mt WHERE mt.media_id = ${media.id} AND mt.tag IN (${sql.join(tags.map((t) => sql`${t}`), sql`, `)})) = ${tags.length}`;
    }
    return null;
  }

  if (field === 'mood') {
    if (op !== 'any_of') return null;
    const moodVal = value as { moods?: string[]; min_score?: number };
    const moods = Array.isArray(moodVal?.moods) ? moodVal.moods : [];
    const threshold = typeof moodVal?.min_score === 'number' ? moodVal.min_score : 0.5;
    if (moods.length === 0) return null;
    const clauses = moods.map((m) =>
      sql`EXISTS (SELECT 1 FROM json_each(${media.mood_tags}) WHERE json_extract(value, '$.tag') = ${m} AND json_extract(value, '$.score') >= ${threshold})`
    );
    return clauses.length === 1 ? clauses[0] : or(...clauses)!;
  }

  if (field === 'energy_level' || field === 'danceability_level') {
    if (op !== 'any_of') return null;
    const col = field === 'energy_level' ? media.energy : media.danceability;
    const levels = Array.isArray(value) ? (value as string[]) : [String(value)];
    const clauses = levels.flatMap((level): SQL[] => {
      if (level === 'low')    return [sql`${col} < 0.3`];
      if (level === 'medium') return [sql`(${col} >= 0.3 AND ${col} < 0.7)`];
      if (level === 'high')   return [sql`${col} >= 0.7`];
      return [];
    });
    if (clauses.length === 0) return null;
    return clauses.length === 1 ? clauses[0] : or(...clauses)!;
  }

  const col = (() => {
    switch (field) {
      case 'genre':            return media.genre;
      case 'artist':           return media.artist;
      case 'album':            return media.album;
      case 'year':             return media.year;
      case 'duration_seconds': return media.duration_seconds;
      case 'bpm':              return media.bpm;
      default: return null;
    }
  })();
  if (!col) return null;

  switch (op) {
    case 'eq':       return eq(col, value as string | number);
    case 'contains': return like(col, `%${value}%`);
    case 'in':       return inArray(col, Array.isArray(value) ? value as string[] : [value as string]);
    case 'gte':      return gte(col, value as number);
    case 'lte':      return lte(col, value as number);
    case 'between': {
      const [lo, hi] = value as [number, number];
      return between(col, lo, hi);
    }
    default: return null;
  }
}

function rulesToWhere(rules: DynamicRules): SQL | undefined {
  const clauses = rules.conditions
    .map(conditionToSQL)
    .filter((c): c is SQL => c !== null);
  if (clauses.length === 0) return undefined;
  return rules.match === 'all' ? and(...clauses) : or(...clauses);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function playlistRoutes(fastify: FastifyInstance) {

  // ── Playlist CRUD ──────────────────────────────────────────────────────────

  fastify.get('/playlists', async (_req, reply) => {
    const rows = await db
      .select({
        ...getTableColumns(playlists),
        total_seconds: sql<number>`COALESCE(SUM(${media.duration_seconds}), 0)`,
      })
      .from(playlists)
      .leftJoin(playlistMedia, eq(playlistMedia.playlist_id, playlists.id))
      .leftJoin(media, eq(media.id, playlistMedia.media_id))
      .groupBy(playlists.id)
      .orderBy(asc(playlists.name));
    return reply.send(rows);
  });

  fastify.post<{ Body: unknown }>('/playlists', async (request, reply) => {
    const parsed = PlaylistCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const { name, description, type, subcategory, kind, rules, is_default } = parsed.data;
    if (is_default && DEFAULT_ELIGIBLE.has(type)) {
      const subWhere = subcategory != null ? eq(playlists.subcategory, subcategory) : isNull(playlists.subcategory);
      await db.update(playlists).set({ is_default: false })
        .where(and(eq(playlists.type, type), subWhere));
    }
    const [row] = await db.insert(playlists).values({
      name,
      description: description ?? null,
      type,
      subcategory: subcategory ?? null,
      kind,
      rules: kind === 'dynamic' ? (rules ?? { match: 'all', conditions: [] }) : null,
      is_default: is_default && DEFAULT_ELIGIBLE.has(type) ? true : false,
    }).returning();
    return reply.status(201).send(row);
  });

  fastify.get<{ Params: { id: string } }>('/playlists/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [playlist] = await db.select().from(playlists).where(eq(playlists.id, id));
    if (!playlist) return reply.status(404).send({ error: 'Playlist not found' });
    return reply.send(playlist);
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/playlists/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = PlaylistPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const patch = { ...parsed.data };
    if (patch.is_default) {
      const [existing] = await db.select({ type: playlists.type, subcategory: playlists.subcategory }).from(playlists).where(eq(playlists.id, id));
      if (!existing) return reply.status(404).send({ error: 'Playlist not found' });
      if (DEFAULT_ELIGIBLE.has(existing.type)) {
        const subWhere2 = existing.subcategory != null ? eq(playlists.subcategory, existing.subcategory) : isNull(playlists.subcategory);
        await db.update(playlists).set({ is_default: false })
          .where(and(eq(playlists.type, existing.type), subWhere2, ne(playlists.id, id)));
      } else {
        patch.is_default = false;
      }
    }
    const [updated] = await db.update(playlists)
      .set({ ...patch, updated_at: sql`(unixepoch())` })
      .where(eq(playlists.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Playlist not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/playlists/:id', async (request, reply) => {
    const id = Number(request.params.id);

    // Check music_campaigns first — RESTRICT FK means we must error explicitly
    const campaignRef = await db.select({ id: musicCampaigns.id })
      .from(musicCampaigns).where(eq(musicCampaigns.playlist_id, id)).limit(1);
    if (campaignRef.length > 0) {
      return reply.status(409).send({ error: 'Playlist is referenced by an active music campaign and cannot be deleted.' });
    }

    // Null out soft FK references that lack ON DELETE CASCADE/SET NULL in the DB
    await db.update(shows).set({ jingle_playlist_id: null }).where(eq(shows.jingle_playlist_id, id));
    await db.update(shows).set({ bed_playlist_id: null }).where(eq(shows.bed_playlist_id, id));
    await db.update(rotations).set({ hot_play_playlist_id: null }).where(eq(rotations.hot_play_playlist_id, id));
    await db.update(clocks).set({ station_id_playlist_id: null }).where(eq(clocks.station_id_playlist_id, id));
    await db.update(clocks).set({ jingle_playlist_id: null }).where(eq(clocks.jingle_playlist_id, id));

    await db.delete(playlists).where(eq(playlists.id, id));
    return reply.status(204).send();
  });

  // ── Static playlist tracks ─────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/playlists/:id/tracks', async (request, reply) => {
    const id = Number(request.params.id);
    const rows = await db
      .select({
        id: playlistMedia.id,
        playlist_id: playlistMedia.playlist_id,
        media_id: playlistMedia.media_id,
        sort_order: playlistMedia.sort_order,
        weight: playlistMedia.weight,
        title: media.title,
        artist: media.artist,
        duration_seconds: media.duration_seconds,
        category: media.category,
        original_filename: media.original_filename,
      })
      .from(playlistMedia)
      .innerJoin(media, eq(playlistMedia.media_id, media.id))
      .where(eq(playlistMedia.playlist_id, id))
      .orderBy(asc(playlistMedia.sort_order));
    return reply.send(rows);
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/playlists/:id/tracks', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = PlaylistMediaAddSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    // Place at end if no sort_order given
    const sort_order = parsed.data.sort_order ?? await (async () => {
      const rows = await db.select({ c: sql<number>`COUNT(*)` }).from(playlistMedia).where(eq(playlistMedia.playlist_id, id));
      return rows[0]?.c ?? 0;
    })();

    const [row] = await db.insert(playlistMedia).values({
      playlist_id: id,
      media_id: parsed.data.media_id,
      sort_order,
      weight: parsed.data.weight,
    }).returning();
    return reply.status(201).send(row);
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>('/playlists/:id/tracks/bulk', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = PlaylistMediaBulkAddSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    const rows = await db.transaction(async (tx) => {
      const [maxRow] = await tx
        .select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
        .from(playlistMedia)
        .where(eq(playlistMedia.playlist_id, id));
      const base = (maxRow?.max ?? -1) + 1;

      return tx.insert(playlistMedia).values(
        parsed.data.media_ids.map((mediaId: number, i: number) => ({
          playlist_id: id,
          media_id: mediaId,
          sort_order: base + i,
          weight: 1,
        })),
      ).onConflictDoNothing().returning();
    });

    return reply.status(201).send(rows);
  });

  fastify.delete<{ Params: { id: string; trackId: string } }>('/playlists/:id/tracks/:trackId', async (request, reply) => {
    const trackId = Number(request.params.trackId);
    await db.delete(playlistMedia).where(eq(playlistMedia.id, trackId));
    return reply.status(204).send();
  });

  // Full reorder: body is array of { id, sort_order }
  fastify.put<{ Params: { id: string }; Body: unknown }>('/playlists/:id/tracks/reorder', async (request, reply) => {
    const parsed = PlaylistTracksReorderSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    await Promise.all(
      parsed.data.map(({ id, sort_order }) =>
        db.update(playlistMedia).set({ sort_order }).where(eq(playlistMedia.id, id)),
      ),
    );
    return reply.status(204).send();
  });

  // ── Dynamic playlist preview ───────────────────────────────────────────────

  // Accepts draft rules in the body for live preview; falls back to saved rules.
  // Always adds an implicit category = playlist.type filter.
  fastify.post<{ Params: { id: string }; Querystring: { limit?: string }; Body: unknown }>('/playlists/:id/preview', async (request, reply) => {
    const id = Number(request.params.id);
    const [playlist] = await db.select().from(playlists).where(eq(playlists.id, id));
    if (!playlist) return reply.status(404).send({ error: 'Playlist not found' });
    if (playlist.kind !== 'dynamic') return reply.status(400).send({ error: 'Not a dynamic playlist' });

    const bodyHasRules = request.body != null && typeof request.body === 'object' && 'conditions' in (request.body as object);
    const parsed = DynamicRulesSchema.safeParse(
      bodyHasRules ? request.body : (playlist.rules ?? { match: 'all', conditions: [] }),
    );
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid rules' });

    const mediaCategory = playlistMediaCategory(
      playlist.type as PlaylistType,
      playlist.subcategory as PlaylistSubcategory | null,
    );
    const categoryWhere = eq(media.category, mediaCategory);
    const rulesWhere = rulesToWhere(parsed.data);
    const where = rulesWhere ? and(categoryWhere, rulesWhere) : categoryWhere;

    const [{ total }] = await db.select({ total: sql<number>`COUNT(*)` }).from(media).where(where);
    const limit = Math.min(Math.max(1, parseInt(request.query.limit ?? '') || 5), 500);
    const sample = await db
      .select({ id: media.id, title: media.title, artist: media.artist, duration_seconds: media.duration_seconds, category: media.category, original_filename: media.original_filename })
      .from(media)
      .where(where)
      .orderBy(limit > 5 ? asc(media.title) : sql`RANDOM()`)
      .limit(limit);

    return reply.send({ count: total, sample });
  });

  // ── Media tags ─────────────────────────────────────────────────────────────

  fastify.get<{ Params: { mediaId: string } }>('/media/:mediaId/tags', async (request, reply) => {
    const mediaId = Number(request.params.mediaId);
    const rows = await db.select({ tag: mediaTags.tag }).from(mediaTags).where(eq(mediaTags.media_id, mediaId));
    return reply.send(rows.map((r) => r.tag));
  });

  fastify.put<{ Params: { mediaId: string }; Body: unknown }>('/media/:mediaId/tags', async (request, reply) => {
    const mediaId = Number(request.params.mediaId);
    const parsed = MediaTagsUpdateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    await db.delete(mediaTags).where(eq(mediaTags.media_id, mediaId));
    if (parsed.data.tags.length > 0) {
      await db.insert(mediaTags).values(parsed.data.tags.map((tag) => ({ media_id: mediaId, tag })));
    }
    return reply.send(parsed.data.tags);
  });
}
