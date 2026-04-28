import { z } from 'zod';

export const MEDIA_CATEGORIES = [
  'music',
  'jingle',
  'ad',
  'intro',
  'promo',
  'voice',
  'bed',
  'recording',
] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];
export const MediaCategorySchema = z.enum(MEDIA_CATEGORIES);

export const INGEST_STATUSES = [
  'queued',
  'analyzing',
  'transcoding',
  'completed',
  'failed',
] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];
export const IngestStatusSchema = z.enum(INGEST_STATUSES);

// Media row as returned by the API (timestamps as Date so the wire format
// is JSON-serialisable but typed as Date here for clarity).
export const MediaSchema = z.object({
  id: z.number().int(),
  sha256: z.string().length(64),
  category: MediaCategorySchema,

  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  genre: z.string().nullable(),
  year: z.number().int().nullable(),
  notes: z.string().nullable(),

  original_filename: z.string(),
  duration_seconds: z.number().nonnegative(),
  bitrate_kbps: z.number().int().nonnegative(),
  samplerate_hz: z.number().int().positive(),
  channels: z.number().int().min(1).max(8),
  filesize_bytes: z.number().int().nonnegative(),
  was_transcoded: z.boolean(),

  loudness_lufs: z.number().nullable(),
  loudness_lra: z.number().nullable(),
  loudness_peak: z.number().nullable(),
  loudness_gain_db: z.number().nullable(),
  loudness_warning: z.string().nullable(),

  cue_in_seconds: z.number().nullable(),
  cue_out_seconds: z.number().nullable(),
  intro_seconds: z.number().nullable(),
  outro_seconds: z.number().nullable(),

  play_count: z.number().int().nonnegative(),
  last_played_at: z.coerce.date().nullable(),
  favorite: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Media = z.infer<typeof MediaSchema>;

// Editable subset — operator can change these via PATCH /library/:id.
export const MediaPatchSchema = z.object({
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
  genre: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  category: MediaCategorySchema.optional(),
  favorite: z.boolean().optional(),
  cue_in_seconds: z.number().nullable().optional(),
  cue_out_seconds: z.number().nullable().optional(),
  intro_seconds: z.number().nullable().optional(),
  outro_seconds: z.number().nullable().optional(),
});
export type MediaPatch = z.infer<typeof MediaPatchSchema>;

export const IngestJobSchema = z.object({
  id: z.string(),
  status: IngestStatusSchema,
  uploaded_filename: z.string(),
  uploaded_size_bytes: z.number().int().nonnegative(),
  staging_path: z.string(),
  category: MediaCategorySchema,
  detected_format: z.string().nullable(),
  detected_bitrate: z.number().int().nullable(),
  needs_transcode: z.boolean().nullable(),
  measured_lufs: z.number().nullable(),
  measured_lra: z.number().nullable(),
  measured_peak: z.number().nullable(),
  media_id: z.number().int().nullable(),
  error_message: z.string().nullable(),
  created_at: z.coerce.date(),
  started_at: z.coerce.date().nullable(),
  completed_at: z.coerce.date().nullable(),
});
export type IngestJob = z.infer<typeof IngestJobSchema>;
