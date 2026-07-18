import { z } from 'zod';

// ─── Database retention ───────────────────────────────────────────────────────
// Operational records (plans, plan_items, stop_set_estimates, live_events)
// are deleted past a retention window. play_history is deliberately NOT
// covered — it is ground truth for campaign reports and rotation state, and
// gets no retention knob until the D96 delivery ledger aggregates it.
// Regardless of the configured days, the sweep never deletes anything newer
// than the start of the PREVIOUS calendar month, so the current reporting
// period is structurally safe.
export const MaintenanceSettingsSchema = z.object({
  plans_retention_days: z.number().int().min(35).max(3650),
});
export type MaintenanceSettings = z.infer<typeof MaintenanceSettingsSchema>;

export const DbSweepResultSchema = z.object({
  at_ms: z.number(),
  cutoff_ms: z.number(),
  // Non-terminal plans whose clock instance was >24h past, flipped to
  // 'completed' (rows preserved) — restores the invariant that a
  // non-terminal status means "current or upcoming". Default for sweep
  // results recorded before this field existed.
  plans_retired: z.number().default(0),
  plans_deleted: z.number(),
  plan_items_deleted: z.number(),
  stop_set_estimates_deleted: z.number(),
  live_events_deleted: z.number(),
  vacuumed: z.boolean(),
});
export type DbSweepResult = z.infer<typeof DbSweepResultSchema>;

// ─── Media integrity ──────────────────────────────────────────────────────────
// Decode-based library verification (operator-triggered sweep + ingest gate).
// 'truncated' / 'duration_over': the container header lied about the length —
// duration_seconds gets auto-corrected to the decoded truth, and the flag
// stays sticky so the operator knows the content itself is cut short.
export const MEDIA_INTEGRITY_STATUSES = [
  'ok',
  'truncated',
  'duration_over',
  'decode_errors',
  'missing',
  'hash_mismatch',
] as const;
export const MediaIntegrityStatusSchema = z.enum(MEDIA_INTEGRITY_STATUSES);
export type MediaIntegrityStatus = z.infer<typeof MediaIntegrityStatusSchema>;

export const MediaIntegrityFindingSchema = z.object({
  media_id: z.number().int(),
  display_name: z.string(),
  category: z.string(),
  status: MediaIntegrityStatusSchema,
  detail: z.string(),
  duration_corrected: z.boolean(),
});
export type MediaIntegrityFinding = z.infer<typeof MediaIntegrityFindingSchema>;

export const MediaIntegritySweepResultSchema = z.object({
  at_ms: z.number(),
  finished_at_ms: z.number().nullable(),
  total: z.number(),
  checked: z.number(),
  flagged: z.number(),
  duration_corrected: z.number(),
  // Capped server-side; `flagged` is the true count.
  findings: z.array(MediaIntegrityFindingSchema),
  error: z.string().nullable(),
});
export type MediaIntegritySweepResult = z.infer<typeof MediaIntegritySweepResultSchema>;

export const MediaIntegrityStateSchema = z.object({
  running: z.boolean(),
  // Progress of the in-flight run (null when idle).
  current: MediaIntegritySweepResultSchema.nullable(),
  // Last completed run (persisted across restarts).
  last: MediaIntegritySweepResultSchema.nullable(),
  // Live count of media rows currently flagged (status set and not 'ok').
  flagged_in_library: z.number(),
});
export type MediaIntegrityState = z.infer<typeof MediaIntegrityStateSchema>;

export const DbStatsSchema = z.object({
  file_size_bytes: z.number(),
  counts: z.object({
    plans: z.number(),
    plan_items: z.number(),
    play_history: z.number(),
    stop_set_estimates: z.number(),
    live_events: z.number(),
  }),
  settings: MaintenanceSettingsSchema,
  last_sweep: DbSweepResultSchema.nullable(),
});
export type DbStats = z.infer<typeof DbStatsSchema>;
