import { FastifyInstance } from 'fastify';
import { and, asc, count, desc, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm';
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
import { resolveActivePlanSegment, resolveCurrentSegment, resolveNextHardSegment } from '../services/supervisor2/clockResolver.js';
import { getDriftFullAuthorityThresholdSeconds, getDriftRecoveryCapSeconds } from '../services/supervisor2/processes/supervisor.js';

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
      const driftRecoveryCapSeconds = await getDriftRecoveryCapSeconds(db);
      const driftFullAuthorityThresholdSeconds = await getDriftFullAuthorityThresholdSeconds(db);

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

      // Resolve current segment for playhead data. Prefer the *active plan's
      // own* segment (Decision 64) over an independent wall-clock resolve:
      // when the active plan is mid-crossing (deliberately running past its
      // nominal boundary to absorb earlier drift, Decision 51), a fresh
      // resolveCurrentSegment(nowMs) can report a later segment than what's
      // actually airing, producing a nonsensical elapsed/consumed mismatch in
      // the operator-facing drift figure. Only fall back to the wall-clock
      // resolve when there's no active plan to derive anything from (cold
      // start / no schedule yet).
      const nowMs = Date.now();
      const resolvedSegment = activePlanId !== null
        ? (await resolveActivePlanSegment(db, activePlanId)) ?? (await resolveCurrentSegment(nowMs, db))
        : await resolveCurrentSegment(nowMs, db);
      const segmentStartedAtMs = resolvedSegment?.segmentStartMs ?? null;
      const segmentDurationSeconds = resolvedSegment?.segment.duration_seconds ?? null;

      // Compute plan_consumed_seconds and expected_current_item_end_ms by
      // walking the active plan's own items. Plan activation now waits for
      // the incoming plan's first item to actually start airing (D44) —
      // active_plan_id always means "what's really playing," so there's no
      // need to detect/compensate for a segment mismatch here anymore.
      let planConsumedSeconds = 0;
      let expectedCurrentItemEndMs: number | null = null;
      // Decision 93: predicted lateness at the active plan's own boundary.
      let predictedBoundaryLatenessSeconds: number | null = null;
      // Plan-internal drift: has the plan's own estimated end shifted since it
      // activated (a mid-flight replan/trim/fill changed its total content),
      // independent of wall-clock-vs-consumed drift. Computed here off the
      // plan_items already fetched for planConsumedSeconds — no extra query,
      // and no tick-loop cost, since this only runs on the operator's status
      // poll, not the 500ms supervisor tick.
      let planInternalDriftSeconds: number | null = null;

      if (activePlanId !== null) {
        const allItems = await db
          .select()
          .from(planItems)
          .where(eq(planItems.plan_id, activePlanId))
          .orderBy(asc(planItems.position));

        const terminal = new Set(['played', 'supervisor_skipped', 'operator_skipped', 'dropped']);
        for (const item of allItems) {
          if (terminal.has(item.status)) {
            planConsumedSeconds += item.planned_duration_seconds ?? 0;
          } else if (item.status === 'playing' && item.play_history_id != null) {
            const [ph] = await db
              .select({ started_at: playHistory.started_at, confirmed: playHistory.confirmed })
              .from(playHistory)
              .where(eq(playHistory.id, item.play_history_id));
            // Same guard as playhead.ts's consumedSecondsForPlan: insertPushed
            // writes started_at as a push-time placeholder (NOT NULL column,
            // so it can't stay empty) until LS_TRACK_STARTED confirms the
            // real on-air time. Crediting elapsed time against the
            // placeholder is exactly what made the drift figure appear to
            // grow then snap after a fresh activation (found 2026-07-15) —
            // hold at the last confirmed point instead until it's real.
            if (ph?.confirmed && ph.started_at) {
              const startedMs = new Date(ph.started_at).getTime();
              planConsumedSeconds += (nowMs - startedMs) / 1000;
              expectedCurrentItemEndMs = startedMs + (item.planned_duration_seconds ?? 0) * 1000;
            }
            break;
          } else {
            break;
          }
        }

        const liveTotalPlannedSeconds = allItems
          .filter((item) => item.status !== 'dropped')
          .reduce((sum, item) => sum + (item.planned_duration_seconds ?? 0), 0);
        const baselineTotalPlannedSeconds = (segmentDurationSeconds ?? 0) + (stateRow?.planned_overshoot_seconds ?? 0);
        planInternalDriftSeconds = liveTotalPlannedSeconds - baselineTotalPlannedSeconds;

        // Decision 93: live prediction — when will the active plan's content
        // actually run out, vs when its segment is scheduled to end. Same
        // arithmetic as the supervisor's own Decision 91 sizing input.
        if (resolvedSegment) {
          const remainingSeconds = Math.max(0, liveTotalPlannedSeconds - planConsumedSeconds);
          predictedBoundaryLatenessSeconds =
            Math.round(((nowMs + remainingSeconds * 1000 - resolvedSegment.segmentEndMs) / 1000) * 10) / 10;
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
          source_type: resolvedSegment.source_type,
          boundary_drift_seconds: stateRow?.boundary_drift_seconds ?? 0,
          intentional_offset_seconds: stateRow?.intentional_offset_seconds ?? 0,
          planned_overshoot_seconds: stateRow?.planned_overshoot_seconds ?? 0,
        };
      }

      // ── Next hard segment lookahead ────────────────────────────────────────
      // Reuses the same lookahead resolveNextHardSegment already computes for
      // Decision 62/69 — no new resolution logic, just surfacing it here.
      const hardLookahead = await resolveNextHardSegment(nowMs, db);
      const nextHardSegment = hardLookahead
        ? {
            segment_id: hardLookahead.hard.segment.id,
            name: hardLookahead.hard.segment.name,
            type: hardLookahead.hard.segment.type,
            starts_at_ms: hardLookahead.hard.segmentStartMs,
            seconds_until: (hardLookahead.hard.segmentStartMs - nowMs) / 1000,
          }
        : null;

      // ── C1: next_plan ──────────────────────────────────────────────────────
      const nextPlanId = stateRow?.next_plan_id ?? null;
      let nextPlan = null;
      if (nextPlanId != null) {
        const [nextPlanRow] = await db
          .select({
            id: plans.id,
            status: plans.status,
            segment_id: plans.segment_id,
            nominal_duration_seconds: plans.nominal_duration_seconds,
            target_duration_seconds: plans.target_duration_seconds,
            predicted_drift_seconds: plans.predicted_drift_seconds,
            applied_correction_seconds: plans.applied_correction_seconds,
          })
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
            // Decision 93: the plan's real sizing, not the segment nominal.
            target_seconds: nextPlanRow.target_duration_seconds ?? nextSeg?.duration_seconds ?? 0,
            nominal_seconds: nextPlanRow.nominal_duration_seconds ?? nextSeg?.duration_seconds ?? 0,
            predicted_drift_seconds: nextPlanRow.predicted_drift_seconds,
            applied_correction_seconds: nextPlanRow.applied_correction_seconds,
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
        next_hard_segment: nextHardSegment,
        plan_internal_drift_seconds: planInternalDriftSeconds,
        drift_recovery_cap_seconds: driftRecoveryCapSeconds,
        drift_full_authority_threshold_s: driftFullAuthorityThresholdSeconds,
        predicted_boundary_lateness_seconds: predictedBoundaryLatenessSeconds,
      });
    } catch (err) {
      fastify.log.error(err, 'supervisor v2 status failed');
      return reply.status(500).send({ error: 'Failed to fetch supervisor status' });
    }
  });

  // Decision 93 — the drift ledger: one row per activated plan telling the
  // whole sizing story ("we predicted X, sized to nominal − Y, actually
  // arrived Z late"). Newest first.
  fastify.get('/supervisor/v2/drift-ledger', async (request, reply) => {
    try {
      const q = request.query as { limit?: string };
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 48));
      const rows = await db
        .select({
          plan_id: plans.id,
          segment_id: plans.segment_id,
          segment_name: clockSegments.name,
          segment_type: clockSegments.type,
          status: plans.status,
          activated_at: plans.activated_at,
          nominal_duration_seconds: plans.nominal_duration_seconds,
          target_duration_seconds: plans.target_duration_seconds,
          predicted_drift_seconds: plans.predicted_drift_seconds,
          applied_correction_seconds: plans.applied_correction_seconds,
          boundary_drift_seconds: plans.boundary_drift_seconds,
        })
        .from(plans)
        .innerJoin(clockSegments, eq(clockSegments.id, plans.segment_id))
        .where(isNotNull(plans.activated_at))
        .orderBy(desc(plans.activated_at))
        .limit(limit);
      return reply.send({ entries: rows });
    } catch (err) {
      fastify.log.error(err, 'supervisor v2 drift-ledger failed');
      return reply.status(500).send({ error: 'Failed to fetch drift ledger' });
    }
  });

  // The full story of one plan — sizing chain, every item with its reason and
  // what actually aired, plus the plan that aired immediately before it. Built
  // entirely from the DB so it outlives log rotation.
  fastify.get('/supervisor/v2/plans/:id/story', async (request, reply) => {
    try {
      const planId = Number((request.params as { id: string }).id);
      if (!Number.isInteger(planId) || planId <= 0) {
        return reply.status(400).send({ error: 'invalid plan id' });
      }

      const planCols = {
        id: plans.id,
        segment_id: plans.segment_id,
        segment_name: clockSegments.name,
        segment_type: clockSegments.type,
        status: plans.status,
        created_at: plans.created_at,
        finalized_at: plans.finalized_at,
        activated_at: plans.activated_at,
        nominal_duration_seconds: plans.nominal_duration_seconds,
        target_duration_seconds: plans.target_duration_seconds,
        predicted_drift_seconds: plans.predicted_drift_seconds,
        applied_correction_seconds: plans.applied_correction_seconds,
        boundary_drift_seconds: plans.boundary_drift_seconds,
      };

      const [plan] = await db
        .select(planCols)
        .from(plans)
        .leftJoin(clockSegments, eq(clockSegments.id, plans.segment_id))
        .where(eq(plans.id, planId));
      if (!plan) {
        return reply.status(404).send({ error: 'plan not found' });
      }

      const itemRows = await db
        .select({
          item_id: planItems.id,
          position: planItems.position,
          content_type: planItems.content_type,
          planned_duration_seconds: planItems.planned_duration_seconds,
          status: planItems.status,
          reason: planItems.reason,
          title: media.title,
          original_filename: media.original_filename,
          artist: media.artist,
          ph_started_at: playHistory.started_at,
          ph_ended_at: playHistory.ended_at,
          ph_aborted: playHistory.aborted,
        })
        .from(planItems)
        .leftJoin(media, eq(planItems.media_id, media.id))
        .leftJoin(playHistory, eq(playHistory.plan_item_id, planItems.id))
        .where(eq(planItems.plan_id, planId))
        .orderBy(asc(planItems.position), asc(playHistory.started_at));

      // A retried item can have several play_history rows — keep the latest.
      const byItem = new Map<number, (typeof itemRows)[number]>();
      for (const r of itemRows) byItem.set(r.item_id, r);
      const items = [...byItem.values()].map((r) => {
        const startedMs = r.ph_started_at != null ? r.ph_started_at.getTime() : null;
        const endedMs = r.ph_ended_at != null ? r.ph_ended_at.getTime() : null;
        return {
          position: r.position,
          content_type: r.content_type,
          title: r.title ?? r.original_filename ?? null,
          artist: r.artist ?? null,
          planned_duration_seconds: r.planned_duration_seconds,
          status: r.status,
          reason: r.reason,
          started_at_ms: startedMs,
          aired_seconds:
            startedMs != null && endedMs != null ? Math.max(0, (endedMs - startedMs) / 1000) : null,
          aborted: r.ph_aborted ?? false,
        };
      });

      let previous: typeof plan | null = null;
      if (plan.activated_at != null) {
        const [prev] = await db
          .select(planCols)
          .from(plans)
          .leftJoin(clockSegments, eq(clockSegments.id, plans.segment_id))
          .where(and(isNotNull(plans.activated_at), lt(plans.activated_at, plan.activated_at)))
          .orderBy(desc(plans.activated_at))
          .limit(1);
        previous = prev ?? null;
      }

      return reply.send({
        plan,
        items,
        planned_total_seconds: items.reduce((acc, it) => acc + it.planned_duration_seconds, 0),
        previous,
      });
    } catch (err) {
      fastify.log.error(err, 'supervisor v2 plan story failed');
      return reply.status(500).send({ error: 'Failed to fetch plan story' });
    }
  });
}
