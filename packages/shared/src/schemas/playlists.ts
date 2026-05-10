import { z } from 'zod';

// ============ PLAYLISTS ============

export const PLAYLIST_TYPES = ['music', 'jingle', 'bed', 'promo', 'spot'] as const;
export type PlaylistType = (typeof PLAYLIST_TYPES)[number];

export const PlaylistSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(PLAYLIST_TYPES),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Playlist = z.infer<typeof PlaylistSchema>;

export const PlaylistCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  type: z.enum(PLAYLIST_TYPES),
});
export type PlaylistCreate = z.infer<typeof PlaylistCreateSchema>;

export const PlaylistPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
});
export type PlaylistPatch = z.infer<typeof PlaylistPatchSchema>;

// ============ PLAYLIST MEDIA ============

export const PlaylistMediaSchema = z.object({
  id: z.number().int(),
  playlist_id: z.number().int(),
  media_id: z.number().int(),
  sort_order: z.number().int().nonnegative(),
  weight: z.number().int().positive(),
});
export type PlaylistMedia = z.infer<typeof PlaylistMediaSchema>;

export const PlaylistMediaAddSchema = z.object({
  media_id: z.number().int().positive(),
  sort_order: z.number().int().nonnegative().optional(),
  weight: z.number().int().positive().default(1),
});
export type PlaylistMediaAdd = z.infer<typeof PlaylistMediaAddSchema>;

export const PlaylistMediaPatchSchema = z.object({
  sort_order: z.number().int().nonnegative().optional(),
  weight: z.number().int().positive().optional(),
});
export type PlaylistMediaPatch = z.infer<typeof PlaylistMediaPatchSchema>;

// ============ ROTATIONS ============

export const ROTATION_TYPES = [
  'random_separation',
  'least_recently_played',
  'round_robin',
  'weighted',
  'campaign',
] as const;
export type RotationType = (typeof ROTATION_TYPES)[number];

// Per-type parameter shapes — validated at runtime when reading/writing.
export const RandomSeparationParamsSchema = z.object({
  separation_minutes: z.number().int().positive().default(60),
  artist_separation_minutes: z.number().int().nonnegative().default(0),
});

export const LeastRecentlyPlayedParamsSchema = z.object({
  pool_size: z.number().int().positive().optional(),
});

export const RoundRobinParamsSchema = z.object({
  order_by: z.enum(['added_date', 'title', 'artist', 'manual']).default('added_date'),
});

export const WeightedParamsSchema = z.object({});

export const CampaignRotationParamsSchema = z.object({
  distribution: z.enum(['even_spread', 'priority_first', 'pacing']).default('even_spread'),
});

export const RotationParamsSchema = z.union([
  RandomSeparationParamsSchema,
  LeastRecentlyPlayedParamsSchema,
  RoundRobinParamsSchema,
  WeightedParamsSchema,
  CampaignRotationParamsSchema,
  z.record(z.unknown()), // catch-all for future types
]);

export const RotationSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.enum(ROTATION_TYPES),
  params: z.record(z.unknown()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Rotation = z.infer<typeof RotationSchema>;

export const RotationCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(ROTATION_TYPES),
  params: z.record(z.unknown()).default({}),
});
export type RotationCreate = z.infer<typeof RotationCreateSchema>;

export const RotationPatchSchema = z.object({
  name: z.string().min(1).optional(),
  params: z.record(z.unknown()).optional(),
});
export type RotationPatch = z.infer<typeof RotationPatchSchema>;

// ============ SHOW PLAYLISTS ============

export const ShowPlaylistSchema = z.object({
  id: z.number().int(),
  show_id: z.number().int(),
  playlist_id: z.number().int(),
  rotation_tier: z.string().nullable(),    // "hot" | "medium" | "cold" | custom
  rotation_id: z.number().int().nullable(),
  fallback_tier: z.string().nullable(),
  sort_order: z.number().int().nonnegative(),
});
export type ShowPlaylist = z.infer<typeof ShowPlaylistSchema>;

export const ShowPlaylistCreateSchema = z.object({
  playlist_id: z.number().int().positive(),
  rotation_tier: z.string().nullable().optional(),
  rotation_id: z.number().int().positive().nullable().optional(),
  fallback_tier: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().default(0),
});
export type ShowPlaylistCreate = z.infer<typeof ShowPlaylistCreateSchema>;

export const ShowPlaylistPatchSchema = z.object({
  rotation_tier: z.string().nullable().optional(),
  rotation_id: z.number().int().positive().nullable().optional(),
  fallback_tier: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});
export type ShowPlaylistPatch = z.infer<typeof ShowPlaylistPatchSchema>;
