import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical, Plus, Trash2, Check, X, Search, Loader,
} from 'lucide-react';
import {
  PLAYLIST_TYPES,
  DYNAMIC_RULE_FIELDS,
  type Playlist, type PlaylistCreate,
  type DynamicRules, type DynamicRuleCondition, type DynamicRuleField, type DynamicRuleOp,
  type PlaylistPreview, type MoodConditionValue,
} from '@radio/shared';

// ─── API base ─────────────────────────────────────────────────────────────────

const API = '/api';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function apiDelete(path: string): Promise<void> {
  return apiFetch<void>(path, { method: 'DELETE' });
}

function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrackRow {
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

interface MediaRow {
  id: number;
  title: string | null;
  artist: string | null;
  duration_seconds: number;
  category: string;
  original_filename: string;
}

// ─── Label maps ───────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<DynamicRuleField, string> = {
  genre:             'Genre',
  artist:            'Artist',
  album:             'Album',
  year:              'Year',
  duration_seconds:  'Duration (s)',
  bpm:               'BPM',
  mood:              'Mood',
  energy_level:      'Energy',
  danceability_level:'Danceability',
  tags:              'Tags',
};

const OP_LABELS: Record<DynamicRuleOp, string> = {
  eq:      'is',
  contains:'contains',
  in:      'is one of',
  any_of:  'includes any of',
  all_of:  'includes all of',
  gte:     '≥',
  lte:     '≤',
  between: 'between',
};

// Valid ops per field
const FIELD_OPS: Record<DynamicRuleField, DynamicRuleOp[]> = {
  genre:             ['eq', 'contains'],
  artist:            ['eq', 'contains'],
  album:             ['eq', 'contains'],
  year:              ['eq', 'gte', 'lte', 'between'],
  duration_seconds:  ['gte', 'lte', 'between'],
  bpm:               ['between', 'gte', 'lte'],
  mood:              ['any_of'],
  energy_level:      ['any_of'],
  danceability_level:['any_of'],
  tags:              ['any_of', 'all_of'],
};

const MOOD_LABELS: Record<string, string> = {
  happy:      'Happy',
  sad:        'Sad',
  aggressive: 'Aggressive',
  relaxed:    'Relaxed',
  party:      'Party',
  acoustic:   'Acoustic',
  electronic: 'Electronic',
};

const MOOD_COLORS: Record<string, string> = {
  happy:      'bg-yellow-500/20 text-yellow-300 border-yellow-700/50',
  sad:        'bg-blue-500/20 text-blue-300 border-blue-700/50',
  aggressive: 'bg-red-500/20 text-red-300 border-red-700/50',
  relaxed:    'bg-teal-500/20 text-teal-300 border-teal-700/50',
  party:      'bg-pink-500/20 text-pink-300 border-pink-700/50',
  acoustic:   'bg-amber-500/20 text-amber-300 border-amber-700/50',
  electronic: 'bg-violet-500/20 text-violet-300 border-violet-700/50',
};

const TYPE_LABELS: Record<(typeof PLAYLIST_TYPES)[number], string> = {
  music: 'Music',
  jingle: 'Jingle',
  bed: 'Bed',
  promo: 'Promo',
  spot: 'Spot',
};

