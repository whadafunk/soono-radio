import { z } from 'zod';

// ============ PLAYLISTS ============

export const PLAYLIST_TYPES = ['music', 'jingle', 'bed', 'promo', 'spot'] as const;
export type PlaylistType = (typeof PLAYLIST_TYPES)[number];

export const PLAYLIST_KINDS = ['static', 'dynamic'] as const;
export type PlaylistKind = (typeof PLAYLIST_KINDS)[number];

// ── Dynamic rule schema ───────────────────────────────────────────────────────

export const DYNAMIC_RULE_FIELDS = [
  'genre', 'artist', 'album', 'year',
  'duration_seconds', 'bpm',
  'mood', 'energy_level', 'danceability_level',
  'tags',
] as const;
export type DynamicRuleField = (typeof DYNAMIC_RULE_FIELDS)[number];

export const DYNAMIC_RULE_OPS = ['eq', 'contains', 'in', 'any_of', 'all_of', 'between', 'gte', 'lte'] as const;
export type DynamicRuleOp = (typeof DYNAMIC_RULE_OPS)[number];

export const MoodConditionValue = z.object({
  moods: z.array(z.string()),
  min_score: z.number().min(0).max(1),
});
export type MoodConditionValue = z.infer<typeof MoodConditionValue>;

export const DynamicRuleConditionSchema = z.object({
  field: z.enum(DYNAMIC_RULE_FIELDS),
  op: z.enum(DYNAMIC_RULE_OPS),
  value: z.union([
    z.string(),
    z.number(),
    z.array(z.union([z.string(), z.number()])),
    MoodConditionValue,
  ]),
});
export type DynamicRuleCondition = z.infer<typeof DynamicRuleConditionSchema>;

export const DynamicRulesSchema = z.object({
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(DynamicRuleConditionSchema).default([]),
});
export type DynamicRules = z.infer<typeof DynamicRulesSchema>;

// ─────────────────────────────────────────────────────────────────────────────

export const PlaylistSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  type: z.enum(PLAYLIST_TYPES),
  kind: z.enum(PLAYLIST_KINDS),
  rules: DynamicRulesSchema.nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});
export type Playlist = z.infer<typeof PlaylistSchema>;

export const PlaylistCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().nullable().optional(),
  type: z.enum(PLAYLIST_TYPES),
  kind: z.enum(PLAYLIST_KINDS).default('static'),
  rules: DynamicRulesSchema.nullable().optional(),
});
export type PlaylistCreate = z.infer<typeof PlaylistCreateSchema>;

export const PlaylistPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  rules: DynamicRulesSchema.nullable().optional(),
});
export type PlaylistPatch = z.infer<typeof PlaylistPatchSchema>;

// ── Preview result (dynamic playlists) ───────────────────────────────────────

export const PlaylistPreviewSchema = z.object({
  count: z.number().int(),
  sample: z.array(z.object({
    id: z.number().int(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    duration_seconds: z.number(),
    category: z.string(),
  })),
});
export type PlaylistPreview = z.infer<typeof PlaylistPreviewSchema>;

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

export const PlaylistMediaBulkAddSchema = z.object({
  media_ids: z.array(z.number().int().positive()).min(1).max(200),
});
export type PlaylistMediaBulkAdd = z.infer<typeof PlaylistMediaBulkAddSchema>;

export const PlaylistMediaPatchSchema = z.object({
  sort_order: z.number().int().nonnegative().optional(),
  weight: z.number().int().positive().optional(),
});
export type PlaylistMediaPatch = z.infer<typeof PlaylistMediaPatchSchema>;

export const PlaylistTracksReorderSchema = z.array(z.object({
  id: z.number().int(),
  sort_order: z.number().int().nonnegative(),
}));
export type PlaylistTracksReorder = z.infer<typeof PlaylistTracksReorderSchema>;

// ============ MEDIA TAGS ============

export const MediaTagSchema = z.object({
  media_id: z.number().int(),
  tag: z.string().min(1),
});
export type MediaTag = z.infer<typeof MediaTagSchema>;

export const MediaTagsUpdateSchema = z.object({
  tags: z.array(z.string().min(1)),
});
export type MediaTagsUpdate = z.infer<typeof MediaTagsUpdateSchema>;

// ============ ROTATIONS ============

export const ROTATION_TYPES = [
  'random_separation',
  'least_recently_played',
  'round_robin',
  'weighted',
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

export const RotationParamsSchema = z.union([
  RandomSeparationParamsSchema,
  LeastRecentlyPlayedParamsSchema,
  RoundRobinParamsSchema,
  WeightedParamsSchema,
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
  playlist_name: z.string(),
  rotation_tier: z.string().nullable(),
  rotation_id: z.number().int().nullable(),
  fallback_tier: z.string().nullable(),
  sort_order: z.number().int().nonnegative(),
  weight: z.number().int().positive(),
});
export type ShowPlaylist = z.infer<typeof ShowPlaylistSchema>;

export const ShowPlaylistCreateSchema = z.object({
  playlist_id: z.number().int().positive(),
  weight: z.number().int().positive().optional(),
  rotation_tier: z.string().nullable().optional(),
  rotation_id: z.number().int().positive().nullable().optional(),
  fallback_tier: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});
export type ShowPlaylistCreate = z.infer<typeof ShowPlaylistCreateSchema>;

export const ShowPlaylistPatchSchema = z.object({
  weight: z.number().int().positive().optional(),
  rotation_tier: z.string().nullable().optional(),
  rotation_id: z.number().int().positive().nullable().optional(),
  fallback_tier: z.string().nullable().optional(),
  sort_order: z.number().int().nonnegative().optional(),
});
export type ShowPlaylistPatch = z.infer<typeof ShowPlaylistPatchSchema>;
