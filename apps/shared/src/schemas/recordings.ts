import { z } from 'zod';

// Reports → Recordings (docs/reports-recordings-design.md).

// Retention settings — take effect at the next sweep, no restart. Recording
// quality and file length are part of the mix engine's own config
// (LiquidsoapConfigSchema.recording) because they need a mix engine restart.
export const RecordingSettingsSchema = z.object({
  // Recordings older than this are deleted automatically.
  retention_days: z.number().int().min(1).max(3650).default(60),
  // Below this much free disk the oldest recordings go first…
  min_free_gb: z.number().min(0).max(10000).default(10),
  // …but never one younger than this: the sweep warns instead.
  protected_days: z.number().int().min(0).max(3650).default(30),
}).refine((s) => s.protected_days <= s.retention_days, {
  message: 'The protected age cannot be longer than the retention',
  path: ['protected_days'],
});
export type RecordingSettings = z.infer<typeof RecordingSettingsSchema>;

export const RecordingHoldCreateSchema = z.object({
  from_ms: z.number().int().nonnegative(),
  to_ms: z.number().int().nonnegative(),
  note: z.string().trim().min(1, 'Say why this period is kept').max(200),
}).refine((h) => h.to_ms > h.from_ms, { message: 'The end must be after the start', path: ['to_ms'] });
export type RecordingHoldCreate = z.infer<typeof RecordingHoldCreateSchema>;

export interface RecordingHold {
  id: number;
  from_ms: number;
  to_ms: number;
  note: string;
  created_at_ms: number;
}

export type RecordingGapLabel = 'off_air' | 'interruption' | 'no_recording';

export type RecordingDayItem =
  | {
      kind: 'file';
      day: string;
      name: string;
      start_ms: number;
      end_ms: number;
      size_bytes: number;
      recording_now: boolean;
      held: boolean;
    }
  | { kind: 'gap'; start_ms: number; end_ms: number; label: RecordingGapLabel };

export interface RecordingDayResponse {
  date: string;      // station-local YYYY-MM-DD
  timezone: string;
  items: RecordingDayItem[];
  holds: RecordingHold[];
}

export interface RecordingSweepResult {
  at_ms: number;
  deleted_retention: number;
  deleted_disk_floor: number;
  floor_unmet: boolean;
}

export type RecordingHealthReason = 'ok' | 'disabled' | 'off_air' | 'mix_engine_down' | 'not_recording';

export interface BroadcastRecordingStatus {
  enabled: boolean;
  on_air: boolean;
  mix_engine_running: boolean;
  healthy: boolean;
  reason: RecordingHealthReason;
  newest_file_age_s: number | null;
  used_bytes: number;
  free_bytes: number | null;
  oldest_start_ms: number | null;
  last_sweep: RecordingSweepResult | null;
  // The retention settings file exists but cannot be read. Automatic
  // deletion is paused until the settings are saved again.
  settings_damaged: boolean;
}

export interface RecordingRangePreview {
  parts: number;
  covered_ms: number;
  gaps: Array<{ start_ms: number; end_ms: number }>;
}

export interface RecordingDeleteResult {
  deleted: number;
  skipped_held: number;
  skipped_active: number;
}

export const RecordingPurgeSchema = z.object({
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-24'),
});
