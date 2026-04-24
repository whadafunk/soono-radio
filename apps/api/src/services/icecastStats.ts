const ICECAST_BASE = process.env.ICECAST_URL || 'http://localhost:8000';
const ICECAST_ADMIN_USER = process.env.ICECAST_ADMIN_USER || 'admin';
const ICECAST_ADMIN_PASS = process.env.ICECAST_ADMIN_PASS || 'hackme';

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
    });

    if (!response.ok) {
      return { listener: 0, bitrate: 0, uptime: 0 };
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
    return { listener: 0, bitrate: 0, uptime: 0 };
  }
}
