import { parseStringPromise, Builder } from 'xml2js';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';

const CONFIG_PATH = process.env.ICECAST_CONFIG || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');

const LOGLEVEL_TO_NUMBER: Record<string, number> = {
  'error': 1,
  'warn': 2,
  'info': 3,
  'debug': 4,
};

const NUMBER_TO_LOGLEVEL: Record<number, 'error' | 'warn' | 'info' | 'debug'> = {
  1: 'error',
  2: 'warn',
  3: 'info',
  4: 'debug',
};

export async function readIcecastConfig(): Promise<IcecastConfig> {
  const xml = await readFile(CONFIG_PATH, 'utf-8');
  const parsed = await parseStringPromise(xml);

  const icecast = parsed.icecast;

  // Parse listen-socket block
  const listenSocket = icecast['listen-socket']?.[0];
  const port = listenSocket?.port?.[0] ? parseInt(listenSocket.port[0], 10) : 8000;
  const bindAddress = listenSocket?.['bind-address']?.[0] || '0.0.0.0';

  // Parse authentication block
  const auth = icecast.authentication?.[0];
  const sourcePassword = auth?.['source-password']?.[0] || 'default';
  const adminUser = auth?.['admin-user']?.[0] || 'admin';
  const adminPassword = auth?.['admin-password']?.[0] || 'hackme';
  const relayPassword = auth?.['relay-password']?.[0] || 'hackme';

  // Parse all mount points
  const mountsRaw = Array.isArray(icecast.mount) ? icecast.mount : [icecast.mount?.[0]];
  const mounts = (mountsRaw || [])
    .filter(Boolean)
    .map((mount: any) => ({
      name: mount['mount-name']?.[0] || '/stream',
      max_listeners: parseInt(mount['max-listeners']?.[0] || '-1', 10),
      fallback_mount: mount['fallback-mount']?.[0],
    }));

  // Parse logging block
  const logging = icecast.logging?.[0];
  const loglevelRaw = logging?.loglevel?.[0];
  // Icecast uses numeric log levels in XML: 1=error, 2=warn, 3=info, 4=debug
  // But also accept string values for backwards compatibility
  let logLevel: 'error' | 'warn' | 'info' | 'debug' = 'info';
  if (loglevelRaw) {
    const asNumber = parseInt(loglevelRaw, 10);
    if (!isNaN(asNumber) && NUMBER_TO_LOGLEVEL[asNumber]) {
      logLevel = NUMBER_TO_LOGLEVEL[asNumber];
    } else if (['error', 'warn', 'info', 'debug'].includes(loglevelRaw)) {
      logLevel = loglevelRaw as 'error' | 'warn' | 'info' | 'debug';
    }
  }

  // Parse limits block
  const limits = icecast.limits?.[0];

  const config: IcecastConfig = {
    server: {
      hostname: icecast.hostname?.[0] || 'localhost',
      location: icecast.location?.[0] || '',
      admin: icecast.admin?.[0] || 'admin@localhost',
    },
    network: {
      port,
      bind_address: bindAddress,
    },
    authentication: {
      source_password: sourcePassword,
      admin_user: adminUser,
      admin_password: adminPassword,
    },
    relay: {
      relay_password: relayPassword,
      relay_servers: icecast['relay-servers']?.[0],
    },
    limits: {
      max_sources: parseInt(limits?.sources?.[0] || '10', 10),
      max_clients: parseInt(limits?.clients?.[0] || '500', 10),
      max_queue_size: parseInt(limits?.['queue-size']?.[0] || '524288', 10),
      burst_size: parseInt(limits?.['burst-size']?.[0] || '65536', 10),
    },
    mounts: mounts.length > 0 ? mounts : [{ name: '/stream', max_listeners: -1 }],
    logging: {
      loglevel: logLevel,
      logsize: logging?.logsize?.[0] ? parseInt(logging.logsize[0], 10) : undefined,
      access_log: logging?.accesslog?.[0] || '/usr/local/icecast/logs/access.log',
      error_log: logging?.errorlog?.[0] || '/usr/local/icecast/logs/error.log',
    },
  };

  return IcecastConfigSchema.parse(config);
}

export async function writeIcecastConfig(config: IcecastConfig): Promise<void> {
  const xmlObj = {
    icecast: {
      hostname: [config.server.hostname],
      location: [config.server.location],
      admin: [config.server.admin],
      limits: [
        {
          sources: [config.limits.max_sources.toString()],
          clients: [config.limits.max_clients.toString()],
          'queue-size': [config.limits.max_queue_size.toString()],
          'burst-size': [config.limits.burst_size.toString()],
        },
      ],
      authentication: [
        {
          'source-password': [config.authentication.source_password],
          'relay-password': [config.relay.relay_password],
          'admin-user': [config.authentication.admin_user],
          'admin-password': [config.authentication.admin_password],
        },
      ],
      'listen-socket': [
        {
          port: [config.network.port.toString()],
          'bind-address': [config.network.bind_address],
        },
      ],
      mount: config.mounts.map((mount) => ({
        'mount-name': [mount.name],
        'max-listeners': [mount.max_listeners.toString()],
        ...(mount.fallback_mount && { 'fallback-mount': [mount.fallback_mount] }),
      })),
      paths: [
        {
          basedir: ['/usr/local/icecast'],
          logdir: ['/usr/local/icecast/logs'],
          webroot: ['/usr/local/icecast/share/icecast/web'],
          adminroot: ['/usr/local/icecast/share/icecast/admin'],
        },
      ],
      logging: [
        {
          accesslog: [config.logging.access_log],
          errorlog: [config.logging.error_log],
          loglevel: [LOGLEVEL_TO_NUMBER[config.logging.loglevel].toString()],
          ...(config.logging.logsize && { logsize: [config.logging.logsize.toString()] }),
        },
      ],
    },
  };

  const builder = new Builder();
  const xml = builder.buildObject(xmlObj);

  await writeFile(CONFIG_PATH, xml, 'utf-8');
}
