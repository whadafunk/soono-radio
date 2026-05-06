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
  CustomerContact,
  ContactCreate,
  ContactPatch,
  Show,
  ShowCreate,
  ShowPatch,
  Clock,
  ClockCreate,
  ClockPatch,
  TemplateEntry,
  TemplateEntryCreate,
  TemplateEntryPatch,
  CalendarEntry,
  CalendarEntryCreate,
  CalendarEntryPatch,
  TemplateClockEntry,
  TemplateClockEntryUpsert,
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
    customer_id: null,
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
    customer_id: null,
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
    customer_id: null,
    name: 'Bob Johnson',
    email: 'bob@localplumber.com',
    phone: '555-0003',
    role: 'Owner',
    notes: 'Check with Bob for any ad changes',
    created_at: new Date('2026-04-01'),
    updated_at: new Date('2026-04-01'),
  },
];

// Junction: many contacts ↔ many customers; is_primary is per-association
let mockCustomerContacts: CustomerContact[] = [
  { customer_id: 1, contact_id: 1, is_primary: true },
  { customer_id: 1, contact_id: 2, is_primary: false },
  { customer_id: 2, contact_id: 3, is_primary: true },
];

let nextContactId = 4;

// Returns all contacts (for the "associate existing" picker)
export async function fetchAllContacts(): Promise<Contact[]> {
  return Promise.resolve([...mockContacts]);
}

// Returns contacts associated with a customer, annotated with is_primary
export async function fetchContacts(customerId?: number): Promise<(Contact & { is_primary: boolean })[]> {
  if (!customerId) {
    return Promise.resolve(mockContacts.map((c) => ({ ...c, is_primary: false })));
  }
  const junctions = mockCustomerContacts.filter((j) => j.customer_id === customerId);
  return Promise.resolve(
    junctions.map((j) => {
      const contact = mockContacts.find((c) => c.id === j.contact_id)!;
      return { ...contact, is_primary: j.is_primary };
    }),
  );
}

export async function associateContact(
  customerId: number,
  contactId: number,
  isPrimary = false,
): Promise<void> {
  const exists = mockCustomerContacts.find(
    (j) => j.customer_id === customerId && j.contact_id === contactId,
  );
  if (!exists) {
    // If marking primary, demote others
    if (isPrimary) {
      mockCustomerContacts.forEach((j) => {
        if (j.customer_id === customerId) j.is_primary = false;
      });
    }
    mockCustomerContacts.push({ customer_id: customerId, contact_id: contactId, is_primary: isPrimary });
  }
  return Promise.resolve();
}

export async function dissociateContact(customerId: number, contactId: number): Promise<void> {
  const idx = mockCustomerContacts.findIndex(
    (j) => j.customer_id === customerId && j.contact_id === contactId,
  );
  if (idx !== -1) mockCustomerContacts.splice(idx, 1);
  return Promise.resolve();
}

export async function setContactPrimary(
  customerId: number,
  contactId: number,
  isPrimary: boolean,
): Promise<void> {
  if (isPrimary) {
    mockCustomerContacts.forEach((j) => {
      if (j.customer_id === customerId) j.is_primary = false;
    });
  }
  const junction = mockCustomerContacts.find(
    (j) => j.customer_id === customerId && j.contact_id === contactId,
  );
  if (junction) junction.is_primary = isPrimary;
  return Promise.resolve();
}

