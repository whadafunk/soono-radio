import { z } from 'zod';
import { CLOCK_SEGMENT_TYPES, JOIN_POLICIES, EXTENSION_POLICIES } from './scheduling.js';

export const RESOLVED_SCHEDULE_SOURCES = ['calendar', 'template_clock', 'template', 'fallback'] as const;
export type ResolvedScheduleSource = (typeof RESOLVED_SCHEDULE_SOURCES)[number];

/**
 * What the supervisor thinks should be on air at the time of the status read.
 * Derived from the schedule (calendar > template_clock > template > silence),
 * not from what LiquidSoap is actually doing — Phase A observability only.
 */
export const ScheduledStateSchema = z.object({
  source: z.enum(RESOLVED_SCHEDULE_SOURCES),
  clock_id: z.number().int(),
  clock_name: z.string(),
  segment_id: z.number().int(),
  segment_name: z.string(),
  segment_type: z.enum(CLOCK_SEGMENT_TYPES),
  segment_index: z.number().int().nonnegative(),
  show_id: z.number().int().nullable(),
  show_name: z.string().nullable(),
  clock_instance_started_at: z.coerce.date(),
  segment_started_at: z.coerce.date(),
  segment_elapsed_seconds: z.number().int().nonnegative(),
  segment_remaining_seconds: z.number().int().nonnegative(),
  /**
   * Music playtime minus segment elapsed, in seconds. Positive = music is
   * running long (segment elapsed faster than music played); negative = music
   * has overrun. Computed from completed plays only — updates discretely at
   * track boundaries.
   */
  drift_seconds: z.number().int().default(0),
  /** True when a hard-cut boundary is within ~2 minutes. UI warning trigger. */
  hard_cut_warning: z.boolean().default(false),
});
export type ScheduledState = z.infer<typeof ScheduledStateSchema>;

export const PLAY_SOURCES = ['auto', 'live', 'manual'] as const;
export type PlaySource = (typeof PLAY_SOURCES)[number];
export const PlaySourceSchema = z.enum(PLAY_SOURCES);

export const PlayHistorySchema = z.object({
  id: z.number().int(),
  media_id: z.number().int().nullable(),
  source: PlaySourceSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  aborted: z.boolean(),
  live_listener_count: z.number().int().nullable(),
  pick_reason: z.string().nullable(),
});
export type PlayHistory = z.infer<typeof PlayHistorySchema>;

export const SupervisorStatusSchema = z.object({
  running: z.boolean(),
  reachable: z.boolean(),
  queue_depth: z.number().int().nonnegative(),
  on_air_source: z.enum(['live', 'auto', 'none']),
  current_play_id: z.number().int().nullable(),
  /** What the schedule says should be on air right now (null = silence). */
  scheduled: ScheduledStateSchema.nullable(),
  /** True when the scheduler's picker is paused (queue/live polling continues). */
  paused: z.boolean().default(false),
  /** When non-null, the resolved schedule is pinned to this segment until released. */
  held: z
    .object({
      segment_id: z.number().int(),
      held_at: z.coerce.date(),
    })
    .nullable()
    .default(null),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatusSchema>;

/** Display shape returned by /supervisor/now-playing — joined with media for titles. */
export const NowPlayingSchema = z
  .object({
    id: z.number().int(),
    media_id: z.number().int().nullable(),
    source: PlaySourceSchema,
    started_at: z.coerce.date(),
    live_listener_count: z.number().int().nullable(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    original_filename: z.string().nullable(),
    duration_seconds: z.number().nullable(),
  })
  .nullable();
export type NowPlaying = z.infer<typeof NowPlayingSchema>;

/** Recent-plays row (one per /supervisor/recent-plays). */
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

export const RecentPlaySchema = z.object({
  id: z.number().int(),
  media_id: z.number().int().nullable(),
  source: PlaySourceSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  aborted: z.boolean(),
  live_listener_count: z.number().int().nullable(),
  pick_reason: z.string().nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  original_filename: z.string().nullable(),
  duration_seconds: z.number().nullable(),
});
export type RecentPlay = z.infer<typeof RecentPlaySchema>;

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
});
export type SupervisorV2Status = z.infer<typeof SupervisorV2StatusSchema>;

export const SupervisorV2ControlResponseSchema = z.object({ ok: z.boolean() });
export type SupervisorV2ControlResponse = z.infer<typeof SupervisorV2ControlResponseSchema>;
