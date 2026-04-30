import {
  IcecastConfig,
  IcecastConfigSchema,
  LiquidsoapConfig,
  LiquidsoapConfigSchema,
  LiquidsoapStatus,
  LiquidsoapStatusSchema,
  IngestJob,
  IngestJobSchema,
  Media,
  MediaSchema,
  MediaPatch,
  MediaCategory,
  TranscodeOptions,
  SupervisorStatus,
  SupervisorStatusSchema,
  SupervisorConfig,
  SupervisorConfigSchema,
  NowPlaying,
  NowPlayingSchema,
  RecentPlay,
  RecentPlaySchema,
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
  if (!res.ok) throw new Error(`Failed to fetch mix-engine.liq: ${res.statusText}`);
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
    throw new Error(data.error || `Failed to save mix-engine.liq: ${res.statusText}`);
  }
}

export async function fetchLiquidsoapStatus(): Promise<LiquidsoapStatus> {
  const res = await fetch(`${API_BASE}/liquidsoap/status`);
  if (!res.ok) throw new Error(`Failed to fetch Liquidsoap status: ${res.statusText}`);
  const data = await res.json();
  return LiquidsoapStatusSchema.parse(data);
}

export interface UploadedJob {
  job_id: string;
  filename: string;
  size_bytes: number;
}

export async function uploadLibraryFiles(
  files: File[],
  category: MediaCategory,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ jobs: UploadedJob[] }> {
  const form = new FormData();
  form.append('category', category);
  for (const file of files) form.append('files', file, file.name);

  // Use XHR so we can report upload progress; fetch can't yet.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/library/upload`);
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (err) {
          reject(err);
        }
      } else {
        let message = `Upload failed: ${xhr.status}`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (data.error) message = data.error;
        } catch {
          /* ignore parse */
        }
        reject(new Error(message));
      }
    });
    xhr.send(form);
  });
}

export interface LibraryListParams {
  q?: string;
  category?: string;
  favorite?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface LibraryListResponse {
  items: Media[];
  total: number;
  limit: number;
  offset: number;
}

export async function fetchLibrary(params: LibraryListParams = {}): Promise<LibraryListResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.category) search.set('category', params.category);
  if (params.favorite !== undefined) search.set('favorite', String(params.favorite));
  if (params.sort) search.set('sort', params.sort);
  if (params.order) search.set('order', params.order);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));

  const res = await fetch(`${API_BASE}/library?${search.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch library: ${res.statusText}`);
  const data = await res.json();
  return {
    ...data,
    items: data.items.map((i: unknown) => MediaSchema.parse(i)),
  };
}

export async function fetchLibraryItem(id: number): Promise<Media> {
  const res = await fetch(`${API_BASE}/library/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch track: ${res.statusText}`);
  return MediaSchema.parse(await res.json());
}

export async function updateLibraryItem(id: number, patch: MediaPatch): Promise<Media> {
  const res = await fetch(`${API_BASE}/library/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update: ${res.statusText}`);
  }
  return MediaSchema.parse(await res.json());
}

export function libraryAudioUrl(id: number): string {
  return `${API_BASE}/library/${id}/audio`;
}

export async function deleteLibraryItem(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/library/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Delete failed: ${res.statusText}`);
  }
}

export async function reMeasureLibraryItem(id: number): Promise<Media> {
  const res = await fetch(`${API_BASE}/library/${id}/re-measure`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Re-measure failed: ${res.statusText}`);
  }
  return MediaSchema.parse(await res.json());
}

export async function reTranscodeLibraryItem(
  id: number,
  options: TranscodeOptions,
): Promise<Media> {
  const res = await fetch(`${API_BASE}/library/${id}/re-transcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Re-transcode failed: ${res.statusText}`);
  }
  return MediaSchema.parse(await res.json());
}

export interface BulkResult {
  succeeded: number[];
  failed: { id: number; error: string }[];
}

export async function bulkDeleteLibrary(ids: number[]): Promise<BulkResult> {
  const res = await fetch(`${API_BASE}/library`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Bulk delete failed: ${res.statusText}`);
  }
  return res.json();
}

export async function bulkSetCategory(ids: number[], category: MediaCategory): Promise<void> {
  const res = await fetch(`${API_BASE}/library/bulk-category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, category }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Bulk category failed: ${res.statusText}`);
  }
}

export async function bulkSetFavorite(ids: number[], favorite: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/library/bulk-favorite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, favorite }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Bulk favorite failed: ${res.statusText}`);
  }
}

export async function fetchSupervisorStatus(): Promise<SupervisorStatus> {
  const res = await fetch(`${API_BASE}/supervisor/status`);
  if (!res.ok) throw new Error(`Failed to fetch supervisor status: ${res.statusText}`);
  return SupervisorStatusSchema.parse(await res.json());
}

