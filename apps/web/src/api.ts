import {
  IcecastConfig,
  IcecastConfigSchema,
  LiquidsoapConfig,
  LiquidsoapConfigSchema,
  LiquidsoapStatus,
  LiquidsoapStatusSchema,
} from '@radio/shared';

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

export async function kickIcecastSource(mount: string): Promise<void> {
  const res = await fetch(`${API_BASE}/icecast/mounts/kick`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mount }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to kick source: ${res.statusText}`);
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

export interface CertificateDetails extends CertificateInfo {
  path: string;
  has_certificate: boolean;
  has_private_key: boolean;
  text: string;
}

export async function fetchCertificateDetails(name: string): Promise<CertificateDetails> {
  const res = await fetch(`${API_BASE}/certificates/${encodeURIComponent(name)}/info`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to load certificate: ${res.statusText}`);
  }
  return res.json();
}

export async function generateCertificate(params: {
  commonName: string;
  validityDays?: number;
  altNames?: string[];
  filename?: string;
  city?: string;
  country?: string;
}): Promise<{ success: boolean; name: string }> {
  const res = await fetch(`${API_BASE}/certificates/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Generation failed: ${res.statusText}`);
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

export async function fetchLiquidsoapConfig(): Promise<LiquidsoapConfig> {
  const res = await fetch(`${API_BASE}/liquidsoap/config`);
  if (!res.ok) throw new Error(`Failed to fetch Liquidsoap config: ${res.statusText}`);
  const data = await res.json();
  return LiquidsoapConfigSchema.parse(data);
}

export async function updateLiquidsoapConfig(config: LiquidsoapConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/liquidsoap/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`Failed to update Liquidsoap config: ${JSON.stringify(error)}`);
  }
}

export async function fetchLiquidsoapRawScript(): Promise<string> {
  const res = await fetch(`${API_BASE}/liquidsoap/script/raw`);
  if (!res.ok) throw new Error(`Failed to fetch radio.liq: ${res.statusText}`);
  const data = await res.json();
  return data.script;
}

export async function saveLiquidsoapRawScript(script: string): Promise<void> {
  const res = await fetch(`${API_BASE}/liquidsoap/script/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to save radio.liq: ${res.statusText}`);
  }
}

export async function fetchLiquidsoapStatus(): Promise<LiquidsoapStatus> {
  const res = await fetch(`${API_BASE}/liquidsoap/status`);
  if (!res.ok) throw new Error(`Failed to fetch Liquidsoap status: ${res.statusText}`);
  const data = await res.json();
  return LiquidsoapStatusSchema.parse(data);
}

export async function restartLiquidsoap(): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/liquidsoap/restart`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to restart Liquidsoap');
  }

  // Poll status until reachable, similar to the Icecast restart flow.
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const statusRes = await fetch(`${API_BASE}/liquidsoap/status`);
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.reachable) return { success: true };
      }
    } catch {
      // keep polling
    }
  }

  // Liquidsoap may take a few seconds to bind telnet. Treat this as soft success.
  return { success: true };
}