export async function createContact(data: ContactCreate): Promise<Contact> {
  const contact: Contact = {
    id: nextContactId++,
    customer_id: data.customer_id ?? null,
    name: data.name,
    email: data.email ?? null,
    phone: data.phone ?? null,
    role: data.role ?? null,
    notes: data.notes ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockContacts.push(contact);
  // Auto-associate if customer_id provided
  if (data.customer_id) {
    const hasPrimary = mockCustomerContacts.some(
      (j) => j.customer_id === data.customer_id && j.is_primary,
    );
    mockCustomerContacts.push({
      customer_id: data.customer_id,
      contact_id: contact.id,
      is_primary: !hasPrimary,
    });
  }
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
  mockCustomerContacts = mockCustomerContacts.filter((j) => j.contact_id !== id);
  return Promise.resolve();
}

// ============ SHOWS ============

let mockShows: Show[] = [
  { id: 1, name: 'Morning Drive',    host: 'Alex Rivera', producer: null, type: 'live',        clock_id: 2, duration_minutes: 240, color: 'amber',   notes: 'Peak morning show — news, traffic, local topics', active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 2, name: 'Midday Mix',       host: null,          producer: null, type: 'automated',   clock_id: 1, duration_minutes: 300, color: 'indigo',  notes: null,                                             active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 3, name: 'Afternoon Drive',  host: 'Sam Chen',    producer: null, type: 'live',        clock_id: 1, duration_minutes: 240, color: 'rose',    notes: null,                                             active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 4, name: 'Evening Vibes',    host: null,          producer: null, type: 'automated',   clock_id: 1, duration_minutes: 240, color: 'violet',  notes: null,                                             active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 5, name: 'Overnight Auto',   host: null,          producer: null, type: 'automated',   clock_id: 3, duration_minutes: 420, color: 'teal',    notes: 'Runs every night into the next morning',         active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 6, name: 'Weekend Morning',  host: 'Jordan Lee',  producer: null, type: 'live',        clock_id: 1, duration_minutes: 240, color: 'emerald', notes: 'Relaxed weekend morning vibes',                  active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
  { id: 7, name: 'Weekend Afternoon',host: null,          producer: null, type: 'automated',   clock_id: 1, duration_minutes: 660, color: 'cyan',    notes: null,                                             active: true, created_at: new Date('2026-03-01'), updated_at: new Date('2026-03-01') },
];

let nextShowId = 8;

export async function fetchShows(): Promise<Show[]> {
  return Promise.resolve([...mockShows]);
}

export async function createShow(data: ShowCreate): Promise<Show> {
  const show: Show = {
    id: nextShowId++,
    name: data.name,
    host: data.host ?? null,
    producer: data.producer ?? null,
    type: data.type ?? 'automated',
    clock_id: data.clock_id ?? null,
    duration_minutes: data.duration_minutes ?? 60,
    color: data.color ?? 'indigo',
    notes: data.notes ?? null,
    active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockShows.push(show);
  return Promise.resolve(show);
}

export async function fetchShow(id: number): Promise<Show> {
  const show = mockShows.find((s) => s.id === id);
  if (!show) throw new Error(`Show ${id} not found`);
  return Promise.resolve(show);
}

export async function updateShow(id: number, patch: ShowPatch): Promise<Show> {
  const idx = mockShows.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Show ${id} not found`);
  const updated = { ...mockShows[idx], ...patch, updated_at: new Date() };
  mockShows[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteShow(id: number): Promise<void> {
  const idx = mockShows.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`Show ${id} not found`);
  mockShows.splice(idx, 1);
  return Promise.resolve();
}

// ============ CLOCKS ============

let mockClocks: Clock[] = [
  {
    id: 1,
    name: 'Standard Hour',
    description: 'Default weekday rotation',
    segments: [
      { id: 's1', type: 'music',   duration_minutes: 12, label: null },
      { id: 's2', type: 'jingle',  duration_minutes: 1,  label: 'Station ID' },
      { id: 's3', type: 'ad',      duration_minutes: 3,  label: 'Ad break 1' },
      { id: 's4', type: 'music',   duration_minutes: 12, label: null },
      { id: 's5', type: 'jingle',  duration_minutes: 1,  label: null },
      { id: 's6', type: 'ad',      duration_minutes: 3,  label: 'Ad break 2' },
      { id: 's7', type: 'music',   duration_minutes: 12, label: null },
      { id: 's8', type: 'promo',   duration_minutes: 2,  label: null },
      { id: 's9', type: 'music',   duration_minutes: 14, label: null },
    ],
    created_at: new Date('2026-03-01'),
    updated_at: new Date('2026-03-01'),
  },
  {
    id: 2,
    name: 'Morning Drive',
    description: 'High ad load for prime time',
    segments: [
      { id: 'm1', type: 'live',    duration_minutes: 3,  label: 'Host intro' },
      { id: 'm2', type: 'music',   duration_minutes: 8,  label: null },
      { id: 'm3', type: 'news',    duration_minutes: 3,  label: 'Headlines' },
      { id: 'm4', type: 'ad',      duration_minutes: 4,  label: 'Ad break 1' },
      { id: 'm5', type: 'music',   duration_minutes: 8,  label: null },
      { id: 'm6', type: 'jingle',  duration_minutes: 1,  label: null },
      { id: 'm7', type: 'ad',      duration_minutes: 4,  label: 'Ad break 2' },
      { id: 'm8', type: 'music',   duration_minutes: 8,  label: null },
      { id: 'm9', type: 'promo',   duration_minutes: 2,  label: null },
      { id: 'm10', type: 'ad',     duration_minutes: 4,  label: 'Ad break 3' },
      { id: 'm11', type: 'music',  duration_minutes: 8,  label: null },
      { id: 'm12', type: 'live',   duration_minutes: 3,  label: 'Traffic & weather' },
    ],
    created_at: new Date('2026-03-01'),
    updated_at: new Date('2026-03-01'),
  },
  {
    id: 3,
    name: 'Overnight',
    description: 'Minimal interruption, mostly music',
    segments: [
      { id: 'o1', type: 'music',   duration_minutes: 25, label: null },
      { id: 'o2', type: 'jingle',  duration_minutes: 1,  label: 'Station ID' },
      { id: 'o3', type: 'ad',      duration_minutes: 2,  label: null },
      { id: 'o4', type: 'music',   duration_minutes: 32, label: null },
    ],
    created_at: new Date('2026-03-01'),
    updated_at: new Date('2026-03-01'),
  },
];

let nextClockId = 4;

export async function fetchClocks(): Promise<Clock[]> {
  return Promise.resolve([...mockClocks]);
}

export async function createClock(data: ClockCreate): Promise<Clock> {
  const clock: Clock = {
    id: nextClockId++,
    name: data.name,
    description: data.description ?? null,
    segments: data.segments ?? [],
    created_at: new Date(),
    updated_at: new Date(),
  };
  mockClocks.push(clock);
  return Promise.resolve(clock);
}

export async function updateClock(id: number, patch: ClockPatch): Promise<Clock> {
  const idx = mockClocks.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Clock ${id} not found`);
  const updated = { ...mockClocks[idx], ...patch, updated_at: new Date() };
  mockClocks[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteClock(id: number): Promise<void> {
  const idx = mockClocks.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`Clock ${id} not found`);
  mockClocks.splice(idx, 1);
  return Promise.resolve();
}

// ============ TEMPLATE ENTRIES ============

function makeEntries(
  startId: number,
  days: number[],
  timeStart: string,
  timeEnd: string,
  showId: number,
  clockId: number | null,
): TemplateEntry[] {
  return days.map((day, i) => ({
    id: startId + i,
    day_of_week: day,
    time_start: timeStart,
    time_end: timeEnd,
    show_id: showId,
    clock_id: clockId,
  }));
}

let mockTemplateEntries: TemplateEntry[] = [
  ...makeEntries(1,  [1,2,3,4,5],   '06:00', '10:00', 1, 2), // Morning Drive
  ...makeEntries(6,  [1,2,3,4,5],   '10:00', '15:00', 2, 1), // Midday Mix
  ...makeEntries(11, [1,2,3,4,5],   '15:00', '19:00', 3, 1), // Afternoon Drive
  ...makeEntries(16, [1,2,3,4,5],   '19:00', '23:00', 4, 1), // Evening Vibes
  ...makeEntries(21, [1,2,3,4,5,6,7], '23:00', '06:00', 5, 3), // Overnight Auto
  ...makeEntries(28, [6,7],          '08:00', '12:00', 6, 1), // Weekend Morning
  ...makeEntries(30, [6,7],          '12:00', '23:00', 7, 1), // Weekend Afternoon
];

let nextTemplateEntryId = 32;

export async function fetchTemplateEntries(): Promise<TemplateEntry[]> {
  return Promise.resolve([...mockTemplateEntries]);
}

export async function createTemplateEntry(data: TemplateEntryCreate): Promise<TemplateEntry> {
  const entry: TemplateEntry = {
    id: nextTemplateEntryId++,
    day_of_week: data.day_of_week,
    time_start: data.time_start,
    time_end: data.time_end,
    show_id: data.show_id ?? null,
    clock_id: data.clock_id ?? null,
  };
  mockTemplateEntries.push(entry);
  return Promise.resolve(entry);
}

export async function updateTemplateEntry(id: number, patch: TemplateEntryPatch): Promise<TemplateEntry> {
  const idx = mockTemplateEntries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`TemplateEntry ${id} not found`);
  const updated = { ...mockTemplateEntries[idx], ...patch };
  mockTemplateEntries[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteTemplateEntry(id: number): Promise<void> {
  const idx = mockTemplateEntries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`TemplateEntry ${id} not found`);
  mockTemplateEntries.splice(idx, 1);
  return Promise.resolve();
}

// ============ CALENDAR ENTRIES ============

let mockCalendarEntries: CalendarEntry[] = [];
let nextCalendarEntryId = 1;

export async function fetchCalendarEntries(weekStart?: string): Promise<CalendarEntry[]> {
  if (!weekStart) return Promise.resolve([...mockCalendarEntries]);
  const start = new Date(weekStart);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return Promise.resolve(
    mockCalendarEntries.filter((e) => {
      const d = new Date(e.date);
      return d >= start && d < end;
    }),
  );
}

export async function createCalendarEntry(data: CalendarEntryCreate): Promise<CalendarEntry> {
  const entry: CalendarEntry = {
    id: nextCalendarEntryId++,
    date: data.date,
    time_start: data.time_start,
    time_end: data.time_end,
    show_id: data.show_id ?? null,
    clock_id: data.clock_id ?? null,
    is_override: data.is_override ?? false,
  };
  mockCalendarEntries.push(entry);
  return Promise.resolve(entry);
}

export async function updateCalendarEntry(id: number, patch: CalendarEntryPatch): Promise<CalendarEntry> {
  const idx = mockCalendarEntries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`CalendarEntry ${id} not found`);
  const updated = { ...mockCalendarEntries[idx], ...patch };
  mockCalendarEntries[idx] = updated;
  return Promise.resolve(updated);
}

export async function deleteCalendarEntry(id: number): Promise<void> {
  const idx = mockCalendarEntries.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error(`CalendarEntry ${id} not found`);
  mockCalendarEntries.splice(idx, 1);
  return Promise.resolve();
}

// ─── Template clock entries ───────────────────────────────────────────────────

let mockTemplateClockEntries: TemplateClockEntry[] = [];
let nextTCEId = 1;

export async function fetchTemplateClockEntries(): Promise<TemplateClockEntry[]> {
  return Promise.resolve([...mockTemplateClockEntries]);
}

export async function upsertTemplateClockEntry(data: TemplateClockEntryUpsert): Promise<TemplateClockEntry> {
  const idx = mockTemplateClockEntries.findIndex(
    (e) => e.day_of_week === data.day_of_week && e.hour === data.hour,
  );
  if (idx !== -1) {
    mockTemplateClockEntries[idx] = { ...mockTemplateClockEntries[idx], clock_id: data.clock_id };
    return Promise.resolve(mockTemplateClockEntries[idx]);
  }
  const entry: TemplateClockEntry = { id: nextTCEId++, ...data };
  mockTemplateClockEntries.push(entry);
  return Promise.resolve(entry);
}

export async function deleteTemplateClockEntry(id: number): Promise<void> {
  const idx = mockTemplateClockEntries.findIndex((e) => e.id === id);
  if (idx !== -1) mockTemplateClockEntries.splice(idx, 1);
  return Promise.resolve();
}
