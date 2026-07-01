import { z } from 'zod';

export const JOB_TYPES = ['lookup_id', 'analyse', 're-transcode'] as const;
export const JOB_STATUSES = ['running', 'completed', 'review_pending', 'done'] as const;

// Candidate stored inside a skipped item so the UI can offer choices
export const StoredCandidateSchema = z.object({
  acoustid: z.string(),
  score: z.number(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  year: z.number().nullable(),
  source: z.enum(['acoustid', 'musicbrainz', 'filename', 'artist-confirmed']),
  fromFreeText: z.boolean().optional(),
});
export type StoredCandidate = z.infer<typeof StoredCandidateSchema>;

// Per-item result shapes stored in results_json
export const LookupIdResultsSchema = z.object({
  applied: z.array(z.object({
    id: z.number(),
    filename: z.string(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    album: z.string().nullable(),
    year: z.number().nullable(),
    score: z.number(),
  })),
  skipped: z.array(z.object({
    id: z.number(),
    filename: z.string(),
    reason: z.string(),
    candidates: z.array(StoredCandidateSchema),
    resolved: z.boolean().default(false),
  })),
  failed: z.array(z.object({
    id: z.number(),
    filename: z.string(),
    error: z.string(),
  })),
});
export type LookupIdResults = z.infer<typeof LookupIdResultsSchema>;

export const AnalyseResultsSchema = z.object({
  succeeded: z.array(z.object({ id: z.number(), filename: z.string() })),
  failed: z.array(z.object({ id: z.number(), filename: z.string(), error: z.string() })),
});
export type AnalyseResults = z.infer<typeof AnalyseResultsSchema>;

// The job summary returned by the list/detail API
export const BackgroundJobSchema = z.object({
  id: z.string(),
  type: z.enum(JOB_TYPES),
  label: z.string(),
  status: z.enum(JOB_STATUSES),
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  review_pending: z.number().int(),
  results_json: z.string().nullable(),
  created_at: z.coerce.date(),
  completed_at: z.coerce.date().nullable(),
});
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

export const ActivityStatsSchema = z.object({
  running: z.number().int(),
  review_pending: z.number().int(),
});
export type ActivityStats = z.infer<typeof ActivityStatsSchema>;
