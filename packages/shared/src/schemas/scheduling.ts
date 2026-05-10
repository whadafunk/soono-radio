import { z } from 'zod';

// ============ DELAY POLICY ============

export const DelayPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hard') }),
  z.object({
    type: z.literal('soft'),
    plus_seconds: z.number().int().nonnegative().default(30),
    minus_seconds: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal('postpone'),
    max_plus_seconds: z.number().int().positive(),
    minus_seconds: z.number().int().nonnegative().default(0),
  }),
]);
export type DelayPolicy = z.infer<typeof DelayPolicySchema>;

// ============ SWEEP CONFIG ============

export const SWEEP_SOURCES = ['jingle', 'promo', 'spot'] as const;
export type SweepSource = (typeof SWEEP_SOURCES)[number];

export const SweepConfigSchema = z.object({
  per_hour: z.number().int().min(0).max(20),
  over: z.array(z.enum(['music', 'commercial', 'jingle', 'promo', 'news', 'live', 'silence'])),
  min_gap_minutes: z.number().int().min(1),
  sources: z.array(z.enum(SWEEP_SOURCES)),
});
export type SweepConfig = z.infer<typeof SweepConfigSchema>;

// ============ SEGMENT SOURCE ============

export const SEGMENT_SOURCE_TYPES = [
  'show_playlist',
  'show_jingles',
  'show_beds',
  'show_promos',
  'playlist',
  'campaigns',
  'live',
  'recording',
] as const;
export type SegmentSourceType = (typeof SEGMENT_SOURCE_TYPES)[number];

export const SegmentSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('show_playlist'), tier: z.string().optional() }),
  z.object({ type: z.literal('show_jingles') }),
  z.object({ type: z.literal('show_beds') }),
  z.object({ type: z.literal('show_promos') }),
  z.object({ type: z.literal('playlist'), playlist_id: z.number().int().positive() }),
  z.object({ type: z.literal('campaigns') }),
  z.object({ type: z.literal('live') }),
  z.object({ type: z.literal('recording') }),
]);
export type SegmentSource = z.infer<typeof SegmentSourceSchema>;

// ============ RECOVERY TACTICS ============

export const RECOVERY_TACTICS = ['trim_outro', 'skip_song', 'drop_queued'] as const;
export type RecoveryTactic = (typeof RECOVERY_TACTICS)[number];

// ============ CLOCKS ============

export const CLOCK_SEGMENT_TYPES = [
  'music',
  'commercial',
  'jingle',
  'promo',
  'news',
  'live',
  'silence',
] as const;
export type ClockSegmentType = (typeof CLOCK_SEGMENT_TYPES)[number];

export const ClockSegmentSchema = z.object({
  id: z.number().int(),
  clock_id: z.number().int(),
  sort_order: z.number().int().nonnegative(),
  name: z.string(),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive(),

  source_type: z.enum(SEGMENT_SOURCE_TYPES),
  source_playlist_id: z.number().int().nullable(),
  source_rotation_id: z.number().int().nullable(),
  source_tier: z.string().nullable(),

  filler_sources: z.array(SegmentSourceSchema).default([]),
  mix_ratio: z.object({ every_n: z.number().int().positive(), from_filler_index: z.number().int().nonnegative() }).nullable(),
  fallback_source: SegmentSourceSchema.nullable(),

  start_clip_playlist_id: z.number().int().nullable(),
  end_clip_playlist_id: z.number().int().nullable(),

  bed_playlist_id: z.number().int().nullable(),
  blocks_live_override: z.boolean(),

  delay_policy: DelayPolicySchema,
  recovery_tactics: z.array(z.enum(RECOVERY_TACTICS)).default([]),
});
export type ClockSegment = z.infer<typeof ClockSegmentSchema>;

