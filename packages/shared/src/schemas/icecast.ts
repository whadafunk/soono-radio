import { z } from 'zod';

export const MountPointSchema = z.object({
  name: z.string().min(1),
  max_listeners: z.number().int().min(-1).default(-1),
  password: z.string().optional(),
  fallback_mount: z.string().optional(),
  shoutcast_mount: z.string().optional(),
  stream_name: z.string().optional(),
  stream_description: z.string().optional(),
  stream_url: z.string().optional(),
  genre: z.string().optional(),
  bitrate: z.number().int().nonnegative().optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  public: z.boolean().optional(),
});

export type MountPoint = z.infer<typeof MountPointSchema>;

export const IcecastConfigSchema = z.object({
  server: z.object({
    hostname: z.string().min(1),
    location: z.string().default(''),
    admin: z.string().email(),
  }),
  network: z.object({
    port: z.number().int().min(1).max(65535),
    bind_address: z.string().default('0.0.0.0'),
  }),
  authentication: z.object({
    source_password: z.string().min(1),
    admin_user: z.string().min(1),
    admin_password: z.string().min(1),
  }),
  relay: z.object({
    relay_password: z.string().min(1),
    relay_servers: z.string().optional(),
  }),
  limits: z.object({
    max_sources: z.number().int().min(1).default(10),
    max_clients: z.number().int().min(1).default(500),
    max_queue_size: z.number().int().default(524288),
    burst_size: z.number().int().default(65536),
  }),
  mounts: z.array(MountPointSchema).min(1),
  logging: z.object({
    loglevel: z.enum(['debug', 'info', 'warn', 'error']),
    logsize: z.number().int().optional(),
    access_log: z.string(),
    error_log: z.string(),
  }),
});

export type IcecastConfig = z.infer<typeof IcecastConfigSchema>;

export const IcecastStatusSchema = z.object({
  listeners: z.number().int().nonnegative(),
  peak_listeners: z.number().int().nonnegative(),
  bitrate: z.number().int().nonnegative(),
  uptime_seconds: z.number().int().nonnegative(),
});

export type IcecastStatus = z.infer<typeof IcecastStatusSchema>;
