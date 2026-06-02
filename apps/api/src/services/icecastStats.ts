const ICECAST_BASE = process.env.ICECAST_URL || 'http://localhost:8000';
const ICECAST_ADMIN_USER = process.env.ICECAST_ADMIN_USER || 'admin';
const ICECAST_ADMIN_PASS = process.env.ICECAST_ADMIN_PASS || 'adminadmin';

interface IcecastStatsResponse {
  listener: number;
  bitrate: number;
  uptime: number;
  mount: string;
}

export async function fetchIcecastStats(mount: string = '/stream'): Promise<IcecastStatsResponse> {
  const auth = Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64');

  try {
    const response = await fetch(`${ICECAST_BASE}/admin/stats?mount=${encodeURIComponent(mount)}`, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // Icecast not responding or mount doesn't exist yet
      return { listener: 0, bitrate: 0, uptime: 0, mount };
    }

    const text = await response.text();

    // Parse XML response looking for <listeners>, <bitrate>, <server_start_time>
    const listenerMatch = text.match(/<listeners>(\d+)<\/listeners>/);
    const bitrateMatch = text.match(/<bitrate>(\d+)<\/bitrate>/);
    const uptimeMatch = text.match(/<server_start_iso8601>([^<]+)<\/server_start_iso8601>/);

    const listener = listenerMatch ? parseInt(listenerMatch[1], 10) : 0;
    const bitrate = bitrateMatch ? parseInt(bitrateMatch[1], 10) : 0;

    let uptime = 0;
    if (uptimeMatch) {
      const startTime = new Date(uptimeMatch[1]).getTime();
      uptime = Math.floor((Date.now() - startTime) / 1000);
    }

    return { listener, bitrate, uptime, mount };
  } catch (error) {
    // Icecast unreachable
    console.error('Failed to fetch Icecast stats:', error);
    return { listener: 0, bitrate: 0, uptime: 0, mount };
  }
}

export async function fetchAllMountStats() {
  // Fetch global stats
  const auth = Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64');

  try {
    const response = await fetch(`${ICECAST_BASE}/admin/stats`, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const uptime = await getDockerContainerUptime();
      return { listener: 0, bitrate: 0, uptime };
    }

    const text = await response.text();

    const listenerMatch = text.match(/<listeners>(\d+)<\/listeners>/);
    const bitrateMatch = text.match(/<bitrate>(\d+)<\/bitrate>/);
    const uptimeMatch = text.match(/<server_start_iso8601>([^<]+)<\/server_start_iso8601>/);

    const listener = listenerMatch ? parseInt(listenerMatch[1], 10) : 0;
    const bitrate = bitrateMatch ? parseInt(bitrateMatch[1], 10) : 0;

    let uptime = 0;
    if (uptimeMatch) {
      const startTime = new Date(uptimeMatch[1]).getTime();
      uptime = Math.floor((Date.now() - startTime) / 1000);
    }

    return { listener, bitrate, uptime };
  } catch (error) {
    console.error('Failed to fetch global Icecast stats:', error);
    const uptime = await getDockerContainerUptime();
    return { listener: 0, bitrate: 0, uptime };
  }
}

export async function killIcecastSource(mount: string): Promise<void> {
  const { request: httpsRequest } = await import('https');
  const { request: httpRequest } = await import('http');
  const { readIcecastConfig } = await import('./icecastConfig.js');

  // Discover the right URL from the saved config: prefer a plain-HTTP listen-socket
  // (admin calls don't need TLS for local IPC). Fall back to HTTPS with self-signed
  // cert acceptance — fine for local Icecast since this never leaves the host.
  let protocol: 'http:' | 'https:' = 'http:';
  let port = 8000;
  if (process.env.ICECAST_URL) {
    const u = new URL(process.env.ICECAST_URL);
    protocol = u.protocol as 'http:' | 'https:';
    port = parseInt(u.port, 10) || (protocol === 'https:' ? 443 : 80);
  } else {
    try {
      const config = await readIcecastConfig();
      const sockets = config.network.listen_sockets;
      const preferred = sockets.find((s) => !s.ssl) || sockets[0];
      if (preferred) {
        protocol = preferred.ssl ? 'https:' : 'http:';
        port = preferred.port;
      }
    } catch {
      // fall back to defaults
    }
  }

  const auth = Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64');

  return new Promise((resolve, reject) => {
    const requestFn = protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        hostname: 'localhost',
        port,
        path: `/admin/killsource?mount=${encodeURIComponent(mount)}`,
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
        rejectUnauthorized: false, // accept self-signed certs for local Icecast
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Icecast admin returned ${res.statusCode}: ${body.trim() || 'no body'}`,
              ),
            );
          }
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function getDockerContainerUptime(): Promise<number> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFilePromise = promisify(execFile);

    const { stdout } = await execFilePromise(
      'docker', ['inspect', '-f', '{{.State.StartedAt}}', 'soono-icecast']
    );

    const startTime = new Date(stdout.trim()).getTime();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return Math.max(0, uptime);
  } catch (error) {
    console.error('Failed to get Docker container uptime:', error);
    return 0;
  }
}
