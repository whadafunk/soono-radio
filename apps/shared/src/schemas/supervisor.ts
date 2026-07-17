import { z } from 'zod';
import { JOIN_POLICIES, EXTENSION_POLICIES } from './scheduling.js';

export const SupervisorConfigSchema = z.object({
  // scheduler tick / metadata polling deliberately NOT configurable: the
  // supervisor's real tick is a hardcoded 500ms constant and metadata comes
  // from LS webhooks + /now-playing on the same cadence — the old fields
  // were saved but never read, implying control that didn't exist.
  // queue depth deliberately NOT configurable: the whole execution layer
  // (queue-ahead, activation-on-confirmation, playhead accounting, the
  // finalize snapshot guard) is built around exactly 1 playing + 1 queued,
  // hardcoded in the Queue Feeder. A UI knob for it was misleading — it was
  // never read — and would be dangerous if it ever were.
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
  // Which schedule-resolution tier produced this segment — Decision 53/58's
  // fallback cascade (clockResolver.ts). Surfaced so operators can see when
  // the station is running on a fallback tier rather than the real schedule.
  source_type: z.enum(['calendar', 'template_clock', 'template', 'default']),
  // Actual measured wall-clock deviation at the moment this segment's plan
  // activated (frozen then, not live) — distinct from intentional_offset_seconds,
  // which is the deliberate fire-early/late decision and can diverge from it.
  boundary_drift_seconds: z.number(),
  intentional_offset_seconds: z.number(),
  // Positive = planned content will run past nominal duration (overshoot);
  // negative = planned content falls short (gap).
  planned_overshoot_seconds: z.number(),
});
export type SupervisorV2CurrentSegment = z.infer<typeof SupervisorV2CurrentSegmentSchema>;

export const SupervisorV2NextHardSegmentSchema = z.object({
  segment_id: z.number().int(),
  name: z.string(),
  type: z.string(),
  starts_at_ms: z.number(),
  seconds_until: z.number(),
});
export type SupervisorV2NextHardSegment = z.infer<typeof SupervisorV2NextHardSegmentSchema>;

export const SupervisorV2NextPlanSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  segment_id: z.number().int(),
  segment_type: z.string(),
  segment_name: z.string(),
  item_count: z.number().int(),
  target_seconds: z.number(),
  // Decision 93: the sizing story — nominal vs the drift-corrected target.
  nominal_seconds: z.number(),
  predicted_drift_seconds: z.number().nullable(),
  applied_correction_seconds: z.number().nullable(),
});
export type SupervisorV2NextPlan = z.infer<typeof SupervisorV2NextPlanSchema>;

// Decision 93 — one activated plan = one ledger row: "we predicted X, sized
// the plan to nominal − Y, actually arrived Z late."
export const SupervisorV2DriftLedgerEntrySchema = z.object({
  plan_id: z.number().int(),
  segment_id: z.number().int(),
  segment_name: z.string(),
  segment_type: z.string(),
  status: z.string(),
  activated_at: z.number().nullable(),
  nominal_duration_seconds: z.number().nullable(),
  target_duration_seconds: z.number().nullable(),
  predicted_drift_seconds: z.number().nullable(),
  applied_correction_seconds: z.number().nullable(),
  boundary_drift_seconds: z.number().nullable(),
});
export type SupervisorV2DriftLedgerEntry = z.infer<typeof SupervisorV2DriftLedgerEntrySchema>;

export const SupervisorV2DriftLedgerSchema = z.object({
  entries: z.array(SupervisorV2DriftLedgerEntrySchema),
});
export type SupervisorV2DriftLedger = z.infer<typeof SupervisorV2DriftLedgerSchema>;

// The full story of one plan — built from the DB (plans/plan_items/
// play_history), so it works for any plan ever activated, even after the log
// lines have rotated away. Rendered as a narrative in the Supervisor page's
// plan-story modal.
export const SupervisorV2PlanStoryItemSchema = z.object({
  position: z.number().int(),
  content_type: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  planned_duration_seconds: z.number(),
  status: z.string(),
  reason: z.string(),
  started_at_ms: z.number().nullable(),
  aired_seconds: z.number().nullable(),
  aborted: z.boolean(),
});
export type SupervisorV2PlanStoryItem = z.infer<typeof SupervisorV2PlanStoryItemSchema>;

export const SupervisorV2PlanStoryPlanSchema = z.object({
  id: z.number().int(),
  segment_id: z.number().int(),
  segment_name: z.string().nullable(),
  segment_type: z.string().nullable(),
  status: z.string(),
  created_at: z.number(),
  finalized_at: z.number().nullable(),
  activated_at: z.number().nullable(),
  nominal_duration_seconds: z.number().nullable(),
  target_duration_seconds: z.number().nullable(),
  predicted_drift_seconds: z.number().nullable(),
  applied_correction_seconds: z.number().nullable(),
  boundary_drift_seconds: z.number().nullable(),
});

export const SupervisorV2PlanStorySchema = z.object({
  plan: SupervisorV2PlanStoryPlanSchema,
  items: z.array(SupervisorV2PlanStoryItemSchema),
  planned_total_seconds: z.number(),
  // Context: the plan that aired immediately before this one.
  previous: SupervisorV2PlanStoryPlanSchema.nullable(),
});
export type SupervisorV2PlanStory = z.infer<typeof SupervisorV2PlanStorySchema>;

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
  next_hard_segment: SupervisorV2NextHardSegmentSchema.nullable(),
  // Has the active plan's own estimated total shifted since it activated
  // (a mid-flight replan/trim/fill), independent of wall-clock-vs-consumed
  // drift. Null when there's no active plan.
  plan_internal_drift_seconds: z.number().nullable(),
  // D71's cap — the most drift a single plan's target can be asked to
  // correct for. Surfaced so the UI can explain why intentional_offset_seconds
  // sometimes doesn't fully close the measured drift in one transition.
  drift_recovery_cap_seconds: z.number(),
  // Decision 92's threshold — above it the next plan corrects with full
  // authority instead of the comfort band.
  drift_full_authority_threshold_s: z.number(),
  // Decision 93: live prediction — how late (positive) or early (negative)
  // the active plan's content will arrive at its own segment boundary.
  predicted_boundary_lateness_seconds: z.number().nullable(),
});
export type SupervisorV2Status = z.infer<typeof SupervisorV2StatusSchema>;

export const SupervisorV2ControlResponseSchema = z.object({
  ok: z.boolean(),
  // Set by align-to-clock: whether it actually retired the active plan, or
  // was a no-op because the plan was already at/ahead of wall clock.
  invalidated: z.boolean().optional(),
});
export type SupervisorV2ControlResponse = z.infer<typeof SupervisorV2ControlResponseSchema>;
