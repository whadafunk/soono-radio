import { FastifyInstance } from 'fastify';
import { eq, asc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ClockCreateSchema, ClockPatchSchema, ClockSegmentCreateSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { clocks, clockSegments, calendarEntries, templateEntries, templateClockEntries, shows } from '../db/schema.js';

// slot_count = all template weekly entries + per-hour grid slots + individual calendar overrides
const usedExpr = sql<number>`(
  SELECT
    (SELECT COUNT(*) FROM ${templateEntries} WHERE ${templateEntries.clock_id} = ${clocks.id}) +
    (SELECT COUNT(*) FROM ${templateClockEntries} WHERE ${templateClockEntries.clock_id} = ${clocks.id}) +
    (SELECT COUNT(*) FROM ${calendarEntries} WHERE ${calendarEntries.clock_id} = ${clocks.id})
)`;

export async function clockRoutes(fastify: FastifyInstance) {
  fastify.get('/clocks', async (_req, reply) => {
    const rows = await db
      .select({
        id: clocks.id,
        name: clocks.name,
        description: clocks.description,
        station_id_playlist_id: clocks.station_id_playlist_id,
        jingle_playlist_id: clocks.jingle_playlist_id,
        join_policy: clocks.join_policy,
        duration_seconds: sql<number>`COALESCE(SUM(${clockSegments.duration_seconds}), 0)`,
        used_count: usedExpr,
        created_at: clocks.created_at,
        updated_at: clocks.updated_at,
      })
      .from(clocks)
      .leftJoin(clockSegments, eq(clockSegments.clock_id, clocks.id))
      .groupBy(clocks.id)
      .orderBy(asc(clocks.name));

    const clockIds = rows.map((r) => r.id);
    const assignedShowRows = clockIds.length > 0
      ? await db.select({ id: shows.id, name: shows.name, clock_id: shows.default_clock_id, jingle_playlist_id: shows.jingle_playlist_id })
          .from(shows).where(inArray(shows.default_clock_id, clockIds))
      : [];
    const showsByClockId = new Map<number, { id: number; name: string; jingle_playlist_id: number | null }[]>();
    for (const s of assignedShowRows) {
      if (s.clock_id == null) continue;
      const list = showsByClockId.get(s.clock_id) ?? [];
      list.push({ id: s.id, name: s.name, jingle_playlist_id: s.jingle_playlist_id });
      showsByClockId.set(s.clock_id, list);
    }

    return reply.send(rows.map(({ used_count, ...c }) => ({
      ...c,
      used: used_count > 0,
      slot_count: used_count,
      assigned_shows: showsByClockId.get(c.id) ?? [],
    })));
  });

  fastify.post<{ Body: unknown }>('/clocks', async (request, reply) => {
    const parsed = ClockCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [clock] = await db.insert(clocks).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      station_id_playlist_id: parsed.data.station_id_playlist_id ?? null,
      jingle_playlist_id: parsed.data.jingle_playlist_id ?? null,
      ...(parsed.data.join_policy && { join_policy: parsed.data.join_policy }),
    }).returning();
    return reply.status(201).send(clock);
  });

  fastify.get<{ Params: { id: string } }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [clock] = await db
      .select({
        id: clocks.id,
        name: clocks.name,
        description: clocks.description,
        station_id_playlist_id: clocks.station_id_playlist_id,
        jingle_playlist_id: clocks.jingle_playlist_id,
        join_policy: clocks.join_policy,
        duration_seconds: sql<number>`COALESCE(SUM(${clockSegments.duration_seconds}), 0)`,
        used_count: usedExpr,
        created_at: clocks.created_at,
        updated_at: clocks.updated_at,
      })
      .from(clocks)
      .leftJoin(clockSegments, eq(clockSegments.clock_id, clocks.id))
      .where(eq(clocks.id, id))
      .groupBy(clocks.id);
    if (!clock) return reply.status(404).send({ error: 'Clock not found' });
    const assignedShowRows = await db
      .select({ id: shows.id, name: shows.name, jingle_playlist_id: shows.jingle_playlist_id })
      .from(shows).where(eq(shows.default_clock_id, id));
    const { used_count, ...rest } = clock;
    return reply.send({ ...rest, used: used_count > 0, slot_count: used_count, assigned_shows: assignedShowRows });
  });

  fastify.patch<{ Params: { id: string }; Body: unknown }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const parsed = ClockPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [updated] = await db.update(clocks)
      .set({ ...parsed.data, updated_at: sql`(unixepoch())` })
      .where(eq(clocks.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Clock not found' });
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/clocks/:id', async (request, reply) => {
    const id = Number(request.params.id);

    const assignedShows = await db
      .select({ id: shows.id, name: shows.name })
      .from(shows).where(eq(shows.default_clock_id, id));
    if (assignedShows.length > 0) {
      return reply.status(409).send({
        error: 'Clock is assigned to shows. Remove assignment from those shows first.',
        assigned_shows: assignedShows,
      });
    }

    const [clock] = await db.select({ name: clocks.name }).from(clocks).where(eq(clocks.id, id));
    if (clock) {
      await db.update(templateEntries).set({ orphaned_clock_name: clock.name }).where(eq(templateEntries.clock_id, id));
      await db.update(calendarEntries).set({ orphaned_clock_name: clock.name }).where(eq(calendarEntries.clock_id, id));
    }
    await db.delete(clockSegments).where(eq(clockSegments.clock_id, id));
    await db.delete(clocks).where(eq(clocks.id, id));
    return reply.status(204).send();
  });

  fastify.get<{ Params: { id: string } }>('/clocks/:id/segments', async (request, reply) => {
    const id = Number(request.params.id);
    const rows = await db.select().from(clockSegments)
      .where(eq(clockSegments.clock_id, id))
      .orderBy(asc(clockSegments.sort_order));
    return reply.send(rows);
  });

  fastify.put<{ Params: { id: string }; Body: unknown }>('/clocks/:id/segments', async (request, reply) => {
    const id = Number(request.params.id);
    const [clock] = await db.select().from(clocks).where(eq(clocks.id, id));
    if (!clock) return reply.status(404).send({ error: 'Clock not found' });

    const parsed = z.array(ClockSegmentCreateSchema).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });

    // Structure lock: when a clock is actually scheduled (calendar / template),
    // its segment count, order, types, and durations are frozen — only internal
    // config changes are allowed.  Show assignment alone does NOT lock structure;
    // it is a design-time hint, not a scheduling commitment.
    const [lockRow] = await db.select({
      usageCount: sql<number>`(
        (SELECT COUNT(*) FROM ${calendarEntries}      WHERE ${calendarEntries.clock_id}      = ${id}) +
        (SELECT COUNT(*) FROM ${templateEntries}      WHERE ${templateEntries.clock_id}      = ${id}) +
        (SELECT COUNT(*) FROM ${templateClockEntries} WHERE ${templateClockEntries.clock_id} = ${id})
      )`,
    }).from(clocks).where(eq(clocks.id, id));

    if (lockRow.usageCount > 0) {
      const existing = await db.select().from(clockSegments)
        .where(eq(clockSegments.clock_id, id)).orderBy(asc(clockSegments.sort_order));
      const incoming = parsed.data;
      if (existing.length !== incoming.length) {
        return reply.status(409).send({
          error: 'Clock structure is locked — cannot add or remove segments while the clock is scheduled.',
        });
      }
      for (let i = 0; i < existing.length; i++) {
        if (existing[i].type !== incoming[i].type || existing[i].duration_seconds !== incoming[i].duration_seconds) {
          return reply.status(409).send({
            error: `Clock structure is locked — segment ${i + 1} type or duration cannot change while the clock is scheduled.`,
          });
        }
      }
    }

    const [{ assignedCount }] = await db
      .select({ assignedCount: sql<number>`COUNT(*)` })
      .from(shows).where(eq(shows.default_clock_id, id));
    if (assignedCount === 0) {
      const showModeOffenders = parsed.data
        .map((s, i) => ({ s, i }))
        .filter(({ s }) =>
          s.type === 'music' &&
          (s.sources ?? []).some((src) => src.type === 'show_playlist'),
        );
      if (showModeOffenders.length > 0) {
        return reply.status(400).send({
          error: 'Show Playlist mode requires the clock to be assigned to a show',
          segment_indexes: showModeOffenders.map(({ i }) => i),
        });
      }
    }

    await db.delete(clockSegments).where(eq(clockSegments.clock_id, id));
    if (parsed.data.length > 0) {
      await db.insert(clockSegments).values(
        parsed.data.map((s, i) => ({
          clock_id: id,
          sort_order: i,
          name: s.name,
          type: s.type,
          duration_seconds: s.duration_seconds,
          sources: s.sources ?? [],
          filler_playlist_id: s.filler_playlist_id ?? null,
          start_clip_playlist_id: s.start_clip_playlist_id ?? null,
          end_clip_playlist_id: s.end_clip_playlist_id ?? null,
          bed_playlist_id: s.bed_playlist_id ?? null,
          interstitial_jingles_enabled: s.interstitial_jingles_enabled ?? false,
          jingle_every_n_tracks: s.jingle_every_n_tracks ?? null,
          interstitial_station_id_enabled: s.interstitial_station_id_enabled ?? false,
          station_id_every_n_tracks: s.station_id_every_n_tracks ?? null,
          start_policy: s.start_policy ?? { type: 'flexible', late_seconds: null, early_seconds: 0 },
          can_skip: s.can_skip ?? false,
          can_fill: s.can_fill ?? false,
          can_reschedule: s.can_reschedule ?? false,
          catching_up_order: s.catching_up_order ?? [],
          coasting_order: s.coasting_order ?? [],
          accept_live: s.accept_live ?? true,
          accept_sweepers: s.accept_sweepers ?? [],
          sweeper_config: s.sweeper_config ?? null,
          silence_threshold_seconds: s.silence_threshold_seconds ?? null,
          rotation_type: s.rotation_type ?? null,
        })),
      );
    }

    const rows = await db.select().from(clockSegments)
      .where(eq(clockSegments.clock_id, id))
      .orderBy(asc(clockSegments.sort_order));
    return reply.send(rows);
  });
}
