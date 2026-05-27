import { FastifyInstance } from 'fastify';
import { eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  supervisorState,
  plans,
  planItems,
  media,
  stopSetEstimates,
  liveEvents,
} from '../db/schema.js';

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
          .where(eq(planItems.plan_id, activePlanId))
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
      // We join with plans to filter by today's plans (created_at on the plan row)
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

      // Filter to today and keep only the latest per segment_id
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

      return reply.send({
        active_plan_id: activePlanId,
        current_drift_seconds: stateRow?.current_drift_seconds ?? 0,
        last_heartbeat_at: stateRow?.last_heartbeat_at ?? null,
        live_takeover_active: liveTakeoverActive,
        plan_items: resolvedPlanItems,
        stop_set_estimates: resolvedEstimates,
      });
    } catch (err) {
      fastify.log.error(err, 'supervisor v2 status failed');
      return reply.status(500).send({ error: 'Failed to fetch supervisor status' });
    }
  });
}
