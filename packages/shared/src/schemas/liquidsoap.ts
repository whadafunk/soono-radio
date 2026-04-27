import { z } from 'zod';

export const LiquidsoapConfigSchema = z.object({
  output: z.object({
    icecast_host: z.string().min(1).default('host.docker.internal'),
    icecast_port: z.number().int().min(1).max(65535).default(8001),
    icecast_mount: z.string().min(1).default('/stream'),
  }),
  harbor: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(8005),
    mount_name: z.string().min(1).default('live'),
    password: z.string().min(1),
  }),
  automation: z.object({
    mode: z.enum(['silence', 'playlist']).default('silence'),
    playlist_dir: z.string().default('/audio/automation'),
  }),
  crossfade: z.object({
    duration_seconds: z.number().nonnegative().max(30).default(3),
  }),
});

export type LiquidsoapConfig = z.infer<typeof LiquidsoapConfigSchema>;

export const LiquidsoapStatusSchema = z.object({
  on_air: z.enum(['live', 'automation', 'none']),
  current_source: z.string().nullable(),
  reachable: z.boolean(),
});

export type LiquidsoapStatus = z.infer<typeof LiquidsoapStatusSchema>;
