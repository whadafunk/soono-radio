import { z } from 'zod';
import { FINISH_POLICIES, JOIN_POLICIES } from './scheduling.js';

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
export const SupervisorConfigSchema = z.object({
  scheduler_tick_ms: z.number().int().min(500).max(60_000).default(5_000),
  metadata_poll_ms: z.number().int().min(500).max(60_000).default(5_000),
  queue_depth_threshold: z.number().int().min(1).max(20).default(1),
  separation_minutes: z.number().int().min(0).max(720).default(30),
  // Station-wide handover defaults — clocks inherit these unless they set an explicit override
  finish_policy: z.enum(FINISH_POLICIES).default('finish_segment'),
  join_policy: z.enum(JOIN_POLICIES).default('join_top'),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

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
