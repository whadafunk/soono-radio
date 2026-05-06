import { z } from 'zod';

// ============ CLOCKS ============

export const CLOCK_SEGMENT_TYPES = ['music', 'ad', 'jingle', 'news', 'live', 'promo', 'silence'] as const;
export type ClockSegmentType = (typeof CLOCK_SEGMENT_TYPES)[number];

export const ClockSegmentSchema = z.object({
  id: z.string(),
  type: z.enum(CLOCK_SEGMENT_TYPES),
  duration_minutes: z.number().int().min(1).max(59),
  label: z.string().nullable(),
});
export type ClockSegment = z.infer<typeof ClockSegmentSchema>;

export const ClockSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  segments: z.array(ClockSegmentSchema),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Clock = z.infer<typeof ClockSchema>;

export const ClockCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  segments: z.array(ClockSegmentSchema).default([]),
});
export type ClockCreate = z.infer<typeof ClockCreateSchema>;

export const ClockPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  segments: z.array(ClockSegmentSchema).optional(),
});
export type ClockPatch = z.infer<typeof ClockPatchSchema>;

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

// ============ CONTRACTS ============

export const PRIORITY_LEVELS = ['hard', 'standard', 'soft'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];

export const INTERVAL_OPTIONS = ['prime', 'regular', 'night'] as const;
export type IntervalOption = (typeof INTERVAL_OPTIONS)[number];

export const INDUSTRY_OPTIONS = ['retail', 'automotive', 'food_beverage', 'healthcare'] as const;
export type IndustryOption = (typeof INDUSTRY_OPTIONS)[number];

export const ContractSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  name: z.string(),
  starts_on: z.string(), // ISO date "2026-06-01"
  ends_on: z.string(),
  plays_per_month: z.number().int().positive(),
  time_window_start: z.string().nullable(), // "06:00"
  time_window_end: z.string().nullable(), // "22:00"
  days_of_week: z.string().nullable(), // "1,2,3,4,5"
  separation_minutes: z.number().int().nonnegative().default(90),
  advertiser_separation_min: z.number().int().nonnegative().default(30),
  priority: z.enum(PRIORITY_LEVELS).default('standard'),
  interval: z.enum(INTERVAL_OPTIONS).nullable().optional(),
  industry: z.enum(INDUSTRY_OPTIONS).nullable().optional(),
  first_slot: z.boolean().optional(),
  notes: z.string().nullable(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Contract = z.infer<typeof ContractSchema>;

export const ContractCreateSchema = z.object({
  customer_id: z.number().int().positive(),
  name: z.string().min(1, 'Contract name is required'),
  starts_on: z.string().min(1, 'Start date required'),
  ends_on: z.string().min(1, 'End date required'),
  plays_per_month: z.number().int().positive('Must be at least 1'),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  separation_minutes: z.number().int().nonnegative().default(90),
  advertiser_separation_min: z.number().int().nonnegative().default(30),
  priority: z.enum(PRIORITY_LEVELS).default('standard'),
  interval: z.enum(INTERVAL_OPTIONS).nullable().optional(),
  industry: z.enum(INDUSTRY_OPTIONS).nullable().optional(),
  first_slot: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});
export type ContractCreate = z.infer<typeof ContractCreateSchema>;

export const ContractPatchSchema = z.object({
  name: z.string().min(1).optional(),
  starts_on: z.string().optional(),
  ends_on: z.string().optional(),
  plays_per_month: z.number().int().positive().optional(),
  time_window_start: z.string().nullable().optional(),
  time_window_end: z.string().nullable().optional(),
  days_of_week: z.string().nullable().optional(),
  separation_minutes: z.number().int().nonnegative().optional(),
  advertiser_separation_min: z.number().int().nonnegative().optional(),
  priority: z.enum(PRIORITY_LEVELS).optional(),
  interval: z.enum(INTERVAL_OPTIONS).nullable().optional(),
  industry: z.enum(INDUSTRY_OPTIONS).nullable().optional(),
  first_slot: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type ContractPatch = z.infer<typeof ContractPatchSchema>;

// Contract with customer name denormalized for display
export const ContractWithCustomerSchema = ContractSchema.extend({
  customer_name: z.string(),
});
export type ContractWithCustomer = z.infer<typeof ContractWithCustomerSchema>;

// Pacing info for a contract
export const ContractPacingSchema = z.object({
  plays_this_month: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  pct: z.number().min(0).max(100),
  on_track: z.boolean(),
});
export type ContractPacing = z.infer<typeof ContractPacingSchema>;

// ============ CONTACTS ============

export const ContactSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int().nullable(), // null = not tied to a single customer
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(), // "Account Manager", "Technical Contact", etc.
  notes: z.string().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ContactCreateSchema = z.object({
  customer_id: z.number().int().positive().optional(), // optional — association handled separately
  name: z.string().min(1, 'Name is required'),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactCreate = z.infer<typeof ContactCreateSchema>;

// ============ SHOWS ============

export const SHOW_TYPES = ['live', 'automated', 'prerecorded'] as const;
export type ShowType = (typeof SHOW_TYPES)[number];

export const SHOW_COLORS = ['indigo', 'violet', 'cyan', 'emerald', 'amber', 'rose', 'orange', 'teal'] as const;
export type ShowColor = (typeof SHOW_COLORS)[number];

export const ShowSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  host: z.string().nullable(),
  producer: z.string().nullable(),
  type: z.enum(SHOW_TYPES),
  clock_id: z.number().int().nullable(),
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
  clock_id: z.number().int().nullable().optional(),
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
  clock_id: z.number().int().nullable().optional(),
  duration_minutes: z.number().int().min(30).max(720).optional(),
  color: z.enum(SHOW_COLORS).optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
export type ShowPatch = z.infer<typeof ShowPatchSchema>;

// ============ TEMPLATE ENTRIES ============

export const TemplateEntrySchema = z.object({
  id: z.number().int(),
  day_of_week: z.number().int().min(1).max(7), // 1=Mon, 7=Sun
  time_start: z.string(),  // "06:00"
  time_end: z.string(),    // "10:00"
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
  date: z.string(),        // ISO "2026-05-05"
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
// One record per (day_of_week, hour) that has an explicit clock override.
// Hours without a record fall back to the show's default clock (if a show covers that hour).

export const TemplateClockEntrySchema = z.object({
  id:          z.number().int(),
  day_of_week: z.number().int().min(1).max(7),
  hour:        z.number().int().min(0).max(23),
  clock_id:    z.number().int(),
});
export type TemplateClockEntry = z.infer<typeof TemplateClockEntrySchema>;

export const TemplateClockEntryUpsertSchema = z.object({
  day_of_week: z.number().int().min(1).max(7),
  hour:        z.number().int().min(0).max(23),
  clock_id:    z.number().int(),
});
export type TemplateClockEntryUpsert = z.infer<typeof TemplateClockEntryUpsertSchema>;

// Junction: one contact can be associated with many customers
export const CustomerContactSchema = z.object({
  customer_id: z.number().int(),
  contact_id: z.number().int(),
  is_primary: z.boolean(),
});
export type CustomerContact = z.infer<typeof CustomerContactSchema>;

export const ContactPatchSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type ContactPatch = z.infer<typeof ContactPatchSchema>;
