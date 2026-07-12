import { z } from 'zod';

// ============ TIMING POLICY ============

export const StartPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hard') }),
  z.object({
    type: z.literal('flexible'),
    // null = natural end (unlimited); 0 = disabled; N = cut after N seconds overtime
    late_seconds: z.number().int().nonnegative().nullable().default(null),
    // null = fill gap (unlimited); 0 = disabled; N = start at most N seconds early
    early_seconds: z.number().int().nonnegative().nullable().default(0),
  }),
]);
export type StartPolicy = z.infer<typeof StartPolicySchema>;

// ─── Drift tactics ───────────────────────────────────────────────────────────

// Event types that can be skipped (Catching Up) or added (Coasting) to manage drift.
// Which types are applicable depends on the segment type and is enforced in the UI.
export const DRIFT_EVENT_TYPES = ['songs', 'jingles', 'station_ids', 'spots', 'promos'] as const;
export type DriftEventType = (typeof DRIFT_EVENT_TYPES)[number];

// ============ SWEEPER CONFIG ============

// Sweeper source types — source pool is derived per type, not stored in the doc:
// - commercial → campaign spots
// - promo      → promo documents (future)
// - station_id → clock.station_id_playlist_id
// - jingle     → show's jingle playlist (assigned clock) OR clock.jingle_playlist_id (unassigned)
export const SWEEP_SOURCES = ['commercial', 'promo', 'station_id', 'jingle'] as const;
export type SweepSource = (typeof SWEEP_SOURCES)[number];

export const SIMPLE_ROTATION_TYPES = ['round_robin', 'random'] as const;
export type SimpleRotationType = (typeof SIMPLE_ROTATION_TYPES)[number];

export const SweepSourceEntrySchema = z.object({
  type: z.enum(SWEEP_SOURCES),
  weight: z.number().int().positive().default(1),
  // FK to a sweeper-kind rotation document; null = default round-robin behavior
  rotation_id: z.number().int().positive().nullable().optional(),
});
export type SweepSourceEntry = z.infer<typeof SweepSourceEntrySchema>;

// Per-segment sweeper distribution config (replaces old clock-level sweep_config)
export const SegmentSweeperConfigSchema = z.object({
  per_hour: z.number().int().min(0).max(20),
  min_gap_minutes: z.number().int().min(1),
  sources: z.array(SweepSourceEntrySchema),
});
export type SegmentSweeperConfig = z.infer<typeof SegmentSweeperConfigSchema>;

// ============ SEGMENT SOURCE ============

export const SEGMENT_SOURCE_TYPES = [
  'show_playlist',
  'show_jingles',
  'show_beds',
  'promos',
  'playlist',
  'campaigns',
  'live',
  'recording',
] as const;
export type SegmentSourceType = (typeof SEGMENT_SOURCE_TYPES)[number];

export const SegmentSourceEntrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('show_playlist') }),
  z.object({ type: z.literal('show_jingles'), weight: z.number().int().positive().default(1), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional() }),
  z.object({ type: z.literal('show_beds'), weight: z.number().int().positive().default(1), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional() }),
  // promos / campaigns gain an optional simple rotation — used by the stop-set two-slot UI
  z.object({ type: z.literal('promos'), weight: z.number().int().positive().default(1), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional() }),
  // playlist source: hot_play / heavy_rotation kept for future rotation-document logic;
  // rotation_id supersedes the old simple `rotation` enum on music segments.
  z.object({ type: z.literal('playlist'), playlist_id: z.number().int().positive(), weight: z.number().int().positive().default(1), hot_play: z.boolean().default(false), heavy_rotation: z.boolean().default(false), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional(), rotation_id: z.number().int().positive().nullable().optional() }),
  z.object({ type: z.literal('campaigns'), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional() }),
  z.object({ type: z.literal('live') }),
  z.object({ type: z.literal('recording') }),
]);
export type SegmentSourceEntry = z.infer<typeof SegmentSourceEntrySchema>;

// ============ SWEEPERS & LIVE ============

export const SWEEPER_TYPES = ['commercial', 'promo', 'station_id', 'jingle'] as const;
export type SweeperType = (typeof SWEEPER_TYPES)[number];

// ============ CLOCKS ============

export const CLOCK_SEGMENT_TYPES = [
  'music',
  'live',
  'stop_set',
  'news',
  'voice_track',
  'bulletin',
] as const;
export type ClockSegmentType = (typeof CLOCK_SEGMENT_TYPES)[number];

