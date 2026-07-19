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

// Three increasing degrees of the master-bus soft limiter, all deliberately
// staying in "soft"/musical compressor territory (ratio caps at 8:1 — a true
// brick-wall limiter is typically 10:1+) rather than becoming a hard limiter.
export interface MasterBusPreset {
  key: 'light' | 'mid' | 'hard';
  label: string;
  threshold_db: number;
  ratio: number;
  attack_ms: number;
  release_ms: number;
}

export const MASTER_BUS_PRESETS: MasterBusPreset[] = [
  { key: 'light', label: 'Light', threshold_db: -3.0, ratio: 2.0, attack_ms: 20.0, release_ms: 200.0 },
  { key: 'mid', label: 'Mid', threshold_db: -2.0, ratio: 4.0, attack_ms: 10.0, release_ms: 100.0 },
  { key: 'hard', label: 'Hard', threshold_db: -1.0, ratio: 8.0, attack_ms: 5.0, release_ms: 50.0 },
];

// Identifies which (if any) preset the current master_bus values exactly
// match — null means the operator has manually tuned the sliders away from
// any preset ("Custom").
export function matchMasterBusPreset(
  m: { threshold_db: number; ratio: number; attack_ms: number; release_ms: number },
): MasterBusPreset | null {
  return (
    MASTER_BUS_PRESETS.find(
      (p) =>
        p.threshold_db === m.threshold_db &&
        p.ratio === m.ratio &&
        p.attack_ms === m.attack_ms &&
        p.release_ms === m.release_ms,
    ) ?? null
  );
}

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
