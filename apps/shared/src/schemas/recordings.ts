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

// Flags on a recording — a fixed set, in display order. Only `protect` changes
// behaviour (automatic clean-up and every delete skip the recording); the
// others are labels to filter by. docs/reports-recordings-list-design.md.
export const RECORDING_FLAGS = ['protect', 'review', 'incident', 'sent_to_authority', 'marked_for_deletion'] as const;
export type RecordingFlag = (typeof RECORDING_FLAGS)[number];

export const RECORDING_FLAG_LABELS: Record<RecordingFlag, string> = {
  protect: 'Protect',
  review: 'Review',
  incident: 'Incident',
  sent_to_authority: 'Sent to authority',
  marked_for_deletion: 'Marked for deletion',
};

export interface RecordingFlagEntry {
  flag: RecordingFlag;
  note: string;
}

// A recording as a request names it: its UTC date folder and file name. The
// API checks both before anything touches the disk.
export const RecordingRefSchema = z.object({ day: z.string(), name: z.string() });
export type RecordingRef = z.infer<typeof RecordingRefSchema>;

export const MAX_RECORDING_SELECTION = 10_000;

export const RecordingSelectionSchema = z.object({
  files: z.array(RecordingRefSchema).min(1, 'Select at least one recording').max(MAX_RECORDING_SELECTION, 'Too many recordings selected'),
});
export type RecordingSelection = z.infer<typeof RecordingSelectionSchema>;

export const RecordingFlagChangeSchema = RecordingSelectionSchema.extend({
  flag: z.enum(RECORDING_FLAGS),
  set: z.boolean(),
  note: z.string().trim().max(200, 'A note can be at most 200 characters').optional(),
});
export type RecordingFlagChange = z.infer<typeof RecordingFlagChangeSchema>;

export type RecordingGapLabel = 'off_air' | 'interruption' | 'no_recording';

export type RecordingListItem =
  | {
      kind: 'file';
      day: string;       // UTC date folder
      name: string;      // file name inside it
      start_ms: number;
      end_ms: number;
      size_bytes: number;
      recording_now: boolean;
      flags: RecordingFlagEntry[];
    }
  | { kind: 'gap'; start_ms: number; end_ms: number; label: RecordingGapLabel };

// One station day. The three totals describe the whole day and are never
// changed by filtering (recordingFilters.ts) — a filtered list must still
// say how much of the day is missing.
export interface RecordingPeriodDay {
  date: string;            // station-local YYYY-MM-DD
  recorded_ms: number;
  no_recording_ms: number;
  size_bytes: number;
  items: RecordingListItem[];
}

export const MAX_RECORDING_PERIOD_DAYS = 366;

export interface RecordingPeriodResponse {
  from: string;
  to: string;
  timezone: string;
  days: RecordingPeriodDay[]; // newest first
}

// What an archive of a selection would contain.
export interface RecordingArchivePreview {
  files: number;
  size_bytes: number;
  skipped_active: number;   // still being recorded
  skipped_missing: number;  // no longer on disk
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
  skipped_protected: number;
  skipped_active: number;
}

export const RecordingPurgeSchema = z.object({
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-24'),
});