export const ClockSegmentSchema = z.object({
  id: z.number().int(),
  clock_id: z.number().int(),
  sort_order: z.number().int().nonnegative(),
  name: z.string(),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive(),

  sources: z.array(SegmentSourceEntrySchema).default([]),

  start_clip_playlist_id: z.number().int().nullable(),
  end_clip_playlist_id: z.number().int().nullable(),
  bed_playlist_id: z.number().int().nullable(),
  interstitial_jingles_enabled: z.boolean().default(false),
  jingle_every_n_tracks: z.number().int().positive().nullable(),
  interstitial_station_id_enabled: z.boolean().default(false),
  station_id_every_n_tracks: z.number().int().positive().nullable(),

  start_policy: StartPolicySchema,
  // End policy flags
  can_skip: z.boolean().default(false),
  can_fill: z.boolean().default(false),
  // Defer the whole segment when running too late (voice_track / bulletin only)
  can_reschedule: z.boolean().default(false),
  // Ordered event types to skip when catching up (active when can_skip = true)
  catching_up_order: z.array(z.enum(DRIFT_EVENT_TYPES)).default([]),
  // Ordered event types to fill with when coasting (active when can_fill = true)
  coasting_order: z.array(z.enum(DRIFT_EVENT_TYPES)).default([]),

  accept_live: z.boolean(),
  // Legacy field — superseded by sweeper_config. Still returned by API for old data.
  accept_sweepers: z.array(z.enum(SWEEPER_TYPES)).default([]),
  sweeper_config: SegmentSweeperConfigSchema.nullable().default(null),
  silence_threshold_seconds: z.number().int().min(1).max(60).nullable(),
  rotation_type: z.enum(SIMPLE_ROTATION_TYPES).nullable(),
  fallback_playlist_id: z.number().int().nullable().optional(),
});
export type ClockSegment = z.infer<typeof ClockSegmentSchema>;

const ClockSegmentCreateShape = z.object({
  // Present for an existing segment being edited (positive, matches a real row);
  // absent or a client-side negative temp id for a not-yet-persisted segment.
  // Drives PUT /clocks/:id/segments' upsert-by-id — see Decision 52.
  id: z.number().int().optional(),
  name: z.string().min(1, 'Name is required'),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive('Duration must be at least 1 second'),
  sort_order: z.number().int().nonnegative().default(0),

  sources: z.array(SegmentSourceEntrySchema).default([]),

  start_clip_playlist_id: z.number().int().positive().nullable().optional(),
  end_clip_playlist_id: z.number().int().positive().nullable().optional(),
  bed_playlist_id: z.number().int().positive().nullable().optional(),
  interstitial_jingles_enabled: z.boolean().default(false),
  jingle_every_n_tracks: z.number().int().positive().nullable().optional(),
  interstitial_station_id_enabled: z.boolean().default(false),
  station_id_every_n_tracks: z.number().int().positive().nullable().optional(),

  start_policy: StartPolicySchema.default({ type: 'flexible', late_seconds: null, early_seconds: 0 }),
  can_skip: z.boolean().default(false),
  can_fill: z.boolean().default(false),
  can_reschedule: z.boolean().default(false),
  catching_up_order: z.array(z.enum(DRIFT_EVENT_TYPES)).default([]),
  coasting_order: z.array(z.enum(DRIFT_EVENT_TYPES)).default([]),

  accept_live: z.boolean().default(true),
  accept_sweepers: z.array(z.enum(SWEEPER_TYPES)).default([]),
  sweeper_config: SegmentSweeperConfigSchema.nullable().optional(),
  silence_threshold_seconds: z.number().int().min(1).max(60).nullable().optional(),
  rotation_type: z.enum(SIMPLE_ROTATION_TYPES).nullable().optional(),
  fallback_playlist_id: z.number().int().positive().nullable().optional(),
});

// Decision 76: stop-set segments must never use a hard start policy — the
// hard-start trim gate (applyHardStartTrim) only knows how to cut jingle/
// branding/station_id/music content to protect a boundary. Campaign and promo
// content (all a stop-set ever contains) isn't in that priority list, so a
// stop-set sitting in front of another hard boundary can't be trimmed at all.
export const ClockSegmentCreateSchema = ClockSegmentCreateShape.superRefine((data, ctx) => {
  if (data.type === 'stop_set' && data.start_policy.type === 'hard') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['start_policy', 'type'],
      message: 'Stop-set segments cannot use a hard start policy — only flexible is allowed.',
    });
  }
});
export type ClockSegmentCreate = z.infer<typeof ClockSegmentCreateSchema>;

export const ClockSegmentPatchSchema = ClockSegmentCreateShape.partial().omit({ sort_order: true }).superRefine((data, ctx) => {
  if (data.type === 'stop_set' && data.start_policy?.type === 'hard') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['start_policy', 'type'],
      message: 'Stop-set segments cannot use a hard start policy — only flexible is allowed.',
    });
  }
});
export type ClockSegmentPatch = z.infer<typeof ClockSegmentPatchSchema>;

// ============ RUNDOWN ============

