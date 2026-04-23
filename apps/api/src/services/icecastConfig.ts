import { parseStringPromise, Builder } from 'xml2js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';

const CONFIG_PATH = process.env.ICECAST_CONFIG || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');

export async function readIcecastConfig(): Promise<IcecastConfig> {
  const xml = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = await parseStringPromise(xml);

  const icecast = parsed.icecast;

  // Parse all mount points
  const mountsRaw = Array.isArray(icecast.mount) ? icecast.mount : [icecast.mount?.[0]];
  const mounts = (mountsRaw || []).map((mount: any) => ({
    name: mount.name?.[0] || '/stream',
    max_listeners: parseInt(mount.max_listeners?.[0] || '-1', 10),
    source_password: mount.source_password?.[0] || 'hackme',
    fallback_mount: mount.fallback_mount?.[0],
  }));

  const config: IcecastConfig = {
    server: {
      hostname: icecast.server?.[0]?.hostname?.[0] || 'localhost',
      location: icecast.server?.[0]?.location?.[0] || '',
      admin: icecast.server?.[0]?.admin?.[0] || 'admin@localhost',
    },
    network: {
      port: parseInt(icecast.port?.[0] || '8000', 10),
      bind_address: icecast.bind_address?.[0] || '0.0.0.0',
    },
    authentication: {
      admin_user: icecast.admin_user?.[0] || 'admin',
      admin_password: icecast.admin_password?.[0] || 'hackme',
    },
    relay: {
      relay_password: icecast.relay_password?.[0] || 'hackme',
      relay_servers: icecast.relay_servers?.[0],
    },
    limits: {
      max_sources: parseInt(icecast.limits?.[0]?.sources?.[0] || '10', 10),
      max_clients: parseInt(icecast.limits?.[0]?.clients?.[0] || '500', 10),
      max_queue_size: parseInt(icecast.limits?.[0]?.queue_size?.[0] || '524288', 10),
      burst_size: parseInt(icecast.limits?.[0]?.burst_size?.[0] || '65536', 10),
    },
    mounts: mounts.length > 0 ? mounts : [{ name: '/stream', max_listeners: -1, source_password: 'hackme' }],
    logging: {
      loglevel: (icecast.loglevel?.[0] || 'info') as 'debug' | 'info' | 'warn' | 'error',
      logsize: icecast.logsize?.[0] ? parseInt(icecast.logsize[0], 10) : undefined,
      access_log: icecast.accesslog?.[0] || '/usr/local/icecast/logs/access.log',
      error_log: icecast.errorlog?.[0] || '/usr/local/icecast/logs/error.log',
    },
  };

  return IcecastConfigSchema.parse(config);
}

export async function writeIcecastConfig(config: IcecastConfig): Promise<void> {
  const xmlObj = {
    icecast: {
      server: [
        {
          location: [config.server.location],
          admin: [config.server.admin],
          hostname: [config.server.hostname],
        },
      ],
      port: [config.network.port.toString()],
      bind_address: [config.network.bind_address],
      admin_user: [config.authentication.admin_user],
      admin_password: [config.authentication.admin_password],
      relay_password: [config.relay.relay_password],
      ...(config.relay.relay_servers && { relay_servers: [config.relay.relay_servers] }),
      limits: [
        {
          sources: [config.limits.max_sources.toString()],
          clients: [config.limits.max_clients.toString()],
          queue_size: [config.limits.max_queue_size.toString()],
          burst_size: [config.limits.burst_size.toString()],
        },
      ],
      mount: config.mounts.map((mount) => ({
        name: [mount.name],
        max_listeners: [mount.max_listeners.toString()],
        source_password: [mount.source_password],
        ...(mount.fallback_mount && { fallback_mount: [mount.fallback_mount] }),
      })),
      loglevel: [config.logging.loglevel],
      ...(config.logging.logsize && { logsize: [config.logging.logsize.toString()] }),
      accesslog: [config.logging.access_log],
      errorlog: [config.logging.error_log],
    },
  };

  const builder = new Builder();
  const xml = builder.buildObject(xmlObj);

  await writeFile(CONFIG_PATH, xml, 'utf-8');
}
