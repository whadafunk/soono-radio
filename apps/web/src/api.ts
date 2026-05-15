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
  User,
  UserCreate,
  UserPatch,
  FacetsResponse,
  FacetsResponseSchema,
  BackgroundJob,
  ActivityStats,
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
  // Facet filters
  genre?: string;
  artist?: string;
  decade?: string;
  dur_bucket?: string;
  energy_bucket?: string;
  identified?: 'yes' | 'no';
  bpm_min?: number;
  bpm_max?: number;
  mood?: string;
  key?: string;
}

export interface LibraryFacetsParams {
  q?: string;
  category?: string;
  favorite?: boolean;
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
  if (params.genre) search.set('genre', params.genre);
  if (params.artist) search.set('artist', params.artist);
  if (params.decade) search.set('decade', params.decade);
  if (params.dur_bucket) search.set('dur_bucket', params.dur_bucket);
  if (params.energy_bucket) search.set('energy_bucket', params.energy_bucket);
  if (params.identified) search.set('identified', params.identified);
  if (params.bpm_min !== undefined) search.set('bpm_min', String(params.bpm_min));
  if (params.bpm_max !== undefined) search.set('bpm_max', String(params.bpm_max));
  if (params.mood) search.set('mood', params.mood);
  if (params.key) search.set('key', params.key);

  const res = await fetch(`${API_BASE}/library?${search.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch library: ${res.statusText}`);
  const data = await res.json();
  return {
    ...data,
    items: data.items.map((i: unknown) => MediaSchema.parse(i)),
  };
}

export async function fetchLibraryFacets(params: LibraryFacetsParams = {}): Promise<FacetsResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.category) search.set('category', params.category);
  if (params.favorite !== undefined) search.set('favorite', String(params.favorite));
  const res = await fetch(`${API_BASE}/library/facets?${search.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch library facets: ${res.statusText}`);
  return FacetsResponseSchema.parse(await res.json());
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

export interface AcoustIDCandidate {
  acoustid: string;
  score: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  source: 'acoustid' | 'musicbrainz' | 'filename';
  fromFreeText?: boolean;
}

export type { BackgroundJob, ActivityStats };

export async function analyseLibraryItem(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/library/${id}/analyse`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Analyse failed: ${res.statusText}`);
  }
}