export const RUNDOWN_SEGMENT_TYPES = ['news', 'bulletin', 'voice_track'] as const;
export type RundownSegmentType = (typeof RUNDOWN_SEGMENT_TYPES)[number];

// Segment types that use shared show-content playlist (cursor-based sequential playback)
export const SHOW_CONTENT_SEGMENT_TYPES = ['news', 'bulletin'] as const;
export type ShowContentSegmentType = (typeof SHOW_CONTENT_SEGMENT_TYPES)[number];

export const RundownAssignmentUpsertSchema = z.object({
  date:          z.string().min(1),
  time_start:    z.string().min(1),
  clock_id:      z.number().int().positive(),
  segment_index: z.number().int().nonnegative(),
  media_id:      z.number().int().positive().nullable(),
  notes:         z.string().nullable().optional(),
});
export type RundownAssignmentUpsert = z.infer<typeof RundownAssignmentUpsertSchema>;

export const RundownDurationOverrideUpsertSchema = z.object({
  date:             z.string().min(1),
  time_start:       z.string().min(1),
  clock_id:         z.number().int().positive(),
  segment_index:    z.number().int().nonnegative(),
  duration_seconds: z.number().int().positive(),
});
export type RundownDurationOverrideUpsert = z.infer<typeof RundownDurationOverrideUpsertSchema>;

export const RundownShowContentUpsertSchema = z.object({
  date:         z.string().min(1),
  time_start:   z.string().min(1),
  clock_id:     z.number().int().positive(),
  segment_type: z.enum(['news', 'bulletin']),
  playlist_id:  z.number().int().positive(),
});
export type RundownShowContentUpsert = z.infer<typeof RundownShowContentUpsertSchema>;

// join_top: always start clock at segment 0; join_mid: skip ahead to the segment
// that matches the current wall-clock minute (preserves break-time alignment).
export const JOIN_POLICIES = ['join_top', 'join_mid'] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

export const ClockSegmentSummarySchema = z.object({
  id: z.number().int(),
  sort_order: z.number().int().nonnegative(),
  name: z.string(),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive(),
  // true only for news/bulletin segments whose sources include 'recording'
  is_rundown: z.boolean().default(false),
});
export type ClockSegmentSummary = z.infer<typeof ClockSegmentSummarySchema>;

export const ClockSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  // Playlist for station_id sweepers; shared across all segments on this clock
  station_id_playlist_id: z.number().int().nullable(),
  // Jingle playlist for unassigned clocks (assigned clocks use show.jingle_playlist_id)
  jingle_playlist_id: z.number().int().nullable(),
  join_policy: z.enum(JOIN_POLICIES).nullable(),
  duration_seconds: z.number().int().nonnegative(),
  // Derived: populated by the API on read; not stored.
  used: z.boolean().default(false),
  slot_count: z.number().int().nonnegative().default(0),
  // Shows that have this clock set as their default_clock_id
  assigned_shows: z.array(z.object({ id: z.number().int(), name: z.string(), jingle_playlist_id: z.number().int().nullable(), bed_playlist_id: z.number().int().nullable() })).default([]),
  // Lightweight segment list for calendar/template visualization (type + duration only).
  segments: z.array(ClockSegmentSummarySchema).default([]),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Clock = z.infer<typeof ClockSchema>;

export const ClockCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  station_id_playlist_id: z.number().int().positive().nullable().optional(),
  jingle_playlist_id: z.number().int().positive().nullable().optional(),
  join_policy: z.enum(JOIN_POLICIES).nullable().optional(),
});
export type ClockCreate = z.infer<typeof ClockCreateSchema>;

export const ClockPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  station_id_playlist_id: z.number().int().positive().nullable().optional(),
  jingle_playlist_id: z.number().int().positive().nullable().optional(),
  join_policy: z.enum(JOIN_POLICIES).nullable().optional(),
});
export type ClockPatch = z.infer<typeof ClockPatchSchema>;

// ============ BROADCAST INTERVALS ============

export const BroadcastIntervalSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  default_start_time: z.string(),
  default_end_time: z.string(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type BroadcastInterval = z.infer<typeof BroadcastIntervalSchema>;

export const BroadcastIntervalCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  color: z.string().default('#818cf8'),
  default_start_time: z.string().min(1),
  default_end_time: z.string().min(1),
});
export type BroadcastIntervalCreate = z.infer<typeof BroadcastIntervalCreateSchema>;

export const BroadcastIntervalPatchSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  default_start_time: z.string().optional(),
  default_end_time: z.string().optional(),
});
export type BroadcastIntervalPatch = z.infer<typeof BroadcastIntervalPatchSchema>;

