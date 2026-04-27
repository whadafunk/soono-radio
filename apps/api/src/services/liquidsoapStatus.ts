import { createConnection } from 'net';
import { LiquidsoapStatus } from '@radio/shared';

const TELNET_HOST = process.env.LIQUIDSOAP_TELNET_HOST || '127.0.0.1';
const TELNET_PORT = parseInt(process.env.LIQUIDSOAP_TELNET_PORT || '1234', 10);
const TELNET_TIMEOUT_MS = 1500;

async function telnetCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: TELNET_HOST, port: TELNET_PORT });
    let buffer = '';
    let settled = false;

    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value ?? '');
    };

    socket.setTimeout(TELNET_TIMEOUT_MS, () => finish(new Error('telnet timeout')));
    socket.on('error', (err) => finish(err));
    socket.on('connect', () => {
      socket.write(`${command}\nquit\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
    });
    socket.on('close', () => finish(null, buffer));
  });
}

function parseTelnetReply(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'END' && line !== 'Bye!');
}

export async function fetchLiquidsoapStatus(): Promise<LiquidsoapStatus> {
  try {
    // `output.icecast.remaining` would tell us how much of the current track is left,
    // but the most reliable on-air indicator is which source the fallback selected.
    // Liquidsoap exposes the active source via `<id>.skip`, `<id>.status`, etc.
    // We probe `live.status` (returns "connected" or "no source") and infer from there.
    const liveRaw = await telnetCommand('live.status').catch(() => '');
    const liveLines = parseTelnetReply(liveRaw);
    const liveLine = liveLines.find((l) => !l.startsWith('live.status')) ?? liveLines[0] ?? '';

    const isLive = /connected/i.test(liveLine) && !/no\s*source/i.test(liveLine);

    return {
      on_air: isLive ? 'live' : 'automation',
      current_source: isLive ? 'live' : 'automation',
      reachable: true,
    };
  } catch {
    return { on_air: 'none', current_source: null, reachable: false };
  }
}
