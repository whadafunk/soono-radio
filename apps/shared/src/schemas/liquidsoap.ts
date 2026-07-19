import { z } from 'zod';

// Codec + bitrate options — bitrates are codec-dependent. The UI offers
// a codec dropdown that filters the bitrate dropdown.
export const CODECS = ['mp3', 'aac', 'opus', 'vorbis'] as const;
export type Codec = (typeof CODECS)[number];

export const CODEC_BITRATES: Record<Codec, number[]> = {
  mp3: [96, 128, 192, 256, 320],
  aac: [64, 96, 128, 160, 192],
  opus: [32, 64, 96, 128, 160],
  vorbis: [96, 128, 160, 192, 256],
};

export const CROSSFADE_TYPES = ['linear', 'smart', 'logarithmic'] as const;
export type CrossfadeType = (typeof CROSSFADE_TYPES)[number];

// Common integrated-loudness targets. target_lufs accepts any number — these
// are just the presets offered in the Settings UI dropdown.
export const LUFS_PRESETS: { label: string; value: number }[] = [
  { label: 'EBU R128 (Broadcast) — −23 LUFS', value: -23 },
  { label: 'Apple Music / Streaming — −16 LUFS', value: -16 },
  { label: 'Spotify / YouTube — −14 LUFS', value: -14 },
];

export const LiquidsoapConfigSchema = z.object({
  output: z.object({
    icecast_port: z.number().int().min(1).max(65535).default(8001),
    icecast_mount: z.string().min(1).default('/stream'),
    codec: z.enum(CODECS).default('mp3'),
    bitrate_kbps: z.number().int().min(8).max(512).default(128),
  }),
  harbor: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8005),
    mount_name: z.string().min(1).default('live'),
    password: z.string().min(1),
    tls: z.object({
      enabled: z.boolean().default(false),
      certificate_path: z.string().nullable().default(null),
    }).default({}),
  }),
  crossfade: z.object({
    duration_seconds: z.number().nonnegative().max(30).default(3),
    type: z.enum(CROSSFADE_TYPES).default('linear'),
  }),
  master_bus: z.object({
    soft_limiter: z.boolean().default(false),
    threshold_db: z.number().max(0).default(-1.0),
    ratio: z.number().min(1).default(20.0),
    attack_ms: z.number().positive().default(5.0),
    release_ms: z.number().positive().default(50.0),
  }).default({}),
  loudness_normalization: z.object({
    enabled: z.boolean().default(false),
    target_lufs: z.number().default(-23),
  }).default({}),
  ducking: z.object({
    enabled: z.boolean().default(false),
    depth_db: z.number().min(-30).max(0).default(-9),
    attack_ms: z.number().int().min(1).max(2000).default(100),
    release_ms: z.number().int().min(1).max(10000).default(1000),
  }).default({}),
  silence_detection: z.object({
    threshold_seconds: z.number().int().min(1).max(60).default(5),
    fallback: z.enum(['none', 'playlist']).default('none'),
    fallback_playlist_id: z.number().int().positive().nullable().default(null),
  }).default({}),
  logging: z.object({
    level: z.number().int().min(1).max(5).default(3),
    file_enabled: z.boolean().default(true),
  }).default({}),
});

export type LiquidsoapConfig = z.infer<typeof LiquidsoapConfigSchema>;

export const LiquidsoapStatusSchema = z.object({
  on_air: z.enum(['live', 'automation', 'none']),
  current_source: z.string().nullable(),
  reachable: z.boolean(),
});

export type LiquidsoapStatus = z.infer<typeof LiquidsoapStatusSchema>;