export const BroadcastIntervalSlotSchema = z.object({
  id: z.number().int(),
  interval_id: z.number().int(),
  day_of_week: z.number().int().min(1).max(7),
  start_time: z.string(),
  end_time: z.string(),
  created_at: z.coerce.date(),
});
export type BroadcastIntervalSlot = z.infer<typeof BroadcastIntervalSlotSchema>;

export const BroadcastIntervalSlotCreateSchema = z.object({
  interval_id: z.number().int().positive(),
  day_of_week: z.number().int().min(1).max(7),
  start_time: z.string().min(1),
  end_time: z.string().min(1),
});
export type BroadcastIntervalSlotCreate = z.infer<typeof BroadcastIntervalSlotCreateSchema>;

export const BroadcastIntervalSlotPatchSchema = z.object({
  start_time: z.string().optional(),
  end_time: z.string().optional(),
});
export type BroadcastIntervalSlotPatch = z.infer<typeof BroadcastIntervalSlotPatchSchema>;

// ============ CAMPAIGNS ============

export const PRIORITY_LEVELS = ['hard', 'best_effort'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const FIRST_IN_SLOT_MODES = ['always', 'at_least_one', 'at_least_one_shared'] as const;
export type FirstInSlotMode = (typeof FIRST_IN_SLOT_MODES)[number];

export const CampaignSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  name: z.string(),
  starts_on: z.string(),
  ends_on: z.string(),
  plays_per_month: z.number().int().positive(),
  duration_bracket: z.number().int().refine(v => [10,20,30,40,50,60,70,80,90].includes(v), { message: 'Must be 10–90s in 10s steps' }),
  max_plays_per_day: z.number().int().positive().nullable(),
  sweeps_per_month: z.number().int().nonnegative().nullable(),
  max_sweeps_per_day: z.number().int().positive().nullable(),
  time_window_start: z.string().nullable(),
  time_window_end: z.string().nullable(),
  days_of_week: z.string().nullable(),
  advertiser_separation_spots: z.number().int().nonnegative().default(1),
  competing_exclusions: z.array(z.number().int()).default([]),
  priority: z.enum(PRIORITY_LEVELS).default('hard'),
  interval_id: z.number().int().nullable(),
  interval_plays_per_week: z.number().int().positive().nullable(),
  show_id: z.number().int().nullable(),
  plays_per_show: z.number().int().positive().nullable(),
  first_in_slot: z.boolean().default(false),
  first_in_slot_mode: z.enum(FIRST_IN_SLOT_MODES).nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const CampaignCreateSchema = z.object({
  customer_id: z.number().int().positive(),
  name: z.string().min(1, 'Campaign name is required'),
  starts_on: z.string().min(1, 'Start date required').refine(
    (v) => v >= new Date().toISOString().slice(0, 10),
    'Start date cannot be in the past',
  ),
  ends_on: z.string().min(1, 'End date required'),
  plays_per_month: z.number().int().positive('Must be at least 1'),
  duration_bracket: z.number().int().refine(v => [10,20,30,40,50,60,70,80,90].includes(v), { message: 'Must be 10–90s in 10s steps' }),
  max_plays_per_day: z.number().int().positive().nullable().optional(),
  sweeps_per_month: z.number().int().nonnegative().nullable().optional(),
  max_sweeps_per_day: z.number().int().positive().nullable().optional(),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  advertiser_separation_spots: z.number().int().nonnegative().default(1),
  competing_exclusions: z.array(z.number().int()).default([]),
  priority: z.enum(PRIORITY_LEVELS).default('hard'),
  interval_id: z.number().int().positive().nullable().optional(),
  interval_plays_per_week: z.number().int().positive().nullable().optional(),
  show_id: z.number().int().positive().nullable().optional(),
  plays_per_show: z.number().int().positive().nullable().optional(),
  first_in_slot: z.boolean().default(false),
  first_in_slot_mode: z.enum(FIRST_IN_SLOT_MODES).nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type CampaignCreate = z.infer<typeof CampaignCreateSchema>;

export const CampaignPatchSchema = z.object({
  name: z.string().min(1).optional(),
  starts_on: z.string().optional(),
  ends_on: z.string().optional(),
  plays_per_month: z.number().int().positive().optional(),
  duration_bracket: z.number().int().refine(v => [10,20,30,40,50,60,70,80,90].includes(v), { message: 'Must be 10–90s in 10s steps' }).optional(),
  max_plays_per_day: z.number().int().positive().nullable().optional(),
  sweeps_per_month: z.number().int().nonnegative().nullable().optional(),
  max_sweeps_per_day: z.number().int().positive().nullable().optional(),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  advertiser_separation_spots: z.number().int().nonnegative().optional(),
  competing_exclusions: z.array(z.number().int()).optional(),
  priority: z.enum(PRIORITY_LEVELS).optional(),
  interval_id: z.number().int().positive().nullable().optional(),
  interval_plays_per_week: z.number().int().positive().nullable().optional(),
  show_id: z.number().int().positive().nullable().optional(),
  plays_per_show: z.number().int().positive().nullable().optional(),
  first_in_slot: z.boolean().optional(),
  first_in_slot_mode: z.enum(FIRST_IN_SLOT_MODES).nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type CampaignPatch = z.infer<typeof CampaignPatchSchema>;

export const CampaignWithCustomerSchema = CampaignSchema.extend({
  customer_name: z.string(),
});
export type CampaignWithCustomer = z.infer<typeof CampaignWithCustomerSchema>;

export const CampaignPacingSchema = z.object({
  plays_this_month: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  pct: z.number().min(0).max(100),
  on_track: z.boolean(),
});
export type CampaignPacing = z.infer<typeof CampaignPacingSchema>;

// ============ MUSIC CAMPAIGNS ============
// Parallel to spot Campaign — promotes specific songs (a playlist of contracted
// music) at a per-day target rate within a date interval. Delivered during
// music segments whose rotation has heavy_rotation_enabled = true. Simpler
// than spot campaigns: no time windows, advertiser separation, first-in-slot,
// exclusions, or interval scoping. Just per-day plays and a date range.

export const MusicCampaignSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  name: z.string(),
  playlist_id: z.number().int(),
  starts_on: z.string(),
  ends_on: z.string(),
  plays_per_day: z.number().int().positive(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type MusicCampaign = z.infer<typeof MusicCampaignSchema>;

export const MusicCampaignCreateSchema = z.object({
  customer_id: z.number().int().positive(),
  name: z.string().min(1, 'Campaign name is required'),
  playlist_id: z.number().int().positive(),
  starts_on: z.string().min(1, 'Start date required'),
  ends_on: z.string().min(1, 'End date required'),
  plays_per_day: z.number().int().positive('Must be at least 1'),
  notes: z.string().nullable().optional(),
});
export type MusicCampaignCreate = z.infer<typeof MusicCampaignCreateSchema>;

export const MusicCampaignPatchSchema = z.object({
  name: z.string().min(1).optional(),
  playlist_id: z.number().int().positive().optional(),
  starts_on: z.string().optional(),
  ends_on: z.string().optional(),
  plays_per_day: z.number().int().positive().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type MusicCampaignPatch = z.infer<typeof MusicCampaignPatchSchema>;

export const MusicCampaignWithCustomerSchema = MusicCampaignSchema.extend({
  customer_name: z.string(),
  playlist_name: z.string(),
});
export type MusicCampaignWithCustomer = z.infer<typeof MusicCampaignWithCustomerSchema>;

export const MusicCampaignPacingSchema = z.object({
  plays_today: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  pct: z.number().min(0).max(200), // can exceed 100 when over-pacing
  on_track: z.boolean(),
});
export type MusicCampaignPacing = z.infer<typeof MusicCampaignPacingSchema>;

// ============ PROMOS ============

export const PromoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  show_id: z.number().int().nullable(),
  starts_on: z.string(),
  ends_on: z.string(),
  min_plays_per_day: z.number().int().positive(),
  max_plays_per_day: z.number().int().positive(),
  no_air_during_show: z.boolean().default(false),
  active: z.boolean(),
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Promo = z.infer<typeof PromoSchema>;

export const PromoCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  show_id: z.number().int().positive().nullable().optional(),
  starts_on: z.string().min(1, 'Start date required'),
  ends_on: z.string().min(1, 'End date required'),
  min_plays_per_day: z.number().int().positive().default(1),
  max_plays_per_day: z.number().int().positive().default(3),
  no_air_during_show: z.boolean().default(false),
  notes: z.string().nullable().optional(),
});
export type PromoCreate = z.infer<typeof PromoCreateSchema>;

export const PromoPatchSchema = z.object({
  name: z.string().min(1).optional(),
  show_id: z.number().int().positive().nullable().optional(),
  starts_on: z.string().optional(),
  ends_on: z.string().optional(),
  min_plays_per_day: z.number().int().positive().optional(),
  max_plays_per_day: z.number().int().positive().optional(),
  no_air_during_show: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});
export type PromoPatch = z.infer<typeof PromoPatchSchema>;

export const PromoWithShowSchema = PromoSchema.extend({
  show_name: z.string().nullable(),
});
export type PromoWithShow = z.infer<typeof PromoWithShowSchema>;

export const PromoMediaSchema = z.object({
  id: z.number().int(),
  promo_id: z.number().int(),
  media_id: z.number().int(),
  created_at: z.coerce.date(),
});
export type PromoMedia = z.infer<typeof PromoMediaSchema>;

export const PromoMediaWithMediaSchema = PromoMediaSchema.extend({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  original_filename: z.string().nullable(),
});
export type PromoMediaWithMedia = z.infer<typeof PromoMediaWithMediaSchema>;

// ============ CAMPAIGN MEDIA ============

export const CampaignMediaSchema = z.object({
  id: z.number().int(),
  campaign_id: z.number().int(),
  media_id: z.number().int(),
  play_as_spot: z.boolean().default(true),
  play_as_sweep: z.boolean().default(false),
  created_at: z.coerce.date(),
});
export type CampaignMedia = z.infer<typeof CampaignMediaSchema>;

export const CampaignMediaCreateSchema = z.object({
  media_id: z.number().int().positive(),
  play_as_spot: z.boolean().default(true),
  play_as_sweep: z.boolean().default(false),
});
export type CampaignMediaCreate = z.infer<typeof CampaignMediaCreateSchema>;

export const CampaignMediaWithMediaSchema = CampaignMediaSchema.extend({
  title: z.string().nullable(),
  artist: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  original_filename: z.string().nullable(),
});
export type CampaignMediaWithMedia = z.infer<typeof CampaignMediaWithMediaSchema>;

// ============ CUSTOMERS ============

export const CustomerSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  account_manager_id: z.number().int().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CustomerCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  account_manager_id: z.number().int().nullable().optional(),
});
export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;

export const CustomerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
  account_manager_id: z.number().int().nullable().optional(),
});
export type CustomerPatch = z.infer<typeof CustomerPatchSchema>;

// ============ CONTACTS ============

export const ContactSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int().nullable(),
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactCreateSchema = z.object({
  customer_id: z.number().int().positive().optional(),
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactCreate = z.infer<typeof ContactCreateSchema>;

export const ContactPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactPatch = z.infer<typeof ContactPatchSchema>;

export const CustomerContactSchema = z.object({
  customer_id: z.number().int(),
  contact_id: z.number().int(),
  is_primary: z.boolean(),
});
export type CustomerContact = z.infer<typeof CustomerContactSchema>;

// ============ SHOWS ============

export const SHOW_COLORS = [
  'indigo', 'violet', 'cyan', 'emerald', 'amber', 'rose', 'orange', 'teal',
] as const;
export type ShowColor = (typeof SHOW_COLORS)[number];

// What to play when there is no clock assigned to cover a time slot within the show's interval
// (e.g. a DJ extends the show past the last assigned clock hour).
// repeat_last_clock: tile the last clock again for the extra time.
// fall_through: keep playing content sources without clock structure.
export const EXTENSION_POLICIES = ['repeat_last_clock', 'fall_through'] as const;
export type ExtensionPolicy = (typeof EXTENSION_POLICIES)[number];

export const ShowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  host: z.string().nullable(),
  producer: z.string().nullable(),
  default_clock_id: z.number().int().nullable(),
  jingle_playlist_id: z.number().int().nullable(),
  bed_playlist_id: z.number().int().nullable(),
  show_start_playlist_id: z.number().int().nullable(),
  show_end_playlist_id: z.number().int().nullable(),
  duration_minutes: z.number().int().min(30).max(720),
  // null = station default (repeat_last_clock)
  extension_policy: z.enum(EXTENSION_POLICIES).nullable(),
  color: z.enum(SHOW_COLORS),
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Show = z.infer<typeof ShowSchema>;

export const ShowCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().nullable().optional(),
  producer: z.string().nullable().optional(),
  default_clock_id: z.number().int().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).default(60),
  extension_policy: z.enum(EXTENSION_POLICIES).nullable().optional(),
  color: z.enum(SHOW_COLORS).default('indigo'),
  notes: z.string().nullable().optional(),
});
export type ShowCreate = z.infer<typeof ShowCreateSchema>;

export const ShowPatchSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().nullable().optional(),
  producer: z.string().nullable().optional(),
  default_clock_id: z.number().int().nullable().optional(),
  jingle_playlist_id: z.number().int().nullable().optional(),
  bed_playlist_id: z.number().int().nullable().optional(),
  show_start_playlist_id: z.number().int().positive().nullable().optional(),
  show_end_playlist_id: z.number().int().positive().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).optional(),
  extension_policy: z.enum(EXTENSION_POLICIES).nullable().optional(),
  color: z.enum(SHOW_COLORS).optional(),
  notes: z.string().nullable().optional(),
});
export type ShowPatch = z.infer<typeof ShowPatchSchema>;

