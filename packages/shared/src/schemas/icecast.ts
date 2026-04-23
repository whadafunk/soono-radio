import { z } from 'zod';

export const IcecastConfigSchema = z.object({
  server: z.object({
    location: z.string().default(''),
    admin: z.string().email().default('admin@localhost'),
    hostname: z.string().default('localhost'),
  }),
  network: z.object({
    port: z.number().int().min(1).max(65535).default(8000),
    bind_address: z.string().default('0.0.0.0'),
  }),
  authentication: z.object({
    source_password: z.string().min(1),
    relay_password: z.string().min(1),
    admin_user: z.string().default('admin'),
    admin_password: z.string().min(1),
  }),
  limits: z.object({
    max_sources: z.number().int().min(1).default(10),
    max_clients: z.number().int().min(1).default(500),
    max_queue_size: z.number().int().default(524288),
    burst_size: z.number().int().default(65536),
  }),
  mount_default: z.object({
    name: z.string().default('/stream'),
    max_listeners: z.number().int().min(-1).default(-1),
    fallback_mount: z.string().optional(),
  }),
  logging: z.object({
    loglevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    access_log: z.string().default('/var/log/icecast/access.log'),
    error_log: z.string().default('/var/log/icecast/error.log'),
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
