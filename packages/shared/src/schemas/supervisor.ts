import { z } from 'zod';

export const PLAY_SOURCES = ['auto', 'live', 'manual'] as const;
export type PlaySource = (typeof PLAY_SOURCES)[number];
export const PlaySourceSchema = z.enum(PLAY_SOURCES);

export const PlayHistorySchema = z.object({
  id: z.number().int(),
  media_id: z.number().int().nullable(),
  source: PlaySourceSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  aborted: z.boolean(),
  live_listener_count: z.number().int().nullable(),
  pick_reason: z.string().nullable(),
});
export type PlayHistory = z.infer<typeof PlayHistorySchema>;

export const SupervisorStatusSchema = z.object({
  running: z.boolean(),
  reachable: z.boolean(),
  queue_depth: z.number().int().nonnegative(),
  on_air_source: z.enum(['live', 'auto', 'none']),
  current_play_id: z.number().int().nullable(),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatusSchema>;

/** Display shape returned by /supervisor/now-playing — joined with media for titles. */
export const NowPlayingSchema = z
  .object({
    id: z.number().int(),
    media_id: z.number().int().nullable(),
    source: PlaySourceSchema,
    started_at: z.coerce.date(),
    live_listener_count: z.number().int().nullable(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    original_filename: z.string().nullable(),
    duration_seconds: z.number().nullable(),
  })
  .nullable();
export type NowPlaying = z.infer<typeof NowPlayingSchema>;

/** Recent-plays row (one per /supervisor/recent-plays). */
export const RecentPlaySchema = z.object({
  id: z.number().int(),
  media_id: z.number().int().nullable(),
  source: PlaySourceSchema,
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
  aborted: z.boolean(),
  live_listener_count: z.number().int().nullable(),
  pick_reason: z.string().nullable(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  original_filename: z.string().nullable(),
  duration_seconds: z.number().nullable(),
});
export type RecentPlay = z.infer<typeof RecentPlaySchema>;