// ============ TEMPLATE ENTRIES ============

export const TemplateEntrySchema = z.object({
  id: z.number().int(),
  day_of_week: z.number().int().min(1).max(7),
  time_start: z.string(),
  time_end: z.string(),
  show_id: z.number().int().nullable(),
  clock_id: z.number().int().nullable(),
  orphaned_show_name: z.string().nullable().optional(),
  orphaned_clock_name: z.string().nullable().optional(),
});
export type TemplateEntry = z.infer<typeof TemplateEntrySchema>;

export const TemplateEntryCreateSchema = z.object({
  day_of_week: z.number().int().min(1).max(7),
  time_start: z.string().min(1),
  time_end: z.string().min(1),
  show_id: z.number().int().nullable().optional(),
  clock_id: z.number().int().nullable().optional(),
});
export type TemplateEntryCreate = z.infer<typeof TemplateEntryCreateSchema>;

export const TemplateEntryPatchSchema = z.object({
  time_start: z.string().optional(),
  time_end: z.string().optional(),
  day_of_week: z.number().int().min(1).max(7).optional(),
  show_id: z.number().int().nullable().optional(),
  clock_id: z.number().int().nullable().optional(),
});
export type TemplateEntryPatch = z.infer<typeof TemplateEntryPatchSchema>;

