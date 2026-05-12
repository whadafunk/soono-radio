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
  type PlaylistPreview,
  MEDIA_CATEGORIES,
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
  category: 'Category',
  genre: 'Genre',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  duration_seconds: 'Duration',
  loudness_lufs: 'Loudness (LUFS)',
  tags: 'Tags',
};

const OP_LABELS: Record<DynamicRuleOp, string> = {
  eq: 'is',
  contains: 'contains',
  in: 'is one of',
  any_of: 'includes any of',
  all_of: 'includes all of',
  gte: '≥',
  lte: '≤',
  between: 'between',
};

// Valid ops per field
const FIELD_OPS: Record<DynamicRuleField, DynamicRuleOp[]> = {
  category:         ['in'],
  genre:            ['eq', 'contains'],
  artist:           ['eq', 'contains'],
  album:            ['eq', 'contains'],
  year:             ['eq', 'gte', 'lte', 'between'],
  duration_seconds: ['gte', 'lte', 'between'],
  loudness_lufs:    ['gte', 'lte', 'between'],
  tags:             ['any_of', 'all_of'],
};

const TYPE_LABELS: Record<(typeof PLAYLIST_TYPES)[number], string> = {
  music: 'Music',
  jingle: 'Jingle',
  bed: 'Bed',
  promo: 'Promo',
  spot: 'Spot',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function defaultValueForField(field: DynamicRuleField, op: DynamicRuleOp): DynamicRuleCondition['value'] {
  if (field === 'category') return [];
  if (field === 'tags') return [];
  if (op === 'between') return [0, 0];
  if (op === 'in') return [];
  if (op === 'gte' || op === 'lte' || op === 'eq') {
    if (field === 'year' || field === 'duration_seconds' || field === 'loudness_lufs') return 0;
  }
  return '';
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function PlaylistsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // New playlist inline form state
  const [creatingKind, setCreatingKind] = useState<'static' | 'dynamic' | null>(null);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<(typeof PLAYLIST_TYPES)[number]>('music');

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
      setCreatingKind(null);
      setNewName('');
      setNewType('music');
      showToast('success', 'Playlist created');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const handleCreateConfirm = () => {
    if (!newName.trim() || !creatingKind) return;
    createMutation.mutate({ name: newName.trim(), type: newType, kind: creatingKind });
  };

  const handleCreateCancel = () => {
    setCreatingKind(null);
    setNewName('');
    setNewType('music');
  };

  const selectedPlaylist = playlists.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex-shrink-0">
        <h1 className="text-3xl font-bold text-white">Playlists</h1>
        <p className="text-zinc-400 mt-1 text-sm">
          Manage static track lists and smart dynamic playlists.
        </p>
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
        <div className="w-64 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {/* Header with two create buttons */}
          <div className="px-3 py-2.5 border-b border-zinc-800 flex items-center gap-1.5 flex-shrink-0">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex-1">Playlists</span>
            <button
              onClick={() => { setCreatingKind('static'); setNewName(''); setNewType('music'); }}
              className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
              title="New static playlist"
            >
              <Plus className="w-3 h-3" /> Static
            </button>
            <button
              onClick={() => { setCreatingKind('dynamic'); setNewName(''); setNewType('music'); }}
              className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-300 hover:text-indigo-200 bg-indigo-600/20 hover:bg-indigo-600/30 rounded transition-colors"
              title="New dynamic playlist"
            >
              <Plus className="w-3 h-3" /> Dynamic
            </button>
          </div>

          {/* Inline new-playlist form */}
          {creatingKind !== null && (
            <div className="px-3 py-2 border-b border-zinc-800 space-y-1.5 flex-shrink-0">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateConfirm();
                  if (e.key === 'Escape') handleCreateCancel();
                }}
                placeholder="Playlist name…"
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
              />
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as typeof newType)}
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
              >
                {PLAYLIST_TYPES.map((t) => (
                  <option key={t} value={t} className="bg-zinc-900">{TYPE_LABELS[t]}</option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <button
                  onClick={handleCreateConfirm}
                  disabled={!newName.trim() || createMutation.isPending}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded transition-colors disabled:opacity-50"
                >
                  <Check className="w-3 h-3" />
                  {creatingKind === 'static' ? 'Static' : 'Dynamic'}
                </button>
                <button
                  onClick={handleCreateCancel}
                  className="px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {playlists.length === 0 && creatingKind === null && (
              <p className="px-4 py-6 text-xs text-zinc-400 text-center">
                No playlists yet.<br />Create one to get started.
              </p>
            )}
            {playlists.map((pl) => {
              const isSelected = pl.id === selectedId;
              return (
                <button
                  key={pl.id}
                  onClick={() => setSelectedId(pl.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-zinc-800/60 transition-colors ${
                    isSelected
                      ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500'
                      : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-white truncate flex-1">{pl.name}</span>
                    <span
                      className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded font-medium ${
                        pl.kind === 'dynamic'
                          ? 'bg-indigo-600/30 text-indigo-300'
                          : 'bg-zinc-700 text-zinc-400'
                      }`}
                    >
                      {pl.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500">{TYPE_LABELS[pl.type]}</span>
                  </div>
                </button>
              );
            })}
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
            <p className="text-zinc-400 text-sm">Select a playlist to edit it</p>
          </div>
        )}
      </div>
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
        <span
          className={`flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium ${
            playlist.kind === 'dynamic'
              ? 'bg-indigo-600/30 text-indigo-300'
              : 'bg-zinc-700 text-zinc-400'
          }`}
        >
          {playlist.kind}
        </span>
        <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
          {TYPE_LABELS[playlist.type]}
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

  const addTrackMutation = useMutation({
    mutationFn: (mediaId: number) =>
      apiPost<TrackRow>(`/playlists/${playlist.id}/tracks`, { media_id: mediaId }),
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

  const updateWeightMutation = useMutation({
    mutationFn: ({ trackId, weight }: { trackId: number; weight: number }) =>
      apiPatch<TrackRow>(`/playlists/${playlist.id}/tracks/${trackId}`, { weight }),
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

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-4">
      <PlaylistHeader playlist={playlist} showToast={showToast} onDeleted={onDeleted} />

      {/* Track list */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-zinc-800 flex-shrink-0 flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Tracks</span>
          <span className="text-xs text-zinc-500">({tracks.length})</span>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {tracks.length === 0 ? (
            <p className="px-5 py-8 text-sm text-zinc-400 text-center">
              No tracks yet — search below to add some.
            </p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={tracks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <div className="divide-y divide-zinc-800/60">
                  {tracks.map((track, index) => (
                    <SortableTrackRow
                      key={track.id}
                      track={track}
                      index={index}
                      onRemove={() => removeTrackMutation.mutate(track.id)}
                      onWeightChange={(w) => updateWeightMutation.mutate({ trackId: track.id, weight: w })}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Search / add */}
        <div className="flex-shrink-0 border-t border-zinc-800 px-5 py-4">
          <LibrarySearch
            onAdd={(mediaId) => addTrackMutation.mutate(mediaId)}
            adding={addTrackMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Sortable track row ───────────────────────────────────────────────────────

function SortableTrackRow({
  track, index, onRemove, onWeightChange,
}: {
  track: TrackRow;
  index: number;
  onRemove: () => void;
  onWeightChange: (w: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: 'relative' as const,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 px-3 py-2 group hover:bg-zinc-800/40">
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-400 transition-colors touch-none flex-shrink-0 p-0.5"
      >
        <GripVertical className="w-4 h-4" />
      </button>

      <span className="flex-shrink-0 w-6 text-right text-xs text-zinc-500 font-mono">{index + 1}</span>

      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">
          {track.title ?? <span className="italic text-zinc-500">{track.original_filename}</span>}
        </p>
        {track.artist && (
          <p className="text-xs text-zinc-400 truncate">{track.artist}</p>
        )}
      </div>

      <span className="flex-shrink-0 text-xs text-zinc-400 font-mono w-10 text-right">
        {fmtDuration(track.duration_seconds)}
      </span>

      <div className="flex-shrink-0 flex items-center gap-1">
        <span className="text-xs text-zinc-500">wt</span>
        <input
          type="number"
          min={1}
          max={10}
          value={track.weight}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 1 && v <= 10) onWeightChange(v);
          }}
          className="w-12 px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <button
        onClick={onRemove}
        className="flex-shrink-0 p-1 text-zinc-500 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
        title="Remove track"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Library search (add-track input) ────────────────────────────────────────

function LibrarySearch({ onAdd, adding }: { onAdd: (mediaId: number) => void; adding: boolean }) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery<{ data: MediaRow[] }>({
    queryKey: ['library-search', debouncedQ],
    queryFn: () => apiFetch(`/library?q=${encodeURIComponent(debouncedQ)}&limit=20`),
    enabled: debouncedQ.trim().length > 0,
  });

  const results: MediaRow[] = data?.data ?? [];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => { if (q.trim()) setOpen(true); }}
          placeholder="Search library to add tracks…"
          className="w-full pl-9 pr-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
        />
        {isFetching && (
          <Loader className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-indigo-400 animate-spin" />
        )}
      </div>

      {open && debouncedQ.trim().length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {results.length === 0 && !isFetching ? (
            <p className="px-4 py-3 text-sm text-zinc-500">No results</p>
          ) : (
            results.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  onAdd(item.id);
                  setQ('');
                  setDebouncedQ('');
                  setOpen(false);
                }}
                disabled={adding}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800 transition-colors text-left disabled:opacity-50"
              >
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
            ))
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
        const result = await apiPost<PlaylistPreview>('/playlists/preview', rules);
        setPreview(result);
      } catch {
        // silent
      } finally {
        setPreviewLoading(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [rules]);

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
    const field: DynamicRuleField = 'category';
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
              No conditions — playlist will match all tracks.
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

      {/* Op */}
      <select
        value={condition.op}
        onChange={(e) => handleOpChange(e.target.value as DynamicRuleOp)}
        className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500 flex-shrink-0"
      >
        {validOps.map((op) => (
          <option key={op} value={op} className="bg-zinc-900">{OP_LABELS[op]}</option>
        ))}
      </select>

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

  // Category → checkboxes
  if (field === 'category' && op === 'in') {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (cat: string) => {
      const next = selected.includes(cat)
        ? selected.filter((c) => c !== cat)
        : [...selected, cat];
      onChange(next);
    };
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1">
        {MEDIA_CATEGORIES.map((cat) => (
          <label key={cat} className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selected.includes(cat)}
              onChange={() => toggle(cat)}
              className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
            />
            <span className="text-xs text-zinc-300 capitalize">{cat}</span>
          </label>
        ))}
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
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={lo}
          onChange={(e) => onChange([parseFloat(e.target.value) || 0, hi])}
          className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
        />
        <span className="text-zinc-500 text-sm">–</span>
        <input
          type="number"
          value={hi}
          onChange={(e) => onChange([lo, parseFloat(e.target.value) || 0])}
          className="w-24 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
        />
      </div>
    );
  }

  // Numeric fields with gte/lte/eq
  if ((field === 'year' || field === 'duration_seconds' || field === 'loudness_lufs')
      && (op === 'gte' || op === 'lte' || op === 'eq')) {
    const num = typeof value === 'number' ? value : 0;
    return (
      <input
        type="number"
        value={num}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-32 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
      />
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
