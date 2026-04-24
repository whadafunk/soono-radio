import { IcecastConfig, IcecastConfigSchema } from '@radio/shared';

const API_BASE = '/api';

export interface IcecastStats {
  listener: number;
  bitrate: number;
  uptime: number;
  mount?: string;
}

export async function fetchIcecastConfig(): Promise<IcecastConfig> {
  const res = await fetch(`${API_BASE}/icecast/config`);
  if (!res.ok) throw new Error(`Failed to fetch Icecast config: ${res.statusText}`);
  const data = await res.json();
  return IcecastConfigSchema.parse(data);
}

export async function updateIcecastConfig(config: IcecastConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/icecast/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to update Icecast config: ${JSON.stringify(error)}`);
  }
}

export async function fetchIcecastStats(): Promise<IcecastStats> {
  const res = await fetch(`${API_BASE}/icecast/stats`);
  if (!res.ok) throw new Error(`Failed to fetch Icecast stats: ${res.statusText}`);
  return res.json();
}