// ============ CALENDAR ENTRIES ============

export const CalendarEntrySchema = z.object({
  id: z.number().int(),
  date: z.string(),
  time_start: z.string(),
  time_end: z.string(),
  show_id: z.number().int().nullable(),
  clock_id: z.number().int().nullable(),
  orphaned_show_name: z.string().nullable().optional(),
  orphaned_clock_name: z.string().nullable().optional(),
  is_override: z.boolean(),
});
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

export const CalendarEntryCreateSchema = z.object({
  date: z.string().min(1),
  time_start: z.string().min(1),
  time_end: z.string().min(1),
  show_id: z.number().int().nullable().optional(),
  clock_id: z.number().int().nullable().optional(),
  is_override: z.boolean().default(false),
});
export type CalendarEntryCreate = z.infer<typeof CalendarEntryCreateSchema>;

export const CalendarEntryPatchSchema = z.object({
  show_id: z.number().int().nullable().optional(),
  clock_id: z.number().int().nullable().optional(),
  is_override: z.boolean().optional(),
  time_start: z.string().optional(),
  time_end: z.string().optional(),
  date: z.string().optional(),
});
export type CalendarEntryPatch = z.infer<typeof CalendarEntryPatchSchema>;

// ============ TEMPLATE / CALENDAR ENTRY BATCH APPLY (Decision 55) ============
//
// A staged editing session (SchedulePage.tsx) accumulates these locally and
// posts them as one batch on "Apply" — one DB transaction, one reconcile
// call, instead of one round-trip (and one reconcile, per Decision 54) per
// edit. The client squashes pending edits per row (mirroring the clock-
// segment negative-temp-id convention from Decision 52 for `create`'s id),
// so every row is represented by at most one op — `update`/`delete` always
// target a real, already-persisted row; they never need to reference a
// same-batch `create`'s temp id.

