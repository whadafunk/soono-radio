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
  SupervisorConfig,
  SupervisorConfigSchema,
  SimulatedPlay,
  User,
  UserCreate,
  UserPatch,
  FacetsResponse,
  FacetsResponseSchema,
  BackgroundJob,
  ActivityStats,
  PromoWithShow,
  PromoCreate,
  PromoPatch,
  PromoMediaWithMedia,
  StationSettings,
  SupervisorV2Status,
  SupervisorV2StatusSchema,
  SupervisorV2ControlResponse,
  SupervisorV2ControlResponseSchema,
  SupervisorV2DriftLedger,
  SupervisorV2DriftLedgerSchema,
  LogSourceId,
  LogSourcesResponse,
  LogSourcesResponseSchema,
  LogTailResponse,
  LogTailResponseSchema,
  LogMaintenanceResponse,
  LogSettings,
  LogSettingsSchema,
  SupervisorV2PlanStory,
  SupervisorV2PlanStorySchema,
  DbStats,
  DbStatsSchema,
  DbSweepResult,
  DbSweepResultSchema,
  MaintenanceSettings,
  MediaIntegrityState,
  MediaIntegrityStateSchema,
  CampaignValidationDraft,
  CampaignValidationResult,
  CampaignValidationResultSchema,
  CampaignValidationSummaryRow,
  CampaignValidationSummaryRowSchema,
  CampaignLedger,
  CampaignLedgerSchema,
} from '@soono/shared';

const API_BASE = '/api';

export interface IcecastStats {
  listener: number;
  peak_listener: number;
  peak_since: string | null;
  bitrate: number;
  uptime: number;
  mount?: string;
}

