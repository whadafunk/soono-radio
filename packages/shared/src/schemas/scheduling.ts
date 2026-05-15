import { z } from 'zod';

// ============ TIMING POLICY ============

export const StartPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hard') }),
  z.object({
    type: z.literal('soft'),
    plus_seconds: z.number().int().nonnegative().default(30),
    minus_seconds: z.number().int().nonnegative().default(0),
  }),
]);
export type StartPolicy = z.infer<typeof StartPolicySchema>;

export const TRAILING_TIME_STRATEGIES = ['skip_events', 'fill', 'early_handover', 'hard_cut_with_jingle'] as const;
export type TrailingTimeStrategy = (typeof TRAILING_TIME_STRATEGIES)[number];

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
  z.object({ type: z.literal('show_playlist'), tier: z.string().optional(), weight: z.number().int().positive().default(1), rotation: z.enum(SIMPLE_ROTATION_TYPES).optional(), rotation_id: z.number().int().positive().nullable().optional() }),
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

// ============ RECOVERY TACTICS ============

export const RECOVERY_TACTICS = ['trim_outro', 'skip_song', 'drop_queued'] as const;
export type RecoveryTactic = (typeof RECOVERY_TACTICS)[number];

// ============ SWEEPERS & LIVE ============

export const SWEEPER_TYPES = ['commercial', 'promo', 'station_id', 'jingle'] as const;
export type SweeperType = (typeof SWEEPER_TYPES)[number];

export const SILENCE_DETECTION_ACTIONS = [
  'none',
  'switch_to_music',
  'alert',
  'fade_and_switch',
] as const;
export type SilenceDetectionAction = (typeof SILENCE_DETECTION_ACTIONS)[number];

// ============ CLOCKS ============

export const CLOCK_SEGMENT_TYPES = [
  'music',
  'live',
  'live_audience',
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

  filler_playlist_id: z.number().int().nullable(),

  start_clip_playlist_id: z.number().int().nullable(),
  end_clip_playlist_id: z.number().int().nullable(),
  bed_playlist_id: z.number().int().nullable(),
  interstitial_jingle_playlist_id: z.number().int().nullable(),
  jingle_every_n_tracks: z.number().int().positive().nullable(),

  start_policy: StartPolicySchema,
  trailing_time: z.array(z.enum(TRAILING_TIME_STRATEGIES)).default([]),
  recovery_tactics: z.array(z.enum(RECOVERY_TACTICS)).default([]),

  accept_live: z.boolean(),
  // Legacy field — superseded by sweeper_config. Still returned by API for old data.
  accept_sweepers: z.array(z.enum(SWEEPER_TYPES)).default([]),
  sweeper_config: SegmentSweeperConfigSchema.nullable().default(null),
  silence_detection_action: z.enum(SILENCE_DETECTION_ACTIONS).nullable(),
  rotation_type: z.enum(SIMPLE_ROTATION_TYPES).nullable(),
});
export type ClockSegment = z.infer<typeof ClockSegmentSchema>;

export const ClockSegmentCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive('Duration must be at least 1 second'),
  sort_order: z.number().int().nonnegative().default(0),

  sources: z.array(SegmentSourceEntrySchema).default([]),

  filler_playlist_id: z.number().int().positive().nullable().optional(),

  start_clip_playlist_id: z.number().int().positive().nullable().optional(),
  end_clip_playlist_id: z.number().int().positive().nullable().optional(),
  bed_playlist_id: z.number().int().positive().nullable().optional(),
  interstitial_jingle_playlist_id: z.number().int().positive().nullable().optional(),
  jingle_every_n_tracks: z.number().int().positive().nullable().optional(),

  start_policy: StartPolicySchema.default({ type: 'soft', plus_seconds: 30, minus_seconds: 0 }),
  trailing_time: z.array(z.enum(TRAILING_TIME_STRATEGIES)).default([]),
  recovery_tactics: z.array(z.enum(RECOVERY_TACTICS)).default([]),

  accept_live: z.boolean().default(true),
  accept_sweepers: z.array(z.enum(SWEEPER_TYPES)).default([]),
  sweeper_config: SegmentSweeperConfigSchema.nullable().optional(),
  silence_detection_action: z.enum(SILENCE_DETECTION_ACTIONS).nullable().optional(),
  rotation_type: z.enum(SIMPLE_ROTATION_TYPES).nullable().optional(),
});
export type ClockSegmentCreate = z.infer<typeof ClockSegmentCreateSchema>;

