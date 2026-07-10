import { z } from 'zod';
import { JOIN_POLICIES, EXTENSION_POLICIES } from './scheduling.js';

export const SupervisorConfigSchema = z.object({
  scheduler_tick_ms: z.number().int().min(500).max(60_000).default(5_000),
  metadata_poll_ms: z.number().int().min(500).max(60_000).default(5_000),
  queue_depth_threshold: z.number().int().min(1).max(20).default(1),
  separation_minutes: z.number().int().min(0).max(720).default(30),
  // Station-wide handover defaults — clocks inherit these unless they set an explicit override
  join_policy: z.enum(JOIN_POLICIES).default('join_top'),
  // Default for shows that don't set extension_policy explicitly
  extension_policy: z.enum(EXTENSION_POLICIES).default('repeat_last_clock'),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

/**
 * Output row from /supervisor/simulate. media is null for live / live_audience /
 * stop_set placeholder rows that the simulator doesn't expand into individual
 * picks. clock + segment context lets the UI group by segment.
 */
export const SimulatedPlaySchema = z.object({
  at: z.coerce.date(),
  media: z
    .object({
      id: z.number().int(),
      title: z.string().nullable(),
      artist: z.string().nullable(),
      original_filename: z.string(),
      duration_seconds: z.number(),
      category: z.string(),
    })
    .nullable(),
  reason: z.string(),
  clock_name: z.string(),
  segment_name: z.string(),
  segment_type: z.string(),
  campaign_id: z.number().int().nullable(),
  music_campaign_id: z.number().int().nullable(),
  promo_id: z.number().int().nullable(),
  stop_set_position: z.number().int().nullable(),
});
export type SimulatedPlay = z.infer<typeof SimulatedPlaySchema>;

// ─── Supervisor V2 Status (Phase 5 — operator visibility) ────────────────────

export const SupervisorV2PlanItemSchema = z.object({
  id: z.number().int(),
  position: z.number().int(),
  content_type: z.string(),
  media_title: z.string().nullable(),
  planned_duration_seconds: z.number(),
  status: z.string(),
  reason: z.string(),
  mandatory: z.boolean(),
});
export type SupervisorV2PlanItem = z.infer<typeof SupervisorV2PlanItemSchema>;

export const SupervisorV2StopSetEstimateSchema = z.object({
  id: z.number().int(),
  segment_id: z.number().int(),
  break_duration_seconds: z.number(),
  hard_claimed_seconds: z.number(),
  contested_seconds: z.number(),
  free_seconds: z.number(),
  occupation_ratio: z.number(),
  oversubscribed: z.boolean(),
  candidate_count: z.number().int(),
});
export type SupervisorV2StopSetEstimate = z.infer<typeof SupervisorV2StopSetEstimateSchema>;

export const SupervisorV2CurrentSegmentSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  name: z.string(),
  duration_seconds: z.number(),
  clock_id: z.number().int(),
  show_id: z.number().int().nullable(),
  show_name: z.string().nullable(),
  elapsed_seconds: z.number(),
  remaining_seconds: z.number(),
});
export type SupervisorV2CurrentSegment = z.infer<typeof SupervisorV2CurrentSegmentSchema>;

export const SupervisorV2NextPlanSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  segment_id: z.number().int(),
  segment_type: z.string(),
  segment_name: z.string(),
  item_count: z.number().int(),
  target_seconds: z.number(),
});
export type SupervisorV2NextPlan = z.infer<typeof SupervisorV2NextPlanSchema>;

export const SupervisorV2RecentPlaySchema = z.object({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  content_type: z.string().nullable(),
  started_at_ms: z.number(),
  duration_seconds: z.number().nullable(),
  plan_item_id: z.number().int().nullable(),
});
export type SupervisorV2RecentPlay = z.infer<typeof SupervisorV2RecentPlaySchema>;

export const SupervisorV2SegmentConfigSchema = z.object({
  rotation_ids: z.array(z.number().int()),
  jingle_playlist_id: z.number().int().nullable(),
  station_id_playlist_id: z.number().int().nullable(),
  start_clip_playlist_id: z.number().int().nullable(),
  end_clip_playlist_id: z.number().int().nullable(),
  show_jingle_playlist_id: z.number().int().nullable(),
});
export type SupervisorV2SegmentConfig = z.infer<typeof SupervisorV2SegmentConfigSchema>;

export const SupervisorV2StatusSchema = z.object({
  active_plan_id: z.number().int().nullable(),
  current_drift_seconds: z.number(),
  last_heartbeat_at: z.number().nullable(),
  live_takeover_active: z.boolean(),
  plan_items: z.array(SupervisorV2PlanItemSchema),
  stop_set_estimates: z.array(SupervisorV2StopSetEstimateSchema),
  paused: z.boolean(),
  segment_started_at_ms: z.number().nullable(),
  segment_duration_seconds: z.number().nullable(),
  plan_consumed_seconds: z.number(),
  expected_current_item_end_ms: z.number().nullable(),
  // Phase C additions
  current_segment: SupervisorV2CurrentSegmentSchema.nullable(),
  next_plan: SupervisorV2NextPlanSchema.nullable(),
  recent_plays: z.array(SupervisorV2RecentPlaySchema),
  segment_config: SupervisorV2SegmentConfigSchema.nullable(),
});
export type SupervisorV2Status = z.infer<typeof SupervisorV2StatusSchema>;

export const SupervisorV2ControlResponseSchema = z.object({
  ok: z.boolean(),
  // Set by align-to-clock: whether it actually retired the active plan, or
  // was a no-op because the plan was already at/ahead of wall clock.
  invalidated: z.boolean().optional(),
});
export type SupervisorV2ControlResponse = z.infer<typeof SupervisorV2ControlResponseSchema>;
