// Stateless HTTP client for the LiquidSoap harbor control endpoints.
// Every method is a single fetch() call — no persistent connection, no state,
// no reconnect logic. Multiple callers can use this concurrently without any
// coordination because LS's harbor handles thread safety internally.

import { readLiquidsoapConfig } from '../liquidsoapConfig.js';

const BASE_URL = process.env.LS_HARBOR_URL ?? 'http://localhost:8005';

async function authHeaders(): Promise<Record<string, string>> {
  const config = await readLiquidsoapConfig();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.harbor.password}`,
  };
}

async function harborFetch(path: string, init: RequestInit): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const headers = await authHeaders();
  const res = await fetch(url, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(5000),
  });
  return res;
}

export interface PushResponse {
  ok: boolean;
  request_id: string;
}

export interface QueueResponse {
  depth: number;
  ids: string[];
}

export interface SkipResponse {
  ok: boolean;
}

export interface LiveStatusResponse {
  connected: boolean;
}

export const HarborClient = {
  async push(annotatedUri: string): Promise<PushResponse> {
    const res = await harborFetch('/push', {
      method: 'POST',
      body: JSON.stringify({ uri: annotatedUri }),
    });
    if (!res.ok) {
      throw new Error(`Harbor /push failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<PushResponse>;
  },

  async getQueue(): Promise<QueueResponse> {
    const res = await harborFetch('/queue', { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Harbor /queue failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<QueueResponse>;
  },

  async skip(): Promise<SkipResponse> {
    const res = await harborFetch('/skip', { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Harbor /skip failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<SkipResponse>;
  },

  async getLiveStatus(): Promise<LiveStatusResponse> {
    const res = await harborFetch('/live-status', { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Harbor /live-status failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<LiveStatusResponse>;
  },
};