export const ClockSegmentPatchSchema = ClockSegmentCreateSchema.partial().omit({ sort_order: true });
export type ClockSegmentPatch = z.infer<typeof ClockSegmentPatchSchema>;

// Handover policies — see docs/clocks-rotations-redesign.md §5
export const FINISH_POLICIES = ['hard_cut', 'finish_segment'] as const;
export type FinishPolicy = (typeof FINISH_POLICIES)[number];

export const JOIN_POLICIES = ['join_top', 'join_mid'] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

export const OVERRUN_POLICIES = ['loop_top', 'loop_mid', 'fall_through'] as const;
export type OverrunPolicy = (typeof OVERRUN_POLICIES)[number];

export const ClockSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  // Playlist for station_id sweepers; shared across all segments on this clock
  station_id_playlist_id: z.number().int().nullable(),
  // Jingle playlist for unassigned clocks (assigned clocks use show.jingle_playlist_id)
  jingle_playlist_id: z.number().int().nullable(),
  // null = inherit from supervisor config defaults
  finish_policy: z.enum(FINISH_POLICIES).nullable(),
  join_policy: z.enum(JOIN_POLICIES).nullable(),
  overrun_policy: z.enum(OVERRUN_POLICIES).nullable(),
  duration_seconds: z.number().int().nonnegative(),
  // Derived: populated by the API on read; not stored.
  used: z.boolean().default(false),
  slot_count: z.number().int().nonnegative().default(0),
  // Shows that have this clock set as their default_clock_id
  assigned_shows: z.array(z.object({ id: z.number().int(), name: z.string() })).default([]),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Clock = z.infer<typeof ClockSchema>;

export const ClockCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  station_id_playlist_id: z.number().int().positive().nullable().optional(),
  jingle_playlist_id: z.number().int().positive().nullable().optional(),
  finish_policy: z.enum(FINISH_POLICIES).nullable().optional(),
  join_policy: z.enum(JOIN_POLICIES).nullable().optional(),
  overrun_policy: z.enum(OVERRUN_POLICIES).nullable().optional(),
});
export type ClockCreate = z.infer<typeof ClockCreateSchema>;

export const ClockPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  station_id_playlist_id: z.number().int().positive().nullable().optional(),
  jingle_playlist_id: z.number().int().positive().nullable().optional(),
  finish_policy: z.enum(FINISH_POLICIES).nullable().optional(),
  join_policy: z.enum(JOIN_POLICIES).nullable().optional(),
  overrun_policy: z.enum(OVERRUN_POLICIES).nullable().optional(),
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
  starts_on: z.string().min(1, 'Start date required'),
  ends_on: z.string().min(1, 'End date required'),
  plays_per_month: z.number().int().positive('Must be at least 1'),
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

export const ShowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  host: z.string().nullable(),
  producer: z.string().nullable(),
  default_clock_id: z.number().int().nullable(),
  jingle_playlist_id: z.number().int().nullable(),
  bed_playlist_id: z.number().int().nullable(),
  intro_media_id: z.number().int().nullable(),
  outro_media_id: z.number().int().nullable(),
  duration_minutes: z.number().int().min(30).max(720),
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
  intro_media_id: z.number().int().positive().nullable().optional(),
  outro_media_id: z.number().int().positive().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).optional(),
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