export const TemplateEntryBatchOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), tempId: z.number().int().negative(), data: TemplateEntryCreateSchema }),
  z.object({ kind: z.literal('update'), id: z.number().int().positive(), patch: TemplateEntryPatchSchema }),
  z.object({ kind: z.literal('delete'), id: z.number().int().positive() }),
]);
export type TemplateEntryBatchOp = z.infer<typeof TemplateEntryBatchOpSchema>;

export const TemplateEntryBatchRequestSchema = z.object({
  ops: z.array(TemplateEntryBatchOpSchema).min(1),
});
export type TemplateEntryBatchRequest = z.infer<typeof TemplateEntryBatchRequestSchema>;

export const CalendarEntryBatchOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('create'), tempId: z.number().int().negative(), data: CalendarEntryCreateSchema }),
  z.object({ kind: z.literal('update'), id: z.number().int().positive(), patch: CalendarEntryPatchSchema }),
  z.object({ kind: z.literal('delete'), id: z.number().int().positive() }),
]);
export type CalendarEntryBatchOp = z.infer<typeof CalendarEntryBatchOpSchema>;

export const CalendarEntryBatchRequestSchema = z.object({
  ops: z.array(CalendarEntryBatchOpSchema).min(1),
});
export type CalendarEntryBatchRequest = z.infer<typeof CalendarEntryBatchRequestSchema>;

// tempId keys are serialized as strings (JSON object keys are always strings).
export const EntryBatchResponseSchema = z.object({
  ok: z.boolean(),
  id_map: z.record(z.string(), z.number()),
});
export type EntryBatchResponse = z.infer<typeof EntryBatchResponseSchema>;

// ============ TEMPLATE CLOCK ENTRIES ============

export const TemplateClockEntrySchema = z.object({
  id: z.number().int(),
  day_of_week: z.number().int().min(1).max(7),
  hour: z.number().int().min(0).max(23),
  clock_id: z.number().int(),
});
export type TemplateClockEntry = z.infer<typeof TemplateClockEntrySchema>;