const TYPE_COLORS: Record<(typeof PLAYLIST_TYPES)[number], string> = {
  music:  'bg-blue-600/20 text-blue-300 border border-blue-700/40',
  jingle: 'bg-emerald-600/20 text-emerald-300 border border-emerald-700/40',
  bed:    'bg-amber-600/20 text-amber-300 border border-amber-700/40',
  promo:  'bg-violet-600/20 text-violet-300 border border-violet-700/40',
  spot:   'bg-rose-600/20 text-rose-300 border border-rose-700/40',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function fmtTotalDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function defaultValueForField(field: DynamicRuleField, op: DynamicRuleOp): DynamicRuleCondition['value'] {
  if (field === 'mood') return { moods: [], min_score: 0.5 };
  if (field === 'tags' || field === 'energy_level' || field === 'danceability_level') return [];
  if (op === 'between') return field === 'bpm' ? [60, 180] : [0, 0];
  if (op === 'in') return [];
  if (op === 'gte' || op === 'lte' || op === 'eq') {
    if (field === 'year' || field === 'duration_seconds' || field === 'bpm') return 0;
  }
  return '';
}

// ─── New Playlist Modal ───────────────────────────────────────────────────────

function NewPlaylistModal({
  onConfirm,
  onCancel,
  isPending,
}: {
  onConfirm: (name: string, type: (typeof PLAYLIST_TYPES)[number], kind: 'static' | 'dynamic') => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof PLAYLIST_TYPES)[number]>('music');
  const [kind, setKind] = useState<'static' | 'dynamic'>('static');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Non-music types are always static
  useEffect(() => {
    if (type !== 'music') setKind('static');
  }, [type]);

  const submit = () => { if (name.trim()) onConfirm(name.trim(), type, kind); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-[460px] p-6 flex flex-col gap-5">
        <h2 className="text-base font-semibold text-white">New Playlist</h2>

        <div>
          <label className="text-xs font-medium text-zinc-400 block mb-1.5">Name</label>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
            placeholder="e.g. Morning Pop Hits"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-zinc-400 block mb-1.5">Content type</label>
          <div className="grid grid-cols-5 gap-1.5">
            {PLAYLIST_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`py-2 rounded-lg text-sm border transition-colors ${
                  type === t
                    ? 'bg-zinc-700 border-zinc-500 text-white font-medium'
                    : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                }`}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {type === 'music' && (
          <div>
            <label className="text-xs font-medium text-zinc-400 block mb-1.5">How it's built</label>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden text-sm">
              <button
                onClick={() => setKind('static')}
                className={`flex-1 px-4 py-1.5 transition-colors ${
                  kind === 'static'
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Static
              </button>
              <button
                onClick={() => setKind('dynamic')}
                className={`flex-1 px-4 py-1.5 transition-colors ${
                  kind === 'dynamic'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Dynamic
              </button>
            </div>
            <p className="text-[11px] text-zinc-500 mt-1.5">
              {kind === 'static'
                ? 'Ordered track list you curate manually.'
                : 'Tracks auto-matched by rules you define.'}
            </p>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || isPending}
            className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isPending && <Loader className="w-3.5 h-3.5 animate-spin" />}
            Create playlist
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function PlaylistsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const { data: playlists = [] } = useQuery<Playlist[]>({
    queryKey: ['playlists'],
    queryFn: () => apiFetch('/playlists'),
  });

  const createMutation = useMutation({
    mutationFn: (data: PlaylistCreate) => apiPost<Playlist>('/playlists', data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setSelectedId(created.id);
      setIsCreating(false);
      showToast('success', 'Playlist created');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const selectedPlaylist = playlists.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* ── Top ribbon ── */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Playlists</h1>
          <p className="text-zinc-400 mt-1 text-sm">
            Manage static track lists and smart dynamic playlists.
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> New Playlist
        </button>
      </div>

      {toast && (
        <div
          className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          {toast.message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {/* ── Left panel ── */}
        <div className="w-72 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center gap-2 flex-shrink-0">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex-1">Playlists</span>
            {playlists.length > 0 && (
              <span className="text-xs text-zinc-600">{playlists.length}</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {playlists.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-xs text-zinc-500">No playlists yet.</p>
                <p className="text-xs text-zinc-600 mt-1">Use the button above to create one.</p>
              </div>
            ) : (
              PLAYLIST_TYPES.map((type) => {
                const group = playlists.filter((p) => p.type === type);
                if (group.length === 0) return null;
                return (
                  <div key={type}>
                    <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 select-none">
                      {TYPE_LABELS[type]}
                    </div>
                    {group.map((pl) => {
                      const isSelected = pl.id === selectedId;
                      return (
                        <button
                          key={pl.id}
                          onClick={() => setSelectedId(pl.id)}
                          className={`w-full text-left px-3 py-2 border-b border-zinc-800/40 transition-colors ${
                            isSelected
                              ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                              : 'hover:bg-zinc-800/50'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-sm text-white truncate flex-1">{pl.name}</span>
                            {pl.kind === 'dynamic' && (
                              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/30 text-indigo-300 font-medium">
                                dynamic
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ── Right panel ── */}
        {selectedPlaylist ? (
          selectedPlaylist.kind === 'static' ? (
            <StaticEditor
              playlist={selectedPlaylist}
              showToast={showToast}
              onDeleted={() => setSelectedId(null)}
            />
          ) : (
            <DynamicEditor
              playlist={selectedPlaylist}
              showToast={showToast}
              onDeleted={() => setSelectedId(null)}
            />
          )
        ) : (
          <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg">
            <div className="text-center">
              <p className="text-zinc-400 text-sm">Select a playlist to edit it</p>
              <p className="text-zinc-600 text-xs mt-1">or create a new one above</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Modal ── */}
      {isCreating && (
        <NewPlaylistModal
          onConfirm={(name, type, kind) =>
            createMutation.mutate({ name, type, kind })
          }
          onCancel={() => setIsCreating(false)}
          isPending={createMutation.isPending}
        />
      )}
    </div>
  );
}

// ─── Shared editor header ────────────────────────────────────────────────────

function PlaylistHeader({
  playlist,
  onDeleted,
  showToast,
}: {
  playlist: Playlist;
  onDeleted: () => void;
  showToast: (type: 'success' | 'error', message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(playlist.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setDraftName(playlist.name);
  }, [playlist.name]);

  const renameMutation = useMutation({
    mutationFn: (name: string) => apiPatch<Playlist>(`/playlists/${playlist.id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setEditingName(false);
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete(`/playlists/${playlist.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      queryClient.removeQueries({ queryKey: ['playlist-tracks', playlist.id] });
      showToast('success', 'Playlist deleted');
      onDeleted();
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === playlist.name) { setEditingName(false); return; }
    renameMutation.mutate(trimmed);
  };

  return (
    <div className="flex-shrink-0 flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="flex-1 min-w-0 flex items-center gap-3">
        {editingName ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditingName(false); setDraftName(playlist.name); }
            }}
            className="text-lg font-semibold text-white bg-transparent border-b border-indigo-500 focus:outline-none w-full pb-0.5"
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="text-lg font-semibold text-white hover:text-indigo-200 transition-colors text-left truncate"
            title="Click to rename"
          >
            {playlist.name}
          </button>
        )}
        <span className={`flex-shrink-0 text-xs px-2.5 py-0.5 rounded-full font-medium ${TYPE_COLORS[playlist.type]}`}>
          {TYPE_LABELS[playlist.type]}
        </span>
        <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium ${
          playlist.kind === 'dynamic'
            ? 'bg-indigo-600/30 text-indigo-300'
            : 'bg-zinc-800 text-zinc-500'
        }`}>
          {playlist.kind}
        </span>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {confirmDelete ? (
          <>
            <span className="text-xs text-zinc-400">Delete this playlist?</span>
            <button
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors disabled:opacity-50"
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
            title="Delete playlist"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Static editor ────────────────────────────────────────────────────────────

function StaticEditor({
  playlist, showToast, onDeleted,
}: {
  playlist: Playlist;
  showToast: (type: 'success' | 'error', message: string) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [localTracks, setLocalTracks] = useState<TrackRow[] | null>(null);

  const { data: fetchedTracks = [] } = useQuery<TrackRow[]>({
    queryKey: ['playlist-tracks', playlist.id],
    queryFn: () => apiFetch(`/playlists/${playlist.id}/tracks`),
  });

  // Keep localTracks in sync with server but don't discard a pending reorder
  const tracks = localTracks ?? fetchedTracks;

  useEffect(() => {
    setLocalTracks(null);
  }, [playlist.id]);

  const reorderMutation = useMutation({
    mutationFn: (items: { id: number; sort_order: number }[]) =>
      apiPut<void>(`/playlists/${playlist.id}/tracks/reorder`, items),
    onError: (e) => {
      showToast('error', (e as Error).message);
      setLocalTracks(null); // rollback to server state
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] });
    },
  });

  const addTracksMutation = useMutation({
    mutationFn: (mediaIds: number[]) =>
      apiPost<TrackRow[]>(`/playlists/${playlist.id}/tracks/bulk`, { media_ids: mediaIds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] });
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const removeTrackMutation = useMutation({
    mutationFn: (trackId: number) => apiDelete(`/playlists/${playlist.id}/tracks/${trackId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] });
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tracks.findIndex((t) => t.id === active.id);
    const newIndex = tracks.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(tracks, oldIndex, newIndex);
    setLocalTracks(reordered);
    reorderMutation.mutate(
      reordered.map((t, i) => ({ id: t.id, sort_order: i })),
    );
  };

  const totalSeconds = tracks.reduce((sum, t) => sum + t.duration_seconds, 0);

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-4">
      <PlaylistHeader playlist={playlist} showToast={showToast} onDeleted={onDeleted} />

      {/* Track list */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg">
        {/* Search / add */}
        <div className="flex-shrink-0 border-b border-zinc-800 px-4 py-3">
          <LibrarySearch
            category={playlist.type}
            onAddMultiple={(ids) => addTracksMutation.mutate(ids)}
            adding={addTracksMutation.isPending}
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {tracks.length === 0 ? (
            <p className="px-5 py-10 text-sm text-zinc-500 text-center">
              No tracks yet — search above to add some.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 z-10">
                    <tr>
                      <th className="w-8 px-2 py-2" />
                      <th className="w-8 px-1 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-600">#</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Title</th>
                      <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Artist</th>
                      <th className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Duration</th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {tracks.map((track, index) => (
                      <SortableTrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        onRemove={() => removeTrackMutation.mutate(track.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {tracks.length > 0 && (
          <div className="flex-shrink-0 border-t border-zinc-800 px-4 py-2 flex items-center gap-2 text-xs text-zinc-500">
            <span>{tracks.length} track{tracks.length !== 1 ? 's' : ''}</span>
            <span className="text-zinc-700">·</span>
            <span className="font-mono">{fmtTotalDuration(totalSeconds)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sortable track row ───────────────────────────────────────────────────────

function SortableTrackRow({
  track, index, onRemove,
}: {
  track: TrackRow;
  index: number;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-t border-zinc-800/60 group hover:bg-zinc-800/30 ${isDragging ? 'relative z-10' : ''}`}
    >
      <td className="w-8 px-2 py-2">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-zinc-700 hover:text-zinc-400 transition-colors touch-none p-0.5"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>
      <td className="w-8 px-1 py-2 text-right text-xs text-zinc-600 font-mono">{index + 1}</td>
      <td className="px-3 py-2 max-w-xs">
        <p className="text-sm text-zinc-100 truncate">
          {track.title ?? <span className="italic text-zinc-500">{track.original_filename}</span>}
        </p>
      </td>
      <td className="px-3 py-2 max-w-xs">
        <p className="text-sm text-zinc-400 truncate">{track.artist ?? '—'}</p>
      </td>
      <td className="px-3 py-2 text-right text-xs text-zinc-400 font-mono whitespace-nowrap">
        {fmtDuration(track.duration_seconds)}
      </td>
      <td className="w-10 px-2 py-2 text-center">
        <button
          onClick={onRemove}
          className="p-1 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
          title="Remove"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ─── Library search (add-track input) ────────────────────────────────────────

function LibrarySearch({
  category,
  onAddMultiple,
  adding,
}: {
  category: string;
  onAddMultiple: (mediaIds: number[]) => void;
  adding: boolean;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery<{ items: MediaRow[] }>({
    queryKey: ['library-search', debouncedQ, category],
    queryFn: () =>
      apiFetch(`/library?q=${encodeURIComponent(debouncedQ)}&category=${encodeURIComponent(category)}&limit=30`),
    enabled: debouncedQ.trim().length > 0,
  });

  const results: MediaRow[] = data?.items ?? [];

  useEffect(() => {
    if (open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleSelect = (id: number) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = () => {
    if (selected.size === 0 || adding) return;
    onAddMultiple(Array.from(selected));
    setSelected(new Set());
    setQ('');
    setDebouncedQ('');
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { if (q.trim()) setOpen(true); }}
          placeholder={`Search ${category} tracks to add…`}
          className="w-full pl-9 pr-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
        />
        {isFetching && (
          <Loader className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-indigo-400 animate-spin" />
        )}
      </div>

      {open && debouncedQ.trim().length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 z-30 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl flex flex-col">
          <div className="max-h-64 overflow-y-auto">
            {results.length === 0 && !isFetching ? (
              <p className="px-4 py-3 text-sm text-zinc-500">No results</p>
            ) : (
              results.map((item) => {
                const isSelected = selected.has(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => toggleSelect(item.id)}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800 transition-colors text-left ${
                      isSelected ? 'bg-indigo-600/10' : ''
                    }`}
                  >
                    <span
                      className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                        isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-zinc-600'
                      }`}
                    >
                      {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">
                        {item.title ?? <span className="italic text-zinc-500">{item.original_filename}</span>}
                      </p>
                      {item.artist && <p className="text-xs text-zinc-400 truncate">{item.artist}</p>}
                    </div>
                    <span className="flex-shrink-0 text-xs text-zinc-500 font-mono">
                      {fmtDuration(item.duration_seconds)}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {selected.size > 0 && (
            <div className="border-t border-zinc-800 px-4 py-2.5 flex items-center justify-between flex-shrink-0">
              <span className="text-xs text-zinc-400">
                {selected.size} selected
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSelected(new Set())}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={handleAdd}
                  disabled={adding}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded transition-colors disabled:opacity-50"
                >
                  {adding
                    ? <Loader className="w-3 h-3 animate-spin" />
                    : <Plus className="w-3 h-3" />}
                  Add {selected.size} track{selected.size !== 1 ? 's' : ''}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Dynamic editor ───────────────────────────────────────────────────────────

function DynamicEditor({
  playlist, showToast, onDeleted,
}: {
  playlist: Playlist;
  showToast: (type: 'success' | 'error', message: string) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();

  const initialRules: DynamicRules = playlist.rules ?? { match: 'all', conditions: [] };
  const [rules, setRules] = useState<DynamicRules>(initialRules);
  const [dirty, setDirty] = useState(false);

  // Keep in sync when switching playlists
  useEffect(() => {
    setRules(playlist.rules ?? { match: 'all', conditions: [] });
    setDirty(false);
  }, [playlist.id, playlist.rules]);

  // Debounced preview
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const result = await apiPost<PlaylistPreview>(`/playlists/${playlist.id}/preview`, rules);
        setPreview(result);
      } catch {
        // silent
      } finally {
        setPreviewLoading(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [rules, playlist.id]);

  const saveMutation = useMutation({
    mutationFn: () => apiPatch<Playlist>(`/playlists/${playlist.id}`, { rules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setDirty(false);
      showToast('success', 'Rules saved');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const updateRules = (next: DynamicRules) => {
    setRules(next);
    setDirty(true);
  };

  const addCondition = () => {
    const field: DynamicRuleField = 'genre';
    const op = FIELD_OPS[field][0];
    const value = defaultValueForField(field, op);
    updateRules({
      ...rules,
      conditions: [...rules.conditions, { field, op, value }],
    });
  };

  const updateCondition = (index: number, cond: DynamicRuleCondition) => {
    const next = [...rules.conditions];
    next[index] = cond;
    updateRules({ ...rules, conditions: next });
  };

  const removeCondition = (index: number) => {
    updateRules({ ...rules, conditions: rules.conditions.filter((_, i) => i !== index) });
  };

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-4 min-h-0 overflow-y-auto">
      <PlaylistHeader playlist={playlist} showToast={showToast} onDeleted={onDeleted} />

      {/* Rules builder */}
      <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {/* Implicit category constraint */}
        <div className="px-5 py-2.5 border-b border-zinc-800 flex items-center gap-1.5 text-xs text-zinc-500">
          <span>Always filters to</span>
          <span className={`px-2 py-0.5 rounded-full font-medium ${TYPE_COLORS[playlist.type]}`}>
            {TYPE_LABELS[playlist.type]}
          </span>
          <span>tracks · then apply:</span>
        </div>

        {/* Match mode */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Match</span>
          <div className="flex rounded overflow-hidden border border-zinc-700">
            <button
              onClick={() => updateRules({ ...rules, match: 'all' })}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                rules.match === 'all'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              All conditions
            </button>
            <button
              onClick={() => updateRules({ ...rules, match: 'any' })}
              className={`px-3 py-1 text-xs font-medium transition-colors ${
                rules.match === 'any'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Any condition
            </button>
          </div>
        </div>

        {/* Conditions */}
        <div className="divide-y divide-zinc-800/60">
          {rules.conditions.length === 0 && (
            <p className="px-5 py-4 text-sm text-zinc-500">
              No conditions — playlist will match all {TYPE_LABELS[playlist.type].toLowerCase()} tracks.
            </p>
          )}
          {rules.conditions.map((cond, i) => (
            <ConditionRow
              key={i}
              condition={cond}
              onChange={(c) => updateCondition(i, c)}
              onRemove={() => removeCondition(i)}
            />
          ))}
        </div>

        <div className="px-5 py-3 border-t border-zinc-800/60 flex items-center justify-between">
          <button
            onClick={addCondition}
            className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Add condition
          </button>

          {dirty && (
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded transition-colors disabled:opacity-50"
            >
              {saveMutation.isPending ? <Loader className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save rules
            </button>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Preview</span>
          {previewLoading && <Loader className="w-3.5 h-3.5 text-indigo-400 animate-spin" />}
        </div>

        {preview && !previewLoading ? (
          <>
            <p className="text-sm text-zinc-300 mb-2">
              <span className="font-semibold text-white">{preview.count}</span> track{preview.count !== 1 ? 's' : ''} match
            </p>
            {preview.sample.length > 0 && (
              <div className="space-y-1">
                {preview.sample.slice(0, 5).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className="flex-1 truncate">
                      {t.title ?? '—'}
                      {t.artist && <span className="text-zinc-500"> · {t.artist}</span>}
                    </span>
                    <span className="flex-shrink-0 font-mono">{fmtDuration(t.duration_seconds)}</span>
                  </div>
                ))}
                {preview.count > 5 && (
                  <p className="text-xs text-zinc-600">and {preview.count - 5} more…</p>
                )}
              </div>
            )}
          </>
        ) : !previewLoading ? (
          <p className="text-sm text-zinc-500">Preview will appear here.</p>
        ) : null}
      </div>
    </div>
  );
}

// ─── Condition row ────────────────────────────────────────────────────────────

function ConditionRow({
  condition, onChange, onRemove,
}: {
  condition: DynamicRuleCondition;
  onChange: (c: DynamicRuleCondition) => void;
  onRemove: () => void;
}) {
  const validOps = FIELD_OPS[condition.field];

  const handleFieldChange = (field: DynamicRuleField) => {
    const op = FIELD_OPS[field][0];
    const value = defaultValueForField(field, op);
    onChange({ field, op, value });
  };

  const handleOpChange = (op: DynamicRuleOp) => {
    const value = defaultValueForField(condition.field, op);
    onChange({ ...condition, op, value });
  };

  return (
    <div className="flex items-start gap-2 px-5 py-3">
      {/* Field */}
      <select
        value={condition.field}
        onChange={(e) => handleFieldChange(e.target.value as DynamicRuleField)}
        className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500 flex-shrink-0"
      >
        {DYNAMIC_RULE_FIELDS.map((f) => (
          <option key={f} value={f} className="bg-zinc-900">{FIELD_LABELS[f]}</option>
        ))}
      </select>

      {/* Op — hidden when there is only one valid choice */}
      {validOps.length > 1 && (
        <select
          value={condition.op}
          onChange={(e) => handleOpChange(e.target.value as DynamicRuleOp)}
          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500 flex-shrink-0"
        >
          {validOps.map((op) => (
            <option key={op} value={op} className="bg-zinc-900">{OP_LABELS[op]}</option>
          ))}
        </select>
      )}

      {/* Value */}
      <div className="flex-1 min-w-0">
        <ConditionValueInput condition={condition} onChange={(value) => onChange({ ...condition, value })} />
      </div>

      <button
        onClick={onRemove}
        className="flex-shrink-0 p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors mt-0.5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Condition value input ────────────────────────────────────────────────────

function ConditionValueInput({
  condition, onChange,
}: {
  condition: DynamicRuleCondition;
  onChange: (value: DynamicRuleCondition['value']) => void;
}) {
  const { field, op, value } = condition;

  // Mood → colored pill multi-select + confidence threshold
  if (field === 'mood') {
    const moodVal = (value && typeof value === 'object' && !Array.isArray(value))
      ? (value as MoodConditionValue)
      : { moods: [], min_score: 0.5 };
    const selectedMoods = moodVal.moods ?? [];
    const minScore = moodVal.min_score ?? 0.5;

    const toggleMood = (m: string) => {
      const next = selectedMoods.includes(m)
        ? selectedMoods.filter((x) => x !== m)
        : [...selectedMoods, m];
      onChange({ moods: next, min_score: minScore });
    };
    const setThreshold = (v: number) => onChange({ moods: selectedMoods, min_score: v });

    return (
      <div className="flex flex-col gap-2 pt-0.5">
        <div className="flex flex-wrap gap-1.5">
          {Object.keys(MOOD_LABELS).map((m) => {
            const active = selectedMoods.includes(m);
            return (
              <button
                key={m}
                onClick={() => toggleMood(m)}
                className={`px-2.5 py-1 text-xs border rounded-full transition-colors ${
                  active
                    ? MOOD_COLORS[m] ?? 'bg-zinc-700 text-zinc-200 border-zinc-600'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-zinc-500 hover:text-zinc-300'
                }`}
              >
                {MOOD_LABELS[m]}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-500 whitespace-nowrap">Min. confidence</span>
          <input
            type="range"
            min={10} max={90} step={5}
            value={Math.round(minScore * 100)}
            onChange={(e) => setThreshold(parseInt(e.target.value) / 100)}
            className="flex-1 h-1 accent-indigo-500 cursor-pointer"
          />
          <span className="text-[11px] font-mono text-zinc-300 w-8 text-right">
            {Math.round(minScore * 100)}%
          </span>
        </div>
      </div>
    );
  }

  // Energy / Danceability → Low / Medium / High multi-select chips
  if (field === 'energy_level' || field === 'danceability_level') {
    const levels = ['low', 'medium', 'high'] as const;
    const levelLabels = { low: 'Low', medium: 'Medium', high: 'High' };
    const levelColors = {
      low:    { active: 'bg-sky-600/30 text-sky-300 border-sky-700/60',    idle: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
      medium: { active: 'bg-amber-600/30 text-amber-300 border-amber-700/60', idle: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
      high:   { active: 'bg-rose-600/30 text-rose-300 border-rose-700/60',   idle: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
    };
    const selected = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (l: string) => {
      const next = selected.includes(l) ? selected.filter((x) => x !== l) : [...selected, l];
      onChange(next);
    };
    return (
      <div className="flex items-center gap-1.5 pt-0.5">
        {levels.map((l) => {
          const active = selected.includes(l);
          return (
            <button
              key={l}
              onClick={() => toggle(l)}
              className={`px-3 py-1 text-xs border rounded-full transition-colors ${
                active ? levelColors[l].active : `${levelColors[l].idle} hover:border-zinc-500 hover:text-zinc-300`
              }`}
            >
              {levelLabels[l]}
            </button>
          );
        })}
      </div>
    );
  }

  // Tags → chip input
  if (field === 'tags' && (op === 'any_of' || op === 'all_of')) {
    const tags = Array.isArray(value) ? (value as string[]) : [];
    return <TagInput tags={tags} onChange={onChange} />;
  }

  // Between → two number inputs
  if (op === 'between') {
    const arr = Array.isArray(value) ? (value as [number, number]) : [0, 0];
    const lo = typeof arr[0] === 'number' ? arr[0] : 0;
    const hi = typeof arr[1] === 'number' ? arr[1] : 0;
    const placeholder = field === 'bpm' ? ['60', '180'] : ['min', 'max'];
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={lo}
          onChange={(e) => onChange([parseFloat(e.target.value) || 0, hi])}
          placeholder={placeholder[0]}
          className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center placeholder:text-zinc-600"
        />
        <span className="text-zinc-500 text-sm">–</span>
        <input
          type="number"
          value={hi}
          onChange={(e) => onChange([lo, parseFloat(e.target.value) || 0])}
          placeholder={placeholder[1]}
          className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center placeholder:text-zinc-600"
        />
        {field === 'bpm' && <span className="text-xs text-zinc-500">BPM</span>}
      </div>
    );
  }

  // Numeric single value (gte / lte / eq)
  if ((field === 'year' || field === 'duration_seconds' || field === 'bpm')
      && (op === 'gte' || op === 'lte' || op === 'eq')) {
    const num = typeof value === 'number' ? value : 0;
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={num}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-32 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
        />
        {field === 'bpm' && <span className="text-xs text-zinc-500">BPM</span>}
      </div>
    );
  }

  // Text input (eq / contains)
  const textVal = typeof value === 'string' ? value : '';
  return (
    <input
      type="text"
      value={textVal}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value…"
      className="w-full px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
    />
  );
}

// ─── Tag chip input ───────────────────────────────────────────────────────────

function TagInput({
  tags, onChange,
}: {
  tags: string[];
  onChange: (value: string[]) => void;
}) {
  const [input, setInput] = useState('');

  const addTag = (raw: string) => {
    const tag = raw.trim().replace(/,$/, '').trim();
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
      setInput('');
    } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => onChange(tags.filter((t) => t !== tag));

  return (
    <div className="flex flex-wrap gap-1.5 items-center px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded focus-within:border-indigo-500 min-h-[34px]">
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 bg-zinc-700 text-zinc-200 text-xs px-2 py-0.5 rounded">
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) { addTag(input); setInput(''); } }}
        placeholder={tags.length === 0 ? 'Type tag and press Enter…' : ''}
        className="flex-1 min-w-20 bg-transparent text-sm text-white focus:outline-none placeholder:text-zinc-500"
      />
    </div>
  );
}
