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

export async function fetchRawXml(): Promise<string> {
  const res = await fetch(`${API_BASE}/icecast/config/raw`);
  if (!res.ok) throw new Error(`Failed to fetch raw XML: ${res.statusText}`);
  const data = await res.json();
  return data.xml;
}

export async function saveRawXml(xml: string): Promise<void> {
  const res = await fetch(`${API_BASE}/icecast/config/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to save XML');
  }
}

export async function restartIcecast(): Promise<{ success: boolean; uptime: number }> {
  const res = await fetch(`${API_BASE}/icecast/restart`, {
    method: 'POST',
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to restart Icecast');
  }

  // Poll stats to confirm Icecast is back online
  let attempts = 0;
  const maxAttempts = 20; // 20 attempts * 500ms = 10 seconds
  while (attempts < maxAttempts) {
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      const statsRes = await fetch(`${API_BASE}/icecast/stats`);
      if (statsRes.ok) {
        const stats = await statsRes.json();
        return { success: true, uptime: stats.uptime || 0 };
      }
    } catch (e) {
      attempts++;
    }
  }

  throw new Error('Icecast did not come back online after restart');
}

export interface CertificateInfo {
  name: string;
  size: number;
  modified: string;
}

export async function fetchCertificates(): Promise<{ certificates: CertificateInfo[]; dir: string }> {
  const res = await fetch(`${API_BASE}/certificates`);
  if (!res.ok) throw new Error(`Failed to list certificates: ${res.statusText}`);
  return res.json();
}

export async function uploadCertificate(file: File): Promise<{ success: boolean; name: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/certificates/upload`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed: ${res.statusText}`);
  }
  return res.json();
}

export async function deleteCertificate(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/certificates/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Delete failed: ${res.statusText}`);
  }
}