export const TemplateClockEntryUpsertSchema = z.object({
  day_of_week: z.number().int().min(1).max(7),
  hour: z.number().int().min(0).max(23),
  clock_id: z.number().int(),
});
export type TemplateClockEntryUpsert = z.infer<typeof TemplateClockEntryUpsertSchema>;

// ============ APPLY TEMPLATE ============

export const ApplyTemplateSchema = z.object({
  date_from: z.string().min(1),
  date_to:   z.string().min(1),
  mode:      z.enum(['fill', 'override']),
});
export type ApplyTemplate = z.infer<typeof ApplyTemplateSchema>;

// ============ RECORDINGS ============

export const RECORDING_STATUSES = ['pending', 'ready', 'played'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const RecordingSchema = z.object({
  id: z.number().int(),
  show_id: z.number().int(),
  broadcast_date: z.string(),
  media_id: z.number().int().nullable(),
  status: z.enum(RECORDING_STATUSES),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Recording = z.infer<typeof RecordingSchema>;

// ============ USERS ============

export const UserSchema = z.object({
  id: z.number().int(),
  first_name: z.string(),
  last_name: z.string(),
  account_name: z.string().nullable(),
  email: z.string().email().nullable(),
  title: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

export const UserCreateSchema = z.object({
  first_name: z.string().min(1, 'First name is required'),
  last_name: z.string().min(1, 'Last name is required'),
  account_name: z.string().min(1, 'Account name is required'),
  email: z.string().email('Invalid email').nullable().optional(),
  title: z.string().nullable().optional(),
});
export type UserCreate = z.infer<typeof UserCreateSchema>;

export const UserPatchSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  account_name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  title: z.string().nullable().optional(),
});
export type UserPatch = z.infer<typeof UserPatchSchema>;

// ============ SPOT BUDGET ============

export const BudgetModeSchema = z.enum(['estimated', 'remaining']);
export type BudgetMode = z.infer<typeof BudgetModeSchema>;

export const BudgetSchema = z.object({
  minutes: z.number(),
  breaks: z.number(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const BudgetCutsSchema = z.object({
  global: BudgetSchema,
  byInterval: z.record(z.string(), BudgetSchema),
  byShow: z.record(z.string(), BudgetSchema),
});
export type BudgetCuts = z.infer<typeof BudgetCutsSchema>;

export const SpotBudgetInventorySchema = z.object({
  raw: BudgetCutsSchema,
  effective: BudgetCutsSchema,
  promoMargin: z.number(),
});
export type SpotBudgetInventory = z.infer<typeof SpotBudgetInventorySchema>;

export const CampaignDemandEntrySchema = z.object({
  campaignId: z.string(),
  minutes: z.number(),
  firstSlotBreaks: z.number(),
  scope: z.union([
    z.literal('global'),
    z.object({ intervalId: z.string() }),
    z.object({ showId: z.string() }),
  ]),
});
export type CampaignDemandEntry = z.infer<typeof CampaignDemandEntrySchema>;

export const SpotBudgetDemandSchema = z.object({
  totals: BudgetCutsSchema,
  byCampaign: z.array(CampaignDemandEntrySchema),
});
export type SpotBudgetDemand = z.infer<typeof SpotBudgetDemandSchema>;

export const SpotBudgetOverviewSchema = z.object({
  inventory: SpotBudgetInventorySchema,
  demand: SpotBudgetDemandSchema,
  available: BudgetCutsSchema,
});
export type SpotBudgetOverview = z.infer<typeof SpotBudgetOverviewSchema>;

export const CampaignAvailableSchema = z.object({
  available: BudgetSchema,
  firstSlotAvailable: z.number().optional(),
  nonCompeteReduction: BudgetSchema.optional(),
  pacing: z.object({
    expectedToDate: z.number(),
    actualToDate: z.number(),
    delta: z.number(),
    totalPlanned: z.number(),
    remaining: z.number(),
  }),
});
export type CampaignAvailable = z.infer<typeof CampaignAvailableSchema>;

export const CampaignPacingDetailSchema = z.object({
  expectedToDate: z.number(),
  actualToDate: z.number(),
  delta: z.number(),
  totalPlanned: z.number(),
  remaining: z.number(),
});
export type CampaignPacingDetail = z.infer<typeof CampaignPacingDetailSchema>;

// ─── Station Settings ─────────────────────────────────────────────────────────

export const StationSettingsSchema = z.object({
  promo_margin: z.number().min(0).max(0.5),
  // Station-wide fallback clock, resolved when no calendar/template entry
  // covers the current moment. Nullable only until configured — the
  // supervisor treats an unset default clock as a startup misconfiguration.
  default_clock_id: z.number().int().nullable(),
});
export type StationSettings = z.infer<typeof StationSettingsSchema>;

export const StationSettingsPatchSchema = StationSettingsSchema.partial();
export type StationSettingsPatch = z.infer<typeof StationSettingsPatchSchema>;