export async function lookupAcoustID(id: number): Promise<{ candidates: AcoustIDCandidate[]; auto_apply: boolean }> {
  const res = await fetch(`${API_BASE}/library/${id}/acoustid`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Lookup failed: ${res.statusText}`);
  }
  return res.json();
}

export async function bulkLookupAcoustID(ids: number[]): Promise<{ job_id: string }> {
  const res = await fetch(`${API_BASE}/library/bulk-acoustid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Bulk lookup failed: ${res.statusText}`);
  }
  return res.json();
}

export interface PlaylistSummary {
  id: number;
  name: string;
  type: string;
  kind: string;
  is_default?: boolean;
}

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  const res = await fetch(`${API_BASE}/playlists`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createPlaylist(body: { name: string; type: string; kind: 'static' }): Promise<PlaylistSummary> {
  const res = await fetch(`${API_BASE}/playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function addTracksToPlaylist(playlistId: number, mediaIds: number[]): Promise<void> {
  const res = await fetch(`${API_BASE}/playlists/${playlistId}/tracks/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_ids: mediaIds }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function bulkAnalyseAll(ids: number[]): Promise<{ job_id: string }> {
  const res = await fetch(`${API_BASE}/library/bulk-analyse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Bulk analyse failed: ${res.statusText}`);
  }
  return res.json();
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

import {
  IntegrationsConfig,
  IntegrationsConfigSchema,
  Customer,
  CustomerCreate,
  CustomerPatch,
  Campaign,
  CampaignCreate,
  CampaignPatch,
  CampaignWithCustomer,
  Contact,
  CustomerContact,
  ContactCreate,
  ContactPatch,
  Show,
  ShowCreate,
  ShowPatch,
  ShowPlaylist,
  ShowPlaylistCreate,
  ShowPlaylistPatch,
  Clock,
  ClockCreate,
  ClockPatch,
  ClockSegment,
  ClockSegmentCreate,
  TemplateEntry,
  TemplateEntryCreate,
  TemplateEntryPatch,
  CalendarEntry,
  CalendarEntryCreate,
  CalendarEntryPatch,
  TemplateClockEntry,
  TemplateClockEntryUpsert,
  CampaignMedia,
  CampaignMediaCreate,
  CampaignMediaWithMedia,
  Rotation,
  RotationCreate,
  RotationPatch,
} from '@radio/shared';

export type CampaignMediaAdd = CampaignMediaCreate & {
  title?: string | null;
  artist?: string | null;
  duration_seconds?: number | null;
  original_filename?: string | null;
};

// ─── Fetch helper ────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function post<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<void> {
  return apiFetch<void>(path, { method: 'DELETE' });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Customers ────────────────────────────────────────────────────────────────

export function fetchCustomers(): Promise<Customer[]> {
  return apiFetch('/customers');
}

export function createCustomer(data: CustomerCreate): Promise<Customer> {
  return post('/customers', data);
}

export function fetchCustomer(id: number): Promise<Customer> {
  return apiFetch(`/customers/${id}`);
}

export function updateCustomer(id: number, patch_: CustomerPatch): Promise<Customer> {
  return patch(`/customers/${id}`, patch_);
}

export function deleteCustomer(id: number): Promise<void> {
  return del(`/customers/${id}`);
}

export async function deleteCustomers(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => del(`/customers/${id}`)));
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export function fetchCampaigns(customerId?: number): Promise<CampaignWithCustomer[]> {
  const qs = customerId ? `?customer_id=${customerId}` : '';
  return apiFetch(`/campaigns${qs}`);
}

export function createCampaign(data: CampaignCreate): Promise<Campaign> {
  return post('/campaigns', data);
}

export function fetchCampaign(id: number): Promise<Campaign> {
  return apiFetch(`/campaigns/${id}`);
}

export function updateCampaign(id: number, patch_: CampaignPatch): Promise<Campaign> {
  return patch(`/campaigns/${id}`, patch_);
}

export function deleteCampaign(id: number): Promise<void> {
  return del(`/campaigns/${id}`);
}

export async function deleteCampaigns(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => del(`/campaigns/${id}`)));
}

export function fetchCampaignPacing(id: number): Promise<{ plays_this_month: number; target: number; pct: number; on_track: boolean }> {
  return apiFetch(`/campaigns/${id}/pacing`);
}

// ─── Campaign Media ───────────────────────────────────────────────────────────

export function fetchCampaignMedia(campaignId: number): Promise<CampaignMediaWithMedia[]> {
  return apiFetch(`/campaigns/${campaignId}/media`);
}

export function addCampaignMedia(campaignId: number, data: CampaignMediaAdd): Promise<CampaignMediaWithMedia> {
  return post(`/campaigns/${campaignId}/media`, {
    media_id: data.media_id,
    play_as_spot: data.play_as_spot ?? true,
    play_as_sweep: data.play_as_sweep ?? false,
  });
}

export function updateCampaignMedia(
  id: number,
  patch_: { play_as_spot?: boolean; play_as_sweep?: boolean },
): Promise<CampaignMediaWithMedia> {
  return patch(`/campaign-media/${id}`, patch_);
}

export function removeCampaignMedia(id: number): Promise<void> {
  return del(`/campaign-media/${id}`);
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export function fetchAllContacts(): Promise<Contact[]> {
  return apiFetch('/contacts');
}

export function fetchContacts(customerId?: number): Promise<(Contact & { is_primary: boolean })[]> {
  if (!customerId) return apiFetch<Contact[]>('/contacts').then((cs) => cs.map((c) => ({ ...c, is_primary: false })));
  return apiFetch(`/customers/${customerId}/contacts`);
}

export function fetchContactCustomers(contactId: number): Promise<Customer[]> {
  return apiFetch(`/contacts/${contactId}/customers`);
}

export function fetchContactsWithCustomers(): Promise<(Contact & { customer_names: string[]; customer_ids: number[] })[]> {
  return apiFetch('/contacts/with-customers');
}

export function associateContact(customerId: number, contactId: number, isPrimary = false): Promise<void> {
  return post(`/customers/${customerId}/contacts/${contactId}`, { is_primary: isPrimary });
}

export function dissociateContact(customerId: number, contactId: number): Promise<void> {
  return del(`/customers/${customerId}/contacts/${contactId}`);
}

export function setContactPrimary(customerId: number, contactId: number, isPrimary: boolean): Promise<void> {
  return patch(`/customers/${customerId}/contacts/${contactId}/primary`, { is_primary: isPrimary });
}

export function createContact(data: ContactCreate): Promise<Contact> {
  return post('/contacts', data);
}

export function fetchContact(id: number): Promise<Contact> {
  return apiFetch(`/contacts/${id}`);
}

export function updateContact(id: number, patch_: ContactPatch): Promise<Contact> {
  return patch(`/contacts/${id}`, patch_);
}

export function deleteContact(id: number): Promise<void> {
  return del(`/contacts/${id}`);
}

export async function deleteContacts(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => del(`/contacts/${id}`)));
}

// ─── Shows ────────────────────────────────────────────────────────────────────

export function fetchShows(): Promise<Show[]> {
  return apiFetch('/shows');
}

export function createShow(data: ShowCreate): Promise<Show> {
  return post('/shows', data);
}

export function fetchShow(id: number): Promise<Show> {
  return apiFetch(`/shows/${id}`);
}

export function updateShow(id: number, patch_: ShowPatch): Promise<Show> {
  return patch(`/shows/${id}`, patch_);
}

export function deleteShow(id: number): Promise<void> {
  return del(`/shows/${id}`);
}

export function fetchShowPlaylists(showId: number): Promise<ShowPlaylist[]> {
  return apiFetch(`/shows/${showId}/playlists`);
}

export function addShowPlaylist(showId: number, data: ShowPlaylistCreate): Promise<ShowPlaylist> {
  return post(`/shows/${showId}/playlists`, data);
}

export function updateShowPlaylist(showId: number, spid: number, data: ShowPlaylistPatch): Promise<ShowPlaylist> {
  return patch(`/shows/${showId}/playlists/${spid}`, data);
}

export function removeShowPlaylist(showId: number, spid: number): Promise<void> {
  return del(`/shows/${showId}/playlists/${spid}`);
}

// ─── Clocks ───────────────────────────────────────────────────────────────────

export function fetchClocks(): Promise<Clock[]> {
  return apiFetch('/clocks');
}

export function fetchClockSegments(clockId: number): Promise<ClockSegment[]> {
  return apiFetch(`/clocks/${clockId}/segments`);
}

export function createClock(data: ClockCreate): Promise<Clock> {
  return post('/clocks', data);
}

export function updateClock(id: number, patch_: ClockPatch): Promise<Clock> {
  return patch(`/clocks/${id}`, patch_);
}

export function replaceClockSegments(clockId: number, segments: ClockSegmentCreate[]): Promise<ClockSegment[]> {
  return put(`/clocks/${clockId}/segments`, segments);
}

export function deleteClock(id: number): Promise<void> {
  return del(`/clocks/${id}`);
}

// ─── Rotations ────────────────────────────────────────────────────────────────

export function fetchRotations(): Promise<Rotation[]> {
  return apiFetch('/rotations');
}

export function createRotation(data: RotationCreate): Promise<Rotation> {
  return post('/rotations', data);
}

export function updateRotation(id: number, patch_: RotationPatch): Promise<Rotation> {
  return patch(`/rotations/${id}`, patch_);
}

export function deleteRotation(id: number): Promise<void> {
  return del(`/rotations/${id}`);
}

// ─── Template Entries ─────────────────────────────────────────────────────────

export function fetchTemplateEntries(): Promise<TemplateEntry[]> {
  return apiFetch('/template-entries');
}

export function createTemplateEntry(data: TemplateEntryCreate): Promise<TemplateEntry> {
  return post('/template-entries', data);
}

export function updateTemplateEntry(id: number, patch_: TemplateEntryPatch): Promise<TemplateEntry> {
  return patch(`/template-entries/${id}`, patch_);
}

export function deleteTemplateEntry(id: number): Promise<void> {
  return del(`/template-entries/${id}`);
}

// ─── Calendar Entries ─────────────────────────────────────────────────────────

export function fetchCalendarEntries(weekStart?: string): Promise<CalendarEntry[]> {
  const qs = weekStart ? `?week_start=${weekStart}` : '';
  return apiFetch(`/calendar-entries${qs}`);
}

export function createCalendarEntry(data: CalendarEntryCreate): Promise<CalendarEntry> {
  return post('/calendar-entries', data);
}

export function updateCalendarEntry(id: number, patch_: CalendarEntryPatch): Promise<CalendarEntry> {
  return patch(`/calendar-entries/${id}`, patch_);
}

export function deleteCalendarEntry(id: number): Promise<void> {
  return del(`/calendar-entries/${id}`);
}

// ─── Template Clock Entries ───────────────────────────────────────────────────

export function fetchTemplateClockEntries(): Promise<TemplateClockEntry[]> {
  return apiFetch('/template-clock-entries');
}

export function upsertTemplateClockEntry(data: TemplateClockEntryUpsert): Promise<TemplateClockEntry> {
  return put('/template-clock-entries', data);
}

export function deleteTemplateClockEntry(id: number): Promise<void> {
  return del(`/template-clock-entries/${id}`);
}

// ─── Users ────────────────────────────────────────────────────────────────────

export function fetchUsers(): Promise<User[]> {
  return apiFetch('/users');
}

export function createUser(data: UserCreate): Promise<User> {
  return post('/users', data);
}

export function updateUser(id: number, patch_: UserPatch): Promise<User> {
  return patch(`/users/${id}`, patch_);
}

export function deleteUser(id: number): Promise<void> {
  return del(`/users/${id}`);
}

export async function deleteUsers(ids: number[]): Promise<void> {
  await Promise.all(ids.map((id) => del(`/users/${id}`)));
}

// ─── Integrations ─────────────────────────────────────────────────────────────

export async function fetchIntegrationsConfig(): Promise<IntegrationsConfig> {
  const data = await apiFetch<unknown>('/integrations/config');
  return IntegrationsConfigSchema.parse(data);
}

export async function updateIntegrationsConfig(config: IntegrationsConfig): Promise<void> {
  await post<void>('/integrations/config', config);
}

// ─── Activity ─────────────────────────────────────────────────────────────────

export function fetchActivityStats(): Promise<ActivityStats> {
  return apiFetch('/activity/stats');
}

export function fetchActivityJobs(): Promise<BackgroundJob[]> {
  return apiFetch<{ jobs: BackgroundJob[] }>('/activity').then((d) => d.jobs);
}

export function fetchActivityJob(id: string): Promise<BackgroundJob> {
  return apiFetch(`/activity/${id}`);
}

export function resolveActivityItem(
  jobId: string,
  mediaId: number,
  action: 'apply' | 'dismiss',
  candidateIndex?: number,
): Promise<{ remaining: number; status: string }> {
  return post(`/activity/${jobId}/resolve`, { media_id: mediaId, action, candidate_index: candidateIndex });
}

export function dismissAllActivityItems(jobId: string): Promise<{ status: string }> {
  return post(`/activity/${jobId}/dismiss-all`, {});
}

export function deleteActivityJob(jobId: string): Promise<void> {
  return del(`/activity/${jobId}`);
}

