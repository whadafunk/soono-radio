import { parseStringPromise, Builder } from 'xml2js';
import { readFile, writeFile } from 'fs/promises';
import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';

const CONFIG_PATH = '/etc/icecast.xml';

export async function readIcecastConfig(): Promise<IcecastConfig> {
  const xml = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = await parseStringPromise(xml);

  const icecast = parsed.icecast;
  const config: IcecastConfig = {
    server: {
      location: icecast.server?.[0]?.location?.[0] || '',
      admin: icecast.server?.[0]?.admin?.[0] || 'admin@localhost',
      hostname: icecast.server?.[0]?.hostname?.[0] || 'localhost',
    },
    network: {
      port: parseInt(icecast.port?.[0] || '8000', 10),
      bind_address: icecast.bind_address?.[0] || '0.0.0.0',
    },
    authentication: {
      source_password: icecast.source_password?.[0] || 'hackme',
      relay_password: icecast.relay_password?.[0] || 'hackme',
      admin_user: icecast.admin_user?.[0] || 'admin',
      admin_password: icecast.admin_password?.[0] || 'hackme',
    },
    limits: {
      max_sources: parseInt(icecast.limits?.[0]?.sources?.[0] || '10', 10),
      max_clients: parseInt(icecast.limits?.[0]?.clients?.[0] || '500', 10),
      max_queue_size: parseInt(icecast.limits?.[0]?.queue_size?.[0] || '524288', 10),
      burst_size: parseInt(icecast.limits?.[0]?.burst_size?.[0] || '65536', 10),
    },
    mount_default: {
      name: icecast.mount?.[0]?.name?.[0] || '/stream',
      max_listeners: parseInt(icecast.mount?.[0]?.max_listeners?.[0] || '-1', 10),
      fallback_mount: icecast.mount?.[0]?.fallback_mount?.[0],
    },
    logging: {
      loglevel: (icecast.loglevel?.[0] || 'info') as 'debug' | 'info' | 'warn' | 'error',
      access_log: icecast.accesslog?.[0] || '/var/log/icecast/access.log',
      error_log: icecast.errorlog?.[0] || '/var/log/icecast/error.log',
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
      source_password: [config.authentication.source_password],
      relay_password: [config.authentication.relay_password],
      admin_user: [config.authentication.admin_user],
      admin_password: [config.authentication.admin_password],
      limits: [
        {
          sources: [config.limits.max_sources.toString()],
          clients: [config.limits.max_clients.toString()],
          queue_size: [config.limits.max_queue_size.toString()],
          burst_size: [config.limits.burst_size.toString()],
        },
      ],
      mount: [
        {
          name: [config.mount_default.name],
          max_listeners: [config.mount_default.max_listeners.toString()],
          ...(config.mount_default.fallback_mount && {
            fallback_mount: [config.mount_default.fallback_mount],
          }),
        },
      ],
      loglevel: [config.logging.loglevel],
      accesslog: [config.logging.access_log],
      errorlog: [config.logging.error_log],
    },
  };

  const builder = new Builder();
  const xml = builder.buildObject(xmlObj);

  await writeFile(CONFIG_PATH, xml, 'utf-8');
}
