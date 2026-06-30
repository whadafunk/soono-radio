import { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  supervisorState,
  plans,
  planItems,
  media,
  stopSetEstimates,
  liveEvents,
  playHistory,
  clocks,
  clockSegments,
  shows,
} from '../db/schema.js';
import { resolveCurrentSegment } from '../services/supervisor2/clockResolver.js';

export async function supervisorStatusRoutes(fastify: FastifyInstance) {
  fastify.get('/supervisor/v2/status', async (_request, reply) => {
    try {
      const state = await db
        .select()
        .from(supervisorState)
        .where(eq(supervisorState.id, 1))
        .limit(1);

      const stateRow = state[0] ?? null;
      const activePlanId = stateRow?.active_plan_id ?? null;

      // Resolve plan items for the active plan (joined with media for title)
      let resolvedPlanItems: Array<{
        id: number;
        position: number;
        content_type: string;
        media_title: string | null;
        planned_duration_seconds: number;
        status: string;
        reason: string;
        mandatory: boolean;
      }> = [];

      if (activePlanId !== null) {
        const rows = await db
          .select({
            id: planItems.id,
            position: planItems.position,
            content_type: planItems.content_type,
            planned_duration_seconds: planItems.planned_duration_seconds,
            status: planItems.status,
            reason: planItems.reason,
            mandatory: planItems.mandatory,
            media_title: media.title,
            media_original_filename: media.original_filename,
          })
          .from(planItems)
          .leftJoin(media, eq(planItems.media_id, media.id))
          .where(and(eq(planItems.plan_id, activePlanId), ne(planItems.status, 'dropped')))
          .orderBy(planItems.position);

        resolvedPlanItems = rows.map((r) => ({
          id: r.id,
          position: r.position,
          content_type: r.content_type,
          media_title: r.media_title ?? r.media_original_filename ?? null,
          planned_duration_seconds: r.planned_duration_seconds,
          status: r.status,
          reason: r.reason,
          mandatory: r.mandatory,
        }));
      }

      // Resolve today's stop-set estimates (latest per segment_id)
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const todayStartMs = todayStart.getTime();
      const todayEndMs = todayEnd.getTime();

      const estimateRows = await db
        .select({
          id: stopSetEstimates.id,
          segment_id: stopSetEstimates.segment_id,
          break_duration_seconds: stopSetEstimates.break_duration_seconds,
          hard_claimed_seconds: stopSetEstimates.hard_claimed_seconds,
          contested_seconds: stopSetEstimates.contested_seconds,
          free_seconds: stopSetEstimates.free_seconds,
          occupation_ratio: stopSetEstimates.occupation_ratio,
          oversubscribed: stopSetEstimates.oversubscribed,
          candidate_count: stopSetEstimates.candidate_count,
          computed_at: stopSetEstimates.computed_at,
          plan_created_at: plans.created_at,
        })
        .from(stopSetEstimates)
        .innerJoin(plans, eq(stopSetEstimates.plan_id, plans.id));

      const latestBySegment = new Map<
        number,
        {
          id: number;
          segment_id: number;
          break_duration_seconds: number;
          hard_claimed_seconds: number;
          contested_seconds: number;
          free_seconds: number;
          occupation_ratio: number;
          oversubscribed: boolean;
          candidate_count: number;
          computed_at: number;
        }
      >();

      for (const row of estimateRows) {
        const createdAt = row.plan_created_at;
        if (createdAt < todayStartMs || createdAt > todayEndMs) continue;

        const existing = latestBySegment.get(row.segment_id);
        if (!existing || row.computed_at > existing.computed_at) {
          latestBySegment.set(row.segment_id, {
            id: row.id,
            segment_id: row.segment_id,
            break_duration_seconds: row.break_duration_seconds,
            hard_claimed_seconds: row.hard_claimed_seconds,
            contested_seconds: row.contested_seconds,
            free_seconds: row.free_seconds,
            occupation_ratio: row.occupation_ratio,
            oversubscribed: row.oversubscribed,
            candidate_count: row.candidate_count,
            computed_at: row.computed_at,
          });
        }
      }

      const resolvedEstimates = Array.from(latestBySegment.values()).map((e) => ({
        id: e.id,
        segment_id: e.segment_id,
        break_duration_seconds: e.break_duration_seconds,
        hard_claimed_seconds: e.hard_claimed_seconds,
        contested_seconds: e.contested_seconds,
        free_seconds: e.free_seconds,
        occupation_ratio: e.occupation_ratio,
        oversubscribed: e.oversubscribed,
        candidate_count: e.candidate_count,
      }));

      // Determine if a live takeover is currently active
      const activeLiveRows = await db
        .select({ id: liveEvents.id })
        .from(liveEvents)
        .where(isNull(liveEvents.ended_at))
        .limit(1);

      const liveTakeoverActive = activeLiveRows.length > 0;

      // Resolve current segment for playhead data
      const nowMs = Date.now();
      const resolvedSegment = await resolveCurrentSegment(nowMs, db);
      const segmentStartedAtMs = resolvedSegment?.segmentStartMs ?? null;
      const segmentDurationSeconds = resolvedSegment?.segment.duration_seconds ?? null;

      // Compute plan_consumed_seconds and expected_current_item_end_ms.
      // When D44 has fired the active plan already points to the NEXT segment's plan
      // while the wall clock is still in the current segment. In that case, computing
      // consumption from the active plan would yield 0 (nothing from the new plan has
      // played yet), making live drift spike to hundreds of seconds. Instead, detect
      // the mismatch and use the most recent plan for the current segment.
      let planConsumedSeconds = 0;
      let expectedCurrentItemEndMs: number | null = null;

      if (activePlanId !== null) {
        let planIdForConsumption = activePlanId;

        if (resolvedSegment !== null) {
          const [activePlanMeta] = await db
            .select({ segment_id: plans.segment_id })
            .from(plans)
            .where(eq(plans.id, activePlanId))
            .limit(1);

          if (activePlanMeta && activePlanMeta.segment_id !== resolvedSegment.segment.id) {
            const [currentSegPlan] = await db
              .select({ id: plans.id })
              .from(plans)
              .where(eq(plans.segment_id, resolvedSegment.segment.id))
              .orderBy(desc(plans.id))
              .limit(1);
            if (currentSegPlan) planIdForConsumption = currentSegPlan.id;
          }
        }

        const allItems = await db
          .select()
          .from(planItems)
          .where(eq(planItems.plan_id, planIdForConsumption))
          .orderBy(asc(planItems.position));

        const terminal = new Set(['played', 'supervisor_skipped', 'operator_skipped', 'dropped']);
        for (const item of allItems) {
          if (terminal.has(item.status)) {
            planConsumedSeconds += item.planned_duration_seconds ?? 0;
          } else if (item.status === 'playing' && item.play_history_id != null) {
            const [ph] = await db
              .select({ started_at: playHistory.started_at })
              .from(playHistory)
              .where(eq(playHistory.id, item.play_history_id));
            const startedMs = ph?.started_at ? new Date(ph.started_at).getTime() : nowMs - 5000;
            planConsumedSeconds += (nowMs - startedMs) / 1000;
            expectedCurrentItemEndMs = startedMs + (item.planned_duration_seconds ?? 0) * 1000;
            break;
          } else {
            break;
          }
        }
      }

      // ── C1: current_segment ────────────────────────────────────────────────
      let currentSegment = null;
      if (resolvedSegment) {
        const elapsedSeconds = (nowMs - resolvedSegment.segmentStartMs) / 1000;
        const remainingSeconds = Math.max(0, (resolvedSegment.segmentEndMs - nowMs) / 1000);
        currentSegment = {
          id: resolvedSegment.segment.id,
          type: resolvedSegment.segment.type,
          name: resolvedSegment.segment.name,
          duration_seconds: resolvedSegment.segment.duration_seconds,
          clock_id: resolvedSegment.clock_id,
          show_id: resolvedSegment.show_id,
          show_name: resolvedSegment.show_name,
          elapsed_seconds: Math.round(elapsedSeconds * 10) / 10,
          remaining_seconds: Math.round(remainingSeconds * 10) / 10,
        };
      }

      // ── C1: next_plan ──────────────────────────────────────────────────────
      const nextPlanId = stateRow?.next_plan_id ?? null;
      let nextPlan = null;
      if (nextPlanId != null) {
        const [nextPlanRow] = await db
          .select({ id: plans.id, status: plans.status, segment_id: plans.segment_id })
          .from(plans)
          .where(eq(plans.id, nextPlanId));
        if (nextPlanRow) {
          const [nextSeg] = await db
            .select({ type: clockSegments.type, name: clockSegments.name, duration_seconds: clockSegments.duration_seconds })
            .from(clockSegments)
            .where(eq(clockSegments.id, nextPlanRow.segment_id));
          const [{ cnt }] = await db
            .select({ cnt: count() })
            .from(planItems)
            .where(eq(planItems.plan_id, nextPlanId));
          nextPlan = {
            id: nextPlanRow.id,
            status: nextPlanRow.status,
            segment_id: nextPlanRow.segment_id,
            segment_type: nextSeg?.type ?? 'unknown',
            segment_name: nextSeg?.name ?? '',
            item_count: cnt,
            target_seconds: nextSeg?.duration_seconds ?? 0,
          };
        }
      }

      // ── C1: recent_plays ───────────────────────────────────────────────────
      const recentPlayRows = await db
        .select({
          title: media.title,
          original_filename: media.original_filename,
          artist: media.artist,
          duration_seconds: media.duration_seconds,
          started_at: playHistory.started_at,
          plan_item_id: playHistory.plan_item_id,
          content_type: planItems.content_type,
        })
        .from(playHistory)
        .leftJoin(media, eq(playHistory.media_id, media.id))
        .leftJoin(planItems, eq(playHistory.plan_item_id, planItems.id))
        .where(isNotNull(playHistory.started_at))
        .orderBy(desc(playHistory.started_at))
        .limit(10);

      const recentPlays = recentPlayRows.map((r) => ({
        title: r.title ?? r.original_filename ?? null,
        artist: r.artist ?? null,
        content_type: r.content_type ?? null,
        started_at_ms: r.started_at ? new Date(r.started_at).getTime() : 0,
        duration_seconds: r.duration_seconds ?? null,
        plan_item_id: r.plan_item_id ?? null,
      }));

      // ── C2: segment_config ─────────────────────────────────────────────────
      let segmentConfig = null;
      if (resolvedSegment) {
        const seg = resolvedSegment.segment;
        const [clockRow] = await db
          .select({ jingle_playlist_id: clocks.jingle_playlist_id, station_id_playlist_id: clocks.station_id_playlist_id })
          .from(clocks)
          .where(eq(clocks.id, resolvedSegment.clock_id));

        let showJinglePlaylistId: number | null = null;
        if (resolvedSegment.show_id != null) {
          const [showRow] = await db
            .select({ jingle_playlist_id: shows.jingle_playlist_id })
            .from(shows)
            .where(eq(shows.id, resolvedSegment.show_id));
          showJinglePlaylistId = showRow?.jingle_playlist_id ?? null;
        }

        // Extract rotation_ids from segment sources JSON.
        const sources: Array<{ type?: string; rotation_id?: number | null }> = (() => {
          const raw = seg.sources;
          if (Array.isArray(raw)) return raw as Array<{ type?: string; rotation_id?: number | null }>;
          if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
          return [];
        })();
        const rotationIds = sources
          .filter((s) => s.type === 'playlist' && typeof s.rotation_id === 'number')
          .map((s) => s.rotation_id as number)
          .filter((id, i, arr) => arr.indexOf(id) === i);

        segmentConfig = {
          rotation_ids: rotationIds,
          jingle_playlist_id: clockRow?.jingle_playlist_id ?? null,
          station_id_playlist_id: clockRow?.station_id_playlist_id ?? null,
          start_clip_playlist_id: seg.start_clip_playlist_id ?? null,
          end_clip_playlist_id: seg.end_clip_playlist_id ?? null,
          show_jingle_playlist_id: showJinglePlaylistId,
        };
      }

      return reply.send({
        active_plan_id: activePlanId,
        current_drift_seconds: stateRow?.current_drift_seconds ?? 0,
        last_heartbeat_at: stateRow?.last_heartbeat_at ?? null,
        live_takeover_active: liveTakeoverActive,
        plan_items: resolvedPlanItems,
        stop_set_estimates: resolvedEstimates,
        paused: stateRow?.paused ?? false,
        segment_started_at_ms: segmentStartedAtMs,
        segment_duration_seconds: segmentDurationSeconds,
        plan_consumed_seconds: planConsumedSeconds,
        expected_current_item_end_ms: expectedCurrentItemEndMs,
        current_segment: currentSegment,
        next_plan: nextPlan,
        recent_plays: recentPlays,
        segment_config: segmentConfig,
      });
    } catch (err) {
      fastify.log.error(err, 'supervisor v2 status failed');
      return reply.status(500).send({ error: 'Failed to fetch supervisor status' });
    }
  });
}
