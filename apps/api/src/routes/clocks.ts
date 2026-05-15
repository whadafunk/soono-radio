import { FastifyInstance } from 'fastify';
import { eq, asc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ClockCreateSchema, ClockPatchSchema, ClockSegmentCreateSchema } from '@radio/shared';
import { db } from '../db/index.js';
import { clocks, clockSegments, calendarEntries, templateEntries, templateClockEntries } from '../db/schema.js';

// `used` = clock is referenced by any calendar / template / template_clock entry.
// Computed as a correlated subquery so it survives the GROUP BY on clock_segments.
const usedExpr = sql<number>`(
  SELECT
    (SELECT COUNT(*) FROM ${calendarEntries} WHERE ${calendarEntries.clock_id} = ${clocks.id}) +
    (SELECT COUNT(*) FROM ${templateEntries} WHERE ${templateEntries.clock_id} = ${clocks.id}) +
    (SELECT COUNT(*) FROM ${templateClockEntries} WHERE ${templateClockEntries.clock_id} = ${clocks.id})
)`;

export async function clockRoutes(fastify: FastifyInstance) {
  fastify.get('/clocks', async (_req, reply) => {
    const rows = await db
      .select({
        id: clocks.id,
        name: clocks.name,
        description: clocks.description,
        show_id: clocks.show_id,
        station_id_playlist_id: clocks.station_id_playlist_id,
        jingle_playlist_id: clocks.jingle_playlist_id,
        finish_policy: clocks.finish_policy,
        join_policy: clocks.join_policy,
        overrun_policy: clocks.overrun_policy,
        duration_seconds: sql<number>`COALESCE(SUM(${clockSegments.duration_seconds}), 0)`,
        used_count: usedExpr,
        created_at: clocks.created_at,
        updated_at: clocks.updated_at,
      })
      .from(clocks)
      .leftJoin(clockSegments, eq(clockSegments.clock_id, clocks.id))
      .groupBy(clocks.id)
      .orderBy(asc(clocks.name));
    return reply.send(rows.map(({ used_count, ...c }) => ({ ...c, used: used_count > 0, slot_count: used_count })));
  });

  fastify.post<{ Body: unknown }>('/clocks', async (request, reply) => {
    const parsed = ClockCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ errors: parsed.error.errors });
    const [clock] = await db.insert(clocks).values({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      show_id: parsed.data.show_id ?? null,
      station_id_playlist_id: parsed.data.station_id_playlist_id ?? null,
      jingle_playlist_id: parsed.data.jingle_playlist_id ?? null,
      ...(parsed.data.finish_policy && { finish_policy: parsed.data.finish_policy }),
      ...(parsed.data.join_policy && { join_policy: parsed.data.join_policy }),
      ...(parsed.data.overrun_policy && { overrun_policy: parsed.data.overrun_policy }),
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
        show_id: clocks.show_id,
        station_id_playlist_id: clocks.station_id_playlist_id,
        jingle_playlist_id: clocks.jingle_playlist_id,
        finish_policy: clocks.finish_policy,
        join_policy: clocks.join_policy,
        overrun_policy: clocks.overrun_policy,
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
    const { used_count, ...rest } = clock;
    return reply.send({ ...rest, used: used_count > 0 });
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
    // clockSegments has a cascading FK; delete it first.
    // Calendar/template entries have no FK on clock_id, so their stale clock_id
    // is preserved for orphaned-slot detection in the UI.
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

    // Unassigned clocks (no show context at runtime) must back every music
    // segment with at least one specific `playlist` source — otherwise nothing
    // will play. See docs/clocks-rotations-redesign.md §2.
    if (clock.show_id === null) {
      const offending = parsed.data
        .map((s, i) => ({ s, i }))
        .filter(({ s }) =>
          s.type === 'music' &&
          !(s.sources ?? []).some((src) => src.type === 'playlist'),
        );
      if (offending.length > 0) {
        return reply.status(400).send({
          error: 'Unassigned clocks require at least one playlist source on every music segment',
          segment_indexes: offending.map(({ i }) => i),
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
          interstitial_jingle_playlist_id: s.interstitial_jingle_playlist_id ?? null,
          jingle_every_n_tracks: s.jingle_every_n_tracks ?? null,
          start_policy: s.start_policy ?? { type: 'soft', plus_seconds: 30, minus_seconds: 0 },
          trailing_time: s.trailing_time ?? [],
          recovery_tactics: s.recovery_tactics ?? [],
          accept_live: s.accept_live ?? true,
          accept_sweepers: s.accept_sweepers ?? [],
          sweeper_config: s.sweeper_config ?? null,
          silence_detection_action: s.silence_detection_action ?? null,
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