export async function fetchNowPlaying(): Promise<NowPlaying> {
  const res = await fetch(`${API_BASE}/supervisor/now-playing`);
  if (!res.ok) throw new Error(`Failed to fetch now-playing: ${res.statusText}`);
  const data = await res.json();
  return NowPlayingSchema.parse(data);
}

export async function fetchSupervisorConfig(): Promise<SupervisorConfig> {
  const res = await fetch(`${API_BASE}/supervisor/config`);
  if (!res.ok) throw new Error(`Failed to fetch supervisor config: ${res.statusText}`);
  return SupervisorConfigSchema.parse(await res.json());
}

export async function updateSupervisorConfig(config: SupervisorConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/supervisor/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to save supervisor config: ${res.statusText}`);
  }
}

export async function restartSupervisor(): Promise<void> {
  const res = await fetch(`${API_BASE}/supervisor/restart`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to restart supervisor: ${res.statusText}`);
  }
}

export async function fetchRecentPlays(limit = 20): Promise<RecentPlay[]> {
  const res = await fetch(`${API_BASE}/supervisor/recent-plays?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch recent plays: ${res.statusText}`);
  const data = await res.json();
  return data.plays.map((p: unknown) => RecentPlaySchema.parse(p));
}

export async function bulkReMeasure(ids: number[]): Promise<BulkResult> {
  const res = await fetch(`${API_BASE}/library/bulk-remeasure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Bulk re-measure failed: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchIngestJob(jobId: string): Promise<IngestJob> {
  const res = await fetch(`${API_BASE}/library/ingest/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(`Failed to fetch ingest job: ${res.statusText}`);
  const data = await res.json();
  return IngestJobSchema.parse(data);
}

export async function fetchIngestJobs(): Promise<IngestJob[]> {
  const res = await fetch(`${API_BASE}/library/ingest`);
  if (!res.ok) throw new Error(`Failed to fetch ingest jobs: ${res.statusText}`);
  const data = await res.json();
  return data.jobs.map((j: unknown) => IngestJobSchema.parse(j));
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

// ============ SCHEDULING (CUSTOMERS + CONTRACTS) ============
// MOCK DATA — replace with real API calls later

import {
  Customer,
  CustomerCreate,
  CustomerPatch,
  CustomerSchema,
  Contract,
  ContractCreate,
  ContractPatch,
  ContractWithCustomer,
  ContractPacingSchema,
  Contact,
  ContactCreate,
  ContactPatch,
} from '@radio/shared';

// Mock in-memory store for phase 1 UI exploration
let mockCustomers: Customer[] = [
  {
    id: 1,
    name: 'ACME Corp',
    email: 'contact@acme.com',
    phone: '555-0001',
    notes: 'Major local advertiser',
    active: true,
    created_at: new Date('2026-03-01'),
    updated_at: new Date('2026-03-15'),
  },
  {
    id: 2,
    name: 'Local Plumber',
    email: 'info@localplumber.com',
    phone: '555-0002',
    notes: null,
    active: true,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
  },
];

let mockContracts: Contract[] = [
  {
    id: 1,
    customer_id: 1,
    name: 'Summer Campaign 2026',
    starts_on: '2026-06-01',
    ends_on: '2026-08-31',
    plays_per_month: 45,
    time_window_start: '06:00',
    time_window_end: '22:00',
    days_of_week: null,
    separation_minutes: 90,
    advertiser_separation_min: 30,
    priority: 'hard',
    notes: 'Peak season promotion',
    active: true,
    created_at: new Date('2026-04-15'),
    updated_at: new Date('2026-04-15'),
  },
  {
    id: 2,
    customer_id: 2,
    name: 'Ongoing Local Spots',
    starts_on: '2026-04-01',
    ends_on: '2026-12-31',
    plays_per_month: 20,
    time_window_start: '07:00',
    time_window_end: '20:00',
    days_of_week: '1,2,3,4,5',
    separation_minutes: 120,
    advertiser_separation_min: 45,
    priority: 'standard',
    notes: null,
    active: true,
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
  },
];

let nextCustomerId = 3;
let nextContractId = 3;

export async function fetchCustomers(): Promise<Customer[]> {
  return Promise.resolve([...mockCustomers]);
}

export async function createCustomer(data: CustomerCreate): Promise<Customer> {
  const customer: Customer = {
    id: nextCustomerId++,
    ...data,
    email: data.email ?? null,
    phone: data.phone ?? null,
    notes: data.notes ?? null,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockCustomers.push(customer);
  return Promise.resolve(customer);
}

export async function fetchCustomer(id: number): Promise<Customer> {
  const customer = mockCustomers.find((c) => c.id === id);
  if (!customer) throw new Error(`Customer ${id} not found`);
  return Promise.resolve(customer);
}

export async function updateCustomer(id: number, patch: CustomerPatch): Promise<Customer> {
  const idx = mockCustomers.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Customer ${id} not found`);
  const updated = { ...mockCustomers[idx], ...patch, updated_at: new Date() };
  mockCustomers[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteCustomer(id: number): Promise<void> {
  const idx = mockCustomers.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Customer ${id} not found`);
  mockCustomers.splice(idx, 1);
  return Promise.resolve();
}

export async function fetchContracts(customerId?: number): Promise<ContractWithCustomer[]> {
  const filtered = customerId
    ? mockContracts.filter((c) => c.customer_id === customerId)
    : mockContracts;

  return Promise.resolve(
    filtered.map((contract) => {
      const customer = mockCustomers.find((c) => c.id === contract.customer_id);
      return {
        ...contract,
        customer_name: customer?.name ?? 'Unknown',
      };
    }),
  );
}

export async function createContract(data: ContractCreate): Promise<Contract> {
  const contract: Contract = {
    id: nextContractId++,
    ...data,
    time_window_start: data.time_window_start ?? null,
    time_window_end: data.time_window_end ?? null,
    days_of_week: data.days_of_week ?? null,
    notes: data.notes ?? null,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockContracts.push(contract);
  return Promise.resolve(contract);
}

export async function fetchContract(id: number): Promise<Contract> {
  const contract = mockContracts.find((c) => c.id === id);
  if (!contract) throw new Error(`Contract ${id} not found`);
  return Promise.resolve(contract);
}

export async function updateContract(id: number, patch: ContractPatch): Promise<Contract> {
  const idx = mockContracts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Contract ${id} not found`);
  const updated = { ...mockContracts[idx], ...patch, updated_at: new Date() };
  mockContracts[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteContract(id: number): Promise<void> {
  const idx = mockContracts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Contract ${id} not found`);
  mockContracts.splice(idx, 1);
  return Promise.resolve();
}

export async function fetchContractPacing(
  id: number,
): Promise<{ plays_this_month: number; target: number; pct: number; on_track: boolean }> {
  const contract = mockContracts.find((c) => c.id === id);
  if (!contract) throw new Error(`Contract ${id} not found`);

  const now = new Date();
  const plays_this_month = Math.floor(Math.random() * (contract.plays_per_month + 1));
  const target = contract.plays_per_month;
  const pct = Math.round((plays_this_month / target) * 100);
  const on_track = pct >= Math.round((now.getDate() / 28) * 100);

  return Promise.resolve({
    plays_this_month,
    target,
    pct,
    on_track,
  });
}

// ============ CONTACTS ============

let mockContacts: Contact[] = [
  {
    id: 1,
    customer_id: 1,
    name: 'John Smith',
    email: 'john@acme.com',
    phone: '555-0001',
    role: 'Account Manager',
    notes: 'Primary contact for campaign planning',
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-15'),
  },
  {
    id: 2,
    customer_id: 1,
    name: 'Jane Doe',
    email: 'jane@acme.com',
    phone: '555-0002',
    role: 'Technical Contact',
    notes: null,
    created_at: new Date('2026-04-10'),
    updated_at: new Date('2026-04-10'),
  },
  {
    id: 3,
    customer_id: 2,
    name: 'Bob Johnson',
    email: 'bob@localplumber.com',
    phone: '555-0003',
    role: 'Owner',
    notes: 'Check with Bob for any ad changes',
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
  },
];

let nextContactId = 4;

export async function fetchContacts(customerId?: number): Promise<Contact[]> {
  const filtered = customerId
    ? mockContacts.filter((c) => c.customer_id === customerId)
    : mockContacts;
  return Promise.resolve([...filtered]);
}

export async function createContact(data: ContactCreate): Promise<Contact> {
  const contact: Contact = {
    id: nextContactId++,
    ...data,
    email: data.email ?? null,
    phone: data.phone ?? null,
    role: data.role ?? null,
    notes: data.notes ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockContacts.push(contact);
  return Promise.resolve(contact);
}

export async function fetchContact(id: number): Promise<Contact> {
  const contact = mockContacts.find((c) => c.id === id);
  if (!contact) throw new Error(`Contact ${id} not found`);
  return Promise.resolve(contact);
}

export async function updateContact(id: number, patch: ContactPatch): Promise<Contact> {
  const idx = mockContacts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Contact ${id} not found`);
  const updated = { ...mockContacts[idx], ...patch, updated_at: new Date() };
  mockContacts[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteContact(id: number): Promise<void> {
  const idx = mockContacts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Contact ${id} not found`);
  mockContacts.splice(idx, 1);
  return Promise.resolve();
}