export const ClockSegmentCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_seconds: z.number().int().positive('Duration must be at least 1 second'),
  sort_order: z.number().int().nonnegative().default(0),

  source_type: z.enum(SEGMENT_SOURCE_TYPES),
  source_playlist_id: z.number().int().positive().nullable().optional(),
  source_rotation_id: z.number().int().positive().nullable().optional(),
  source_tier: z.string().nullable().optional(),

  filler_sources: z.array(SegmentSourceSchema).default([]),
  mix_ratio: z.object({ every_n: z.number().int().positive(), from_filler_index: z.number().int().nonnegative() }).nullable().optional(),
  fallback_source: SegmentSourceSchema.nullable().optional(),

  start_clip_playlist_id: z.number().int().positive().nullable().optional(),
  end_clip_playlist_id: z.number().int().positive().nullable().optional(),

  bed_playlist_id: z.number().int().positive().nullable().optional(),
  blocks_live_override: z.boolean().default(false),

  delay_policy: DelayPolicySchema.default({ type: 'soft', plus_seconds: 30, minus_seconds: 0 }),
  recovery_tactics: z.array(z.enum(RECOVERY_TACTICS)).default([]),
});
export type ClockSegmentCreate = z.infer<typeof ClockSegmentCreateSchema>;

export const ClockSegmentPatchSchema = ClockSegmentCreateSchema.partial().omit({ sort_order: true });
export type ClockSegmentPatch = z.infer<typeof ClockSegmentPatchSchema>;

export const ClockSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  sweep_config: SweepConfigSchema.nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Clock = z.infer<typeof ClockSchema>;

export const ClockCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  sweep_config: SweepConfigSchema.nullable().optional(),
});
export type ClockCreate = z.infer<typeof ClockCreateSchema>;

export const ClockPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  sweep_config: SweepConfigSchema.nullable().optional(),
});
export type ClockPatch = z.infer<typeof ClockPatchSchema>;

// ============ CAMPAIGNS ============

export const PRIORITY_LEVELS = ['hard', 'best_effort'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const FIRST_IN_SLOT_MODES = ['always', 'at_least_one', 'at_least_one_preferred'] as const;
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
  priority: z.enum(PRIORITY_LEVELS).default('best_effort'),
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
  priority: z.enum(PRIORITY_LEVELS).default('best_effort'),
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
  play_as_sweep: z.boolean().default(false),
  created_at: z.coerce.date(),
});
export type CampaignMedia = z.infer<typeof CampaignMediaSchema>;

export const CampaignMediaCreateSchema = z.object({
  media_id: z.number().int().positive(),
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
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Customer = z.infer<typeof CustomerSchema>;

export const CustomerCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type CustomerCreate = z.infer<typeof CustomerCreateSchema>;

export const CustomerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
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

export const SHOW_TYPES = ['live', 'automated', 'prerecorded'] as const;
export type ShowType = (typeof SHOW_TYPES)[number];

export const SHOW_COLORS = [
  'indigo', 'violet', 'cyan', 'emerald', 'amber', 'rose', 'orange', 'teal',
] as const;
export type ShowColor = (typeof SHOW_COLORS)[number];

export const ShowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  host: z.string().nullable(),
  producer: z.string().nullable(),
  type: z.enum(SHOW_TYPES),
  default_clock_id: z.number().int().nullable(),
  intro_media_id: z.number().int().nullable(),
  outro_media_id: z.number().int().nullable(),
  duration_minutes: z.number().int().min(30).max(720),
  color: z.enum(SHOW_COLORS),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Show = z.infer<typeof ShowSchema>;

export const ShowCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().nullable().optional(),
  producer: z.string().nullable().optional(),
  type: z.enum(SHOW_TYPES).default('automated'),
  default_clock_id: z.number().int().nullable().optional(),
  intro_media_id: z.number().int().positive().nullable().optional(),
  outro_media_id: z.number().int().positive().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).default(60),
  color: z.enum(SHOW_COLORS).default('indigo'),
  notes: z.string().nullable().optional(),
});
export type ShowCreate = z.infer<typeof ShowCreateSchema>;

export const ShowPatchSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().nullable().optional(),
  producer: z.string().nullable().optional(),
  type: z.enum(SHOW_TYPES).optional(),
  default_clock_id: z.number().int().nullable().optional(),
  intro_media_id: z.number().int().positive().nullable().optional(),
  outro_media_id: z.number().int().positive().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).optional(),
  color: z.enum(SHOW_COLORS).optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
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