export async function fetchIcecastConfig(): Promise<IcecastConfig> {
  const res = await fetch(`${API_BASE}/icecast/config`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Failed to fetch Icecast config: ${res.statusText}`);
  }
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

export async function resetPeakListeners(): Promise<{ peak_listener: number; peak_since: string }> {
  const res = await fetch(`${API_BASE}/icecast/stats/peak/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reset peak listeners: ${res.statusText}`);
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
  cn: string | null;
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

export async function assembleCertificate(params: {
  certificate: string;
  chain?: string;
  key: string;
  filename?: string;
}): Promise<{ success: boolean; name: string }> {
  const res = await fetch(`${API_BASE}/certificates/assemble`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to install certificate: ${res.statusText}`);
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

export async function updateLiquidsoapConfig(config: LiquidsoapConfig): Promise<{ recomputed_gain_count?: number }> {
  const res = await fetch(`${API_BASE}/liquidsoap/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`Failed to update Liquidsoap config: ${JSON.stringify(error)}`);
  }
  return res.json();
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
  flagged?: boolean;
  uploadedAfter?: string;
  notInPlaylist?: boolean;
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
  if (params.flagged) search.set('flagged', 'true');
  if (params.uploadedAfter) search.set('uploaded_after', params.uploadedAfter);
  if (params.notInPlaylist) search.set('not_in_playlist', 'true');

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

export async function fetchSimulate(from: Date, to: Date): Promise<SimulatedPlay[]> {
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const res = await fetch(`${API_BASE}/supervisor/simulate?${params}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to simulate: ${res.statusText}`);
  }
  const data = await res.json();
  return data.plays.map((p: any) => ({ ...p, at: new Date(p.at) }));
}

export interface AcoustIDCandidate {
  acoustid: string;
  score: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  source: 'acoustid' | 'musicbrainz' | 'filename' | 'artist-confirmed';
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
  subcategory?: string | null;
  kind: string;
  is_default?: boolean;
  total_seconds?: number;
}

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  const res = await fetch(`${API_BASE}/playlists`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createPlaylist(body: { name: string; type: string; subcategory?: string | null; kind: 'static' }): Promise<PlaylistSummary> {
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
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data?.error ?? data?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
}

export async function removeTrackFromPlaylist(playlistId: number, trackId: number): Promise<void> {
  const res = await fetch(`${API_BASE}/playlists/${playlistId}/tracks/${trackId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message = data?.error ?? data?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
}

export interface PlaylistTrack {
  id: number;
  playlist_id: number;
  media_id: number;
  sort_order: number;
  weight: number;
  title: string | null;
  artist: string | null;
  duration_seconds: number;
  category: string;
  original_filename: string;
}

export async function fetchPlaylistTracks(playlistId: number): Promise<PlaylistTrack[]> {
  const res = await fetch(`${API_BASE}/playlists/${playlistId}/tracks`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

export async function clearIngestJobs(status: 'completed' | 'failed'): Promise<void> {
  const res = await fetch(`${API_BASE}/library/ingest?status=${status}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) throw new Error(`Failed to clear ingest jobs: ${res.statusText}`);
}

export async function fetchIngestJobs(): Promise<IngestJob[]> {
  const res = await fetch(`${API_BASE}/library/ingest`);
  if (!res.ok) throw new Error(`Failed to fetch ingest jobs: ${res.statusText}`);
  const data = await res.json();
  // safeParse so a single row with a stale/unknown category doesn't crash the whole list
  return (data.jobs as unknown[]).flatMap((j) => {
    const result = IngestJobSchema.safeParse(j);
    return result.success ? [result.data] : [];
  });
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
  MusicCampaign,
  MusicCampaignCreate,
  MusicCampaignPatch,
  MusicCampaignWithCustomer,
  MusicCampaignPacing,
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
  TemplateEntryBatchOp,
  EntryBatchResponse,
  CalendarEntry,
  CalendarEntryBatchOp,
  TemplateClockEntry,
  TemplateClockEntryUpsert,
  CampaignMedia,
  CampaignMediaCreate,
  CampaignMediaWithMedia,
  Rotation,
  RotationCreate,
  RotationPatch,
  BroadcastInterval,
  BroadcastIntervalCreate,
  BroadcastIntervalPatch,
  BroadcastIntervalSlot,
  BroadcastIntervalSlotCreate,
  BroadcastIntervalSlotPatch,
} from '@soono/shared';

export type CampaignMediaAdd = CampaignMediaCreate & {
  title?: string | null;
  artist?: string | null;
  duration_seconds?: number | null;
  original_filename?: string | null;
};

// ─── Fetch helper ────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => ''); }
    throw new ApiError(res.status, body, `${init?.method ?? 'GET'} ${path} → ${res.status}`);
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

// ─── Music Campaigns ──────────────────────────────────────────────────────────

export function fetchMusicCampaigns(opts?: { customer_id?: number; active?: boolean }): Promise<MusicCampaignWithCustomer[]> {
  const params = new URLSearchParams();
  if (opts?.customer_id != null) params.set('customer_id', String(opts.customer_id));
  if (opts?.active != null) params.set('active', String(opts.active));
  const qs = params.toString();
  return apiFetch(`/music-campaigns${qs ? `?${qs}` : ''}`);
}

export function fetchMusicCampaign(id: number): Promise<MusicCampaign> {
  return apiFetch(`/music-campaigns/${id}`);
}

export function createMusicCampaign(data: MusicCampaignCreate): Promise<MusicCampaign> {
  return post('/music-campaigns', data);
}

export function updateMusicCampaign(id: number, patch_: MusicCampaignPatch): Promise<MusicCampaign> {
  return patch(`/music-campaigns/${id}`, patch_);
}

export function deleteMusicCampaign(id: number): Promise<void> {
  return del(`/music-campaigns/${id}`);
}

export function fetchMusicCampaignPacing(id: number): Promise<MusicCampaignPacing> {
  return apiFetch(`/music-campaigns/${id}/pacing`);
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
  patch_: { play_as_spot?: boolean; play_as_sweep?: boolean; weight?: number },
): Promise<CampaignMediaWithMedia> {
  return patch(`/campaign-media/${id}`, patch_);
}

export function removeCampaignMedia(id: number): Promise<void> {
  return del(`/campaign-media/${id}`);
}

// ─── Broadcast Intervals ──────────────────────────────────────────────────────

export function fetchIntervals(): Promise<BroadcastInterval[]> {
  return apiFetch('/intervals');
}

export function createInterval(data: BroadcastIntervalCreate): Promise<BroadcastInterval> {
  return post('/intervals', data);
}

export function updateInterval(id: number, patch_: BroadcastIntervalPatch): Promise<BroadcastInterval> {
  return patch(`/intervals/${id}`, patch_);
}

export function deleteInterval(id: number): Promise<void> {
  return del(`/intervals/${id}`);
}

// ─── Promos ───────────────────────────────────────────────────────────────────

export function fetchPromos(): Promise<PromoWithShow[]> {
  return apiFetch('/promos');
}

export function createPromo(data: PromoCreate): Promise<PromoWithShow> {
  return post('/promos', data);
}

export function updatePromo(id: number, patch_: PromoPatch): Promise<PromoWithShow> {
  return patch(`/promos/${id}`, patch_);
}

export function deletePromo(id: number): Promise<void> {
  return del(`/promos/${id}`);
}

// ─── Promo Media ──────────────────────────────────────────────────────────────

export function fetchPromoMedia(promoId: number): Promise<PromoMediaWithMedia[]> {
  return apiFetch(`/promos/${promoId}/media`);
}

export function addPromoMedia(promoId: number, mediaId: number): Promise<PromoMediaWithMedia> {
  return post(`/promos/${promoId}/media`, { media_id: mediaId });
}

export function removePromoMedia(id: number): Promise<void> {
  return del(`/promo-media/${id}`);
}

export function fetchIntervalSlots(): Promise<BroadcastIntervalSlot[]> {
  return apiFetch('/interval-slots');
}

export function createIntervalSlot(data: BroadcastIntervalSlotCreate): Promise<BroadcastIntervalSlot> {
  return post('/interval-slots', data);
}

export function updateIntervalSlot(id: number, patch_: BroadcastIntervalSlotPatch): Promise<BroadcastIntervalSlot> {
  return patch(`/interval-slots/${id}`, patch_);
}

export function deleteIntervalSlot(id: number): Promise<void> {
  return del(`/interval-slots/${id}`);
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

export type ShowCampaign = {
  id: number;
  name: string;
  customer_id: number;
  customer_name: string;
  plays_per_show: number | null;
  active: boolean;
};

export function fetchShowCampaigns(showId: number): Promise<ShowCampaign[]> {
  return apiFetch(`/shows/${showId}/campaigns`);
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

export function deleteClockSegment(clockId: number, segmentId: number): Promise<void> {
  return del(`/clocks/${clockId}/segments/${segmentId}`);
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

export function batchTemplateEntries(ops: TemplateEntryBatchOp[]): Promise<EntryBatchResponse> {
  return post('/template-entries/batch', { ops });
}

// ─── Calendar Entries ─────────────────────────────────────────────────────────

export function fetchCalendarEntries(weekStart?: string): Promise<CalendarEntry[]> {
  const qs = weekStart ? `?week_start=${weekStart}` : '';
  return apiFetch(`/calendar-entries${qs}`);
}

export function batchCalendarEntries(ops: CalendarEntryBatchOp[]): Promise<EntryBatchResponse> {
  return post('/calendar-entries/batch', { ops });
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

// ─── Rundown Show Content ─────────────────────────────────────────────────────

export interface RundownSlotContent {
  id: number;
  date: string;
  time_start: string;
  clock_id: number;
  segment_type: string;
  playlist_id: number | null;
  playlist_name: string | null;
}

export function fetchRundownSlotContent(dateFrom: string, dateTo: string): Promise<RundownSlotContent[]> {
  return apiFetch(`/rundown/slot-content?date_from=${dateFrom}&date_to=${dateTo}`);
}

export interface RundownShowContentUpsert {
  date: string;
  time_start: string;
  clock_id: number;
  segment_type: 'news' | 'bulletin';
  playlist_id: number;
}

export function upsertRundownShowContent(data: RundownShowContentUpsert): Promise<{ id: number; playlist_name: string | null }> {
  return put('/rundown/show-content', data);
}

export function deleteRundownShowContent(id: number): Promise<void> {
  return del(`/rundown/show-content/${id}`);
}

// ─── Apply Template ───────────────────────────────────────────────────────────

export function clearCalendar(): Promise<void> {
  return del('/calendar-entries');
}

export function applyTemplate(data: {
  date_from: string;
  date_to: string;
  mode: 'fill' | 'override';
}): Promise<{ created: number; skipped: number; deleted: number }> {
  return post('/apply-template', data);
}

// ─── Station Settings ─────────────────────────────────────────────────────────

export function fetchStationSettings(): Promise<StationSettings> {
  return apiFetch('/settings/station');
}

export function updateStationSettings(data: Partial<StationSettings>): Promise<StationSettings> {
  return patch('/settings/station', data);
}

// ─── Spot Budget ──────────────────────────────────────────────────────────────

import type {
  SpotBudgetOverview,
  SpotBudgetDetails,
  CampaignAvailable,
  CampaignPacingDetail,
} from '@soono/shared';

export function fetchSpotBudget(
  start: string,
  end: string,
  mode: 'estimated' | 'remaining' = 'estimated',
): Promise<SpotBudgetOverview> {
  const qs = new URLSearchParams({ mode, start, end });
  return apiFetch(`/spot-budget?${qs}`);
}

export function fetchSpotBudgetDetails(
  start: string,
  end: string,
  mode: 'estimated' | 'remaining' = 'estimated',
): Promise<SpotBudgetDetails> {
  const qs = new URLSearchParams({ mode, start, end });
  return apiFetch(`/spot-budget/details?${qs}`);
}

export function fetchCampaignBudget(
  campaignId: number,
  start: string,
  end: string,
  mode: 'estimated' | 'remaining' = 'estimated',
): Promise<CampaignAvailable> {
  const qs = new URLSearchParams({ mode, start, end });
  return apiFetch(`/spot-budget/campaign/${campaignId}?${qs}`);
}

export function fetchSpotBudgetPacing(campaignId: number): Promise<CampaignPacingDetail> {
  return apiFetch(`/spot-budget/campaign/${campaignId}/pacing`);
}

export async function fetchSupervisorV2Status(): Promise<SupervisorV2Status> {
  const res = await fetch(`${API_BASE}/supervisor/v2/status`);
  if (!res.ok) throw new Error(`Failed to fetch supervisor v2 status: ${res.statusText}`);
  return SupervisorV2StatusSchema.parse(await res.json());
}

export async function fetchSupervisorV2DriftLedger(limit = 48): Promise<SupervisorV2DriftLedger> {
  const res = await fetch(`${API_BASE}/supervisor/v2/drift-ledger?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch drift ledger: ${res.statusText}`);
  return SupervisorV2DriftLedgerSchema.parse(await res.json());
}

export async function postSupervisorSkip(): Promise<SupervisorV2ControlResponse> {
  const res = await fetch(`${API_BASE}/supervisor/v2/skip`, { method: 'POST' });
  if (!res.ok) throw new Error(`Skip failed: ${res.statusText}`);
  return SupervisorV2ControlResponseSchema.parse(await res.json());
}

export async function postSupervisorAlignToWallClock(): Promise<SupervisorV2ControlResponse> {
  const res = await fetch(`${API_BASE}/supervisor/v2/align-to-wall-clock`, { method: 'POST' });
  if (!res.ok) throw new Error(`Reconcile failed: ${res.statusText}`);
  return SupervisorV2ControlResponseSchema.parse(await res.json());
}

export async function postSupervisorAlignToClock(): Promise<SupervisorV2ControlResponse> {
  const res = await fetch(`${API_BASE}/supervisor/v2/align-to-clock`, { method: 'POST' });
  if (!res.ok) throw new Error(`Align to Clock failed: ${res.statusText}`);
  return SupervisorV2ControlResponseSchema.parse(await res.json());
}

// D108 — after a schedule-affecting save, asks whether the running
// supervisor applied the edit immediately or deferred it (station airing
// ahead of wall clock). Best-effort: failures resolve 'immediate' so a
// status hiccup never blocks the save feedback itself.
export async function fetchEditReconcilePreview(): Promise<'immediate' | 'deferred' | 'idle'> {
  try {
    const res = await fetch(`${API_BASE}/supervisor/v2/edit-reconcile-preview`);
    if (!res.ok) return 'immediate';
    const body = (await res.json()) as { outcome?: string };
    return body.outcome === 'deferred' || body.outcome === 'idle' ? body.outcome : 'immediate';
  } catch {
    return 'immediate';
  }
}


// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function fetchLogSources(): Promise<LogSourcesResponse> {
  const res = await fetch(`${API_BASE}/logs/sources`);
  if (!res.ok) throw new Error(`Failed to fetch log sources: ${res.statusText}`);
  return LogSourcesResponseSchema.parse(await res.json());
}

export async function fetchLogTail(query: {
  source: LogSourceId;
  limit?: number;
  level_min?: number;
  process?: string;
  event?: string;
  q?: string;
}): Promise<LogTailResponse> {
  const params = new URLSearchParams();
  params.set('source', query.source);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.level_min != null) params.set('level_min', String(query.level_min));
  if (query.process) params.set('process', query.process);
  if (query.event) params.set('event', query.event);
  if (query.q) params.set('q', query.q);
  const res = await fetch(`${API_BASE}/logs/tail?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch log tail: ${res.statusText}`);
  return LogTailResponseSchema.parse(await res.json());
}

export async function rotateLogSource(source: LogSourceId): Promise<LogMaintenanceResponse> {
  const res = await fetch(`${API_BASE}/logs/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Rotate failed: ${res.statusText}`);
  }
  return res.json();
}

export async function purgeLogSource(source: LogSourceId): Promise<LogMaintenanceResponse> {
  const res = await fetch(`${API_BASE}/logs/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Purge failed: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchLogSettings(): Promise<LogSettings> {
  const res = await fetch(`${API_BASE}/logs/settings`);
  if (!res.ok) throw new Error(`Failed to fetch log settings: ${res.statusText}`);
  return LogSettingsSchema.parse(await res.json());
}

export async function updateLogSettings(settings: LogSettings): Promise<LogSettings> {
  const res = await fetch(`${API_BASE}/logs/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Save failed: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchSupervisorV2PlanStory(planId: number): Promise<SupervisorV2PlanStory> {
  const res = await fetch(`${API_BASE}/supervisor/v2/plans/${planId}/story`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Failed to fetch plan story: ${res.statusText}`);
  }
  return SupervisorV2PlanStorySchema.parse(await res.json());
}

export async function fetchDbStats(): Promise<DbStats> {
  const res = await fetch(`${API_BASE}/maintenance/db-stats`);
  if (!res.ok) throw new Error(`Failed to fetch database stats: ${res.statusText}`);
  return DbStatsSchema.parse(await res.json());
}

export async function updateMaintenanceSettings(settings: MaintenanceSettings): Promise<MaintenanceSettings> {
  const res = await fetch(`${API_BASE}/maintenance/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Save failed: ${res.statusText}`);
  }
  return res.json();
}

export async function runDbSweep(): Promise<DbSweepResult> {
  const res = await fetch(`${API_BASE}/maintenance/db-sweep`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Sweep failed: ${res.statusText}`);
  }
  return DbSweepResultSchema.parse(await res.json());
}

export async function fetchMediaIntegrityState(): Promise<MediaIntegrityState> {
  const res = await fetch(`${API_BASE}/maintenance/media-integrity`);
  if (!res.ok) throw new Error(`Failed to fetch integrity state: ${res.statusText}`);
  return MediaIntegrityStateSchema.parse(await res.json());
}

export async function fetchCampaignLedger(campaignId: number): Promise<CampaignLedger> {
  const res = await fetch(`${API_BASE}/campaigns/${campaignId}/ledger`);
  if (!res.ok) throw new Error(`Failed to fetch delivery ledger: ${res.statusText}`);
  return CampaignLedgerSchema.parse(await res.json());
}

export async function validateCampaign(draft: CampaignValidationDraft): Promise<CampaignValidationResult> {
  const res = await fetch(`${API_BASE}/campaigns/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Validation failed: ${res.statusText}`);
  }
  return CampaignValidationResultSchema.parse(await res.json());
}

export async function fetchCampaignValidationSummary(): Promise<CampaignValidationSummaryRow[]> {
  const res = await fetch(`${API_BASE}/campaigns/validation-summary`);
  if (!res.ok) throw new Error(`Failed to fetch validation summary: ${res.statusText}`);
  const data = await res.json();
  return (data as unknown[]).map((r) => CampaignValidationSummaryRowSchema.parse(r));
}

export async function runMediaIntegritySweep(): Promise<MediaIntegrityState> {
  const res = await fetch(`${API_BASE}/maintenance/media-integrity/run`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Sweep failed: ${res.statusText}`);
  }
  return MediaIntegrityStateSchema.parse(await res.json());
}
