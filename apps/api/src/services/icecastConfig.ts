import { parseStringPromise, Builder } from 'xml2js';
import { readFile, writeFile, copyFile, access } from 'fs/promises';
import { join } from 'path';
import { IcecastConfig, IcecastConfigSchema } from '@soono/shared';

const CONFIG_PATH = process.env.ICECAST_CONFIG || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml');
const DEFAULT_PATH = process.env.ICECAST_CONFIG_DEFAULT || join(process.cwd(), '..', '..', 'icecast', 'icecast.xml.default');

export async function ensureIcecastConfig(): Promise<void> {
  try {
    await access(CONFIG_PATH);
  } catch {
    await copyFile(DEFAULT_PATH, CONFIG_PATH);
  }
}

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
  const parsed = await parseStringPromise(xml, { trim: true });

  const icecast = parsed.icecast;

  // Parse all listen-socket blocks (Icecast supports multiple for HTTP+HTTPS, etc.)
  const listenSocketsRaw = Array.isArray(icecast['listen-socket'])
    ? icecast['listen-socket']
    : icecast['listen-socket']
      ? [icecast['listen-socket']]
      : [];
  const listenSockets = listenSocketsRaw
    .filter(Boolean)
    .map((sock: any) => {
      const sslRaw = sock.ssl?.[0];
      const shoutcastCompatRaw = sock['shoutcast-compat']?.[0];
      return {
        port: sock.port?.[0] ? parseInt(sock.port[0], 10) : 8000,
        bind_address: sock['bind-address']?.[0] || '0.0.0.0',
        ssl: sslRaw !== undefined ? sslRaw === '1' || sslRaw === 'true' : undefined,
        shoutcast_compat:
          shoutcastCompatRaw !== undefined
            ? shoutcastCompatRaw === '1' || shoutcastCompatRaw === 'true'
            : undefined,
      };
    });

  // Migrate / ensure at least one socket exists
  if (listenSockets.length === 0) {
    listenSockets.push({
      port: 8000,
      bind_address: '0.0.0.0',
      ssl: undefined,
      shoutcast_compat: undefined,
    });
  }

  // Parse authentication block
  const auth = icecast.authentication?.[0];
  const sourcePassword = auth?.['source-password']?.[0] || 'default';
  const adminUser = auth?.['admin-user']?.[0] || 'admin';
  const adminPassword = auth?.['admin-password']?.[0] || 'hackme';
  const relayPassword = auth?.['relay-password']?.[0] || 'hackme';

  // Parse the single mount point (Soono only supports one)
  const mountRaw = Array.isArray(icecast.mount) ? icecast.mount[0] : icecast.mount?.[0];
  const bitrateRaw = mountRaw?.bitrate?.[0];
  const publicRaw = mountRaw?.public?.[0];
  const mount = {
    name: mountRaw?.['mount-name']?.[0] || '/stream',
    max_listeners: parseInt(mountRaw?.['max-listeners']?.[0] || '-1', 10),
    intro: mountRaw?.['intro']?.[0],
    stream_name: mountRaw?.['stream-name']?.[0],
    stream_description: mountRaw?.['stream-description']?.[0],
    stream_url: mountRaw?.['stream-url']?.[0],
    genre: mountRaw?.genre?.[0],
    bitrate: bitrateRaw ? parseInt(bitrateRaw, 10) : undefined,
    type: mountRaw?.type?.[0],
    public: publicRaw !== undefined ? publicRaw === '1' || publicRaw === 'true' : undefined,
  };

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
      listen_sockets: listenSockets,
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
    ssl: {
      // Debian/Ubuntu icecast2 expects <ssl-certificate> inside <paths>; upstream/older
      // configs put it at root. Read from paths first, fall back to root for compat.
      certificate_path:
        icecast.paths?.[0]?.['ssl-certificate']?.[0] ||
        icecast['ssl-certificate']?.[0] ||
        null,
    },
    limits: {
      max_sources: parseInt(limits?.sources?.[0] || '10', 10),
      max_clients: parseInt(limits?.clients?.[0] || '500', 10),
      max_queue_size: parseInt(limits?.['queue-size']?.[0] || '524288', 10),
      burst_size: parseInt(limits?.['burst-size']?.[0] || '65536', 10),
    },
    mount,
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
      security: [
        {
          chroot: ['0'],
          changeowner: [{ user: ['icecast2'], group: ['icecast'] }],
        },
      ],
      'listen-socket': config.network.listen_sockets.map((sock) => ({
        port: [sock.port.toString()],
        'bind-address': [sock.bind_address],
        ...(sock.ssl && { ssl: ['1'] }),
        ...(sock.shoutcast_compat && { 'shoutcast-compat': ['1'] }),
      })),
      mount: [
        {
          'mount-name': [config.mount.name],
          'max-listeners': [config.mount.max_listeners.toString()],
          ...(config.mount.intro && { intro: [config.mount.intro] }),
          ...(config.mount.stream_name && { 'stream-name': [config.mount.stream_name] }),
          ...(config.mount.stream_description && { 'stream-description': [config.mount.stream_description] }),
          ...(config.mount.stream_url && { 'stream-url': [config.mount.stream_url] }),
          ...(config.mount.genre && { genre: [config.mount.genre] }),
          ...(config.mount.bitrate !== undefined && { bitrate: [config.mount.bitrate.toString()] }),
          ...(config.mount.type && { type: [config.mount.type] }),
          ...(config.mount.public !== undefined && { public: [config.mount.public ? '1' : '0'] }),
        },
      ],
      paths: [
        {
          // Paths the Ubuntu/Debian icecast2 package expects. Hardcoded because
          // they're properties of the package install, not user-configurable.
          basedir: ['/usr/share/icecast2'],
          logdir: ['/usr/local/icecast/logs'],
          webroot: ['/etc/icecast2/web'],
          adminroot: ['/etc/icecast2/admin'],
          // Debian/Ubuntu icecast2 expects <ssl-certificate> inside <paths>
          ...(config.ssl?.certificate_path && {
            'ssl-certificate': [config.ssl.certificate_path],
          }),
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

  const builder = new Builder({
    renderOpts: { pretty: true, indent: '  ', newline: '\n' },
    xmldec: { version: '1.0', encoding: 'UTF-8', standalone: true },
  });
  let xml = builder.buildObject(xmlObj);

  // xml2js Builder wraps text values like <tag>value\n    </tag>.
  // Icecast reads the literal whitespace as part of the value. Strip it.
  xml = xml.replace(/<([\w-]+)>([^<]+?)\s*\n\s*<\/\1>/g, '<$1>$2</$1>');

  await writeFile(CONFIG_PATH, xml, 'utf-8');
}
