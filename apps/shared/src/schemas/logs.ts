import { z } from 'zod';

// ─── Log sources ──────────────────────────────────────────────────────────────
// 'structured' sources are pino JSON-lines files the API itself writes;
// 'text' sources are plain-text files written by other containers (LiquidSoap,
// Icecast) that the API can only read via bind mounts.
export const LOG_SOURCE_IDS = [
  'supervisor',
  'api',
  'liquidsoap',
  'icecast-error',
  'icecast-access',
] as const;
export const LogSourceIdSchema = z.enum(LOG_SOURCE_IDS);
export type LogSourceId = z.infer<typeof LogSourceIdSchema>;

export const LogSourceInfoSchema = z.object({
  id: LogSourceIdSchema,
  label: z.string(),
  kind: z.enum(['structured', 'text']),
  available: z.boolean(),
  file: z.string().nullable(),
  size_bytes: z.number(),
  modified_at_ms: z.number().nullable(),
  rotated_files: z.array(z.object({ name: z.string(), size_bytes: z.number() })),
  // Only sources whose write stream the API owns can be force-rotated;
  // everything can be purged (truncate + delete rotated files).
  can_rotate: z.boolean(),
});
export type LogSourceInfo = z.infer<typeof LogSourceInfoSchema>;

export const LogSourcesResponseSchema = z.object({
  sources: z.array(LogSourceInfoSchema),
});
export type LogSourcesResponse = z.infer<typeof LogSourcesResponseSchema>;

// ─── Tail ─────────────────────────────────────────────────────────────────────
export const LogTailQuerySchema = z.object({
  source: LogSourceIdSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  // pino numeric levels: 20 debug, 30 info, 40 warn, 50 error.
  level_min: z.coerce.number().int().optional(),
  // Comma-separated list of `process` field values (structured sources only).
  process: z.string().optional(),
  // Case-insensitive substring over the `event` field.
  event: z.string().optional(),
  // Case-insensitive substring over the whole raw line — this is what makes
  // "everything about plan 8617" work, since structured lines carry plan_id.
  q: z.string().optional(),
});
export type LogTailQuery = z.infer<typeof LogTailQuerySchema>;

export const LogEntrySchema = z.object({
  ts_ms: z.number().nullable(),
  level: z.number().nullable(),
  process: z.string().nullable(),
  event: z.string().nullable(),
  msg: z.string(),
  // Full original line, so the UI can show every structured field on expand.
  raw: z.string(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const LogTailResponseSchema = z.object({
  source: LogSourceIdSchema,
  // Oldest → newest within the returned window.
  entries: z.array(LogEntrySchema),
  file_size_bytes: z.number(),
  // How far back into the file this tail actually looked — filters only see
  // this window, not the whole file.
  scanned_bytes: z.number(),
});
export type LogTailResponse = z.infer<typeof LogTailResponseSchema>;

// ─── Settings ─────────────────────────────────────────────────────────────────
// One cap for every source: the API-owned streams rotate on the write that
// crosses it; the hourly sweep archives+truncates external files over it.
export const LogSettingsSchema = z.object({
  max_file_size_mb: z.number().int().min(1).max(500),
  rotated_files_kept: z.number().int().min(1).max(9),
});
export type LogSettings = z.infer<typeof LogSettingsSchema>;

// ─── Maintenance actions ──────────────────────────────────────────────────────
export const LogMaintenanceRequestSchema = z.object({
  source: LogSourceIdSchema,
});
export type LogMaintenanceRequest = z.infer<typeof LogMaintenanceRequestSchema>;

export const LogMaintenanceResponseSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type LogMaintenanceResponse = z.infer<typeof LogMaintenanceResponseSchema>;
