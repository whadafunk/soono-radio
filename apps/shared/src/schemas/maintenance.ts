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
  plans_deleted: z.number(),
  plan_items_deleted: z.number(),
  stop_set_estimates_deleted: z.number(),
  live_events_deleted: z.number(),
  vacuumed: z.boolean(),
});
export type DbSweepResult = z.infer<typeof DbSweepResultSchema>;

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
