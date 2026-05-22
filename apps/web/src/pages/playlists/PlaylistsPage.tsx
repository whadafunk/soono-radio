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
  Music, Bell, Waves, Tag, ChevronRight, Mic, Megaphone,
  Flame, TrendingUp,
} from 'lucide-react';
import {
  BTN_PRIMARY, BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM,
  INPUT, LABEL, MODAL_OVERLAY, MODAL_BOX,
} from '../../ui';
import { SaveStatus } from '../../components/SaveStatus';
import {
  PLAYLIST_TYPES,
  PLAYLIST_DEFAULT_TYPES,
  PLAYLIST_SUBCATEGORIES,
  DYNAMIC_RULE_FIELDS,
  playlistMediaCategory,
  type Playlist, type PlaylistCreate, type PlaylistType, type PlaylistSubcategory,
  type DynamicRules, type DynamicRuleCondition, type DynamicRuleField, type DynamicRuleOp,
  type PlaylistPreview, type MoodConditionValue,
} from '@radio/shared';

const DEFAULT_ELIGIBLE_TYPES = new Set<string>(PLAYLIST_DEFAULT_TYPES);

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

const TYPE_LABELS: Record<PlaylistType, string> = {
  music:     'Music',
  jingle:    'Jingle',
  bed:       'Bed',
  spot:      'Spot',
  promo:     'Promo',
  recording: 'Recording',
};

const TYPE_ICONS: Record<PlaylistType, React.ElementType> = {
  music:     Music,
  jingle:    Bell,
  bed:       Waves,
  spot:      Tag,
  promo:     Megaphone,
  recording: Mic,
};

const TYPE_COLORS: Record<PlaylistType, string> = {
  music:     'bg-blue-600/20 text-blue-300 border border-blue-700/40',
  jingle:    'bg-emerald-600/20 text-emerald-300 border border-emerald-700/40',
  bed:       'bg-amber-600/20 text-amber-300 border border-amber-700/40',
  spot:      'bg-rose-600/20 text-rose-300 border border-rose-700/40',
  promo:     'bg-violet-600/20 text-violet-300 border border-violet-700/40',
  recording: 'bg-zinc-600/20 text-zinc-300 border border-zinc-700/40',
};

const TYPE_TITLE_COLORS: Record<PlaylistType, string> = {
  music:     'text-blue-400',
  jingle:    'text-emerald-400',
  bed:       'text-amber-400',
  spot:      'text-rose-400',
  promo:     'text-violet-400',
  recording: 'text-zinc-400',
};

const SUBCATEGORY_LABELS: Record<string, string> = {
  standard:       'Standard',
  hot_play:       'Hot Play',
  heavy_rotation: 'Heavy Rotation',
  show:           'Show',
  opener:         'Opener',
  closer:         'Closer',
  stationid:      'Station ID',
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

function defaultSubcategory(type: PlaylistType): PlaylistSubcategory | null {
  const subs = PLAYLIST_SUBCATEGORIES[type] as readonly string[];
  return subs.length > 0 ? (subs[0] as PlaylistSubcategory) : null;
}

function NewPlaylistModal({
  existingNames,
  onConfirm,
  onCancel,
  isPending,
}: {
  existingNames: string[];
  onConfirm: (name: string, type: PlaylistType, subcategory: PlaylistSubcategory | null, kind: 'static' | 'dynamic') => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PlaylistType>('music');
  const [subcategory, setSubcategory] = useState<PlaylistSubcategory | null>(defaultSubcategory('music'));
  const [kind, setKind] = useState<'static' | 'dynamic'>('static');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    setSubcategory(defaultSubcategory(type));
    if (type !== 'music') setKind('static');
  }, [type]);

  const hasConflict = name.trim().length > 0 &&
    existingNames.some((n) => n.trim().toLowerCase() === name.trim().toLowerCase());

  const submit = () => { if (name.trim() && !hasConflict) onConfirm(name.trim(), type, subcategory, kind); };

  return (
    <div className={MODAL_OVERLAY} onClick={onCancel}>
      <div className={`${MODAL_BOX} max-w-[460px]`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">New Playlist</h2>
          <button
            onClick={onCancel}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 flex flex-col gap-5">
          <div>
            <label className={LABEL}>Name</label>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape') onCancel();
              }}
              placeholder="e.g. Morning Pop Hits"
              className={`${INPUT} ${hasConflict ? 'border-red-500 focus:border-red-500' : ''}`}
            />
            {hasConflict && (
              <p className="mt-1.5 text-xs text-red-400">A playlist with this name already exists.</p>
            )}
          </div>

          <div>
            <label className={LABEL}>Content type</label>
            <div className="grid grid-cols-3 gap-1.5">
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

          {(PLAYLIST_SUBCATEGORIES[type] as readonly string[]).length > 0 && (
            <div>
              <label className={LABEL}>{type === 'music' ? 'Use' : 'Role'}</label>
              <div className="flex flex-wrap gap-1.5">
                {(PLAYLIST_SUBCATEGORIES[type] as readonly string[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSubcategory(s as PlaylistSubcategory)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      subcategory === s
                        ? 'bg-zinc-700 border-zinc-500 text-white font-medium'
                        : 'bg-zinc-800/50 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
                    }`}
                  >
                    {SUBCATEGORY_LABELS[s] ?? s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {type === 'music' && (
            <div>
              <label className={LABEL}>How it's built</label>
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
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-zinc-700 flex-shrink-0">
          <button onClick={onCancel} className={BTN_SECONDARY_SM}>
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || hasConflict || isPending}
            className={BTN_PRIMARY}
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
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [filter, setFilter] = useState<PlaylistType | 'all'>('all');
  const [collapsedTypes, setCollapsedTypes] = useState<Set<PlaylistType>>(new Set());
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmDeleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleTypeCollapsed = (t: PlaylistType) =>
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });

  const toggleCheck = (id: number) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const clearChecked = () => {
    setCheckedIds(new Set());
    setConfirmDelete(false);
    if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
  };

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    setSaveStatus({ type, message });
    setTimeout(() => setSaveStatus(null), 3000);
  }, []);

  useEffect(() => {
    if (confirmDelete) {
      setConfirmDelete(false);
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
    }
  }, [checkedIds, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => apiDelete(`/playlists/${id}`))).then(() => ids),
    onSuccess: (ids) => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      if (selectedId !== null && ids.includes(selectedId)) setSelectedId(null);
      setCheckedIds(new Set());
      setConfirmDelete(false);
      showToast('success', `${ids.length} playlist${ids.length !== 1 ? 's' : ''} deleted`);
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const singleDeleteMutation = useMutation({
    mutationFn: (id: number) => apiDelete(`/playlists/${id}`).then(() => id),
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      queryClient.removeQueries({ queryKey: ['playlist-tracks', id] });
      setSelectedId(null);
      setConfirmDelete(false);
      showToast('success', 'Playlist deleted');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const handleDeleteClick = () => {
    if (confirmDelete) {
      if (confirmDeleteTimer.current) clearTimeout(confirmDeleteTimer.current);
      if (checkedIds.size > 0) {
        bulkDeleteMutation.mutate(Array.from(checkedIds));
      } else if (selectedId !== null) {
        singleDeleteMutation.mutate(selectedId);
      }
    } else {
      setConfirmDelete(true);
      confirmDeleteTimer.current = setTimeout(() => setConfirmDelete(false), 4000);
    }
  };

  const selectedPlaylist = playlists.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* ── Top ribbon ── */}
      <div className="flex-shrink-0 flex items-center gap-4">
        <h1 className="text-xl font-semibold text-white flex-shrink-0">Playlists ({playlists.length})</h1>
        <div className="flex-1"><SaveStatus status={saveStatus} /></div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={clearChecked}
            disabled={checkedIds.size === 0}
            className={BTN_SECONDARY_SM}
          >
            Deselect
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={(checkedIds.size === 0 && selectedId === null) || bulkDeleteMutation.isPending || singleDeleteMutation.isPending}
            className={`${BTN_DESTRUCTIVE_SM} ${confirmDelete ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {(bulkDeleteMutation.isPending || singleDeleteMutation.isPending)
              ? 'Deleting…'
              : confirmDelete
                ? 'Click again to delete'
                : checkedIds.size > 0
                  ? `Delete (${checkedIds.size})`
                  : 'Delete'}
          </button>
          <div className="w-px h-5 bg-zinc-700 mx-1 flex-shrink-0" />
          <button onClick={() => setIsCreating(true)} className={BTN_PRIMARY_SM}>
            <Plus className="w-3.5 h-3.5" /> New Playlist
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        {/* ── Left panel ── */}
        <div className="w-[330px] flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {/* Type filter tabs — two rows */}
          <div className="flex-shrink-0 border-b border-zinc-800">
            <div className="flex border-b border-zinc-800/60">
              {(['all', 'music', 'jingle', 'bed'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className={`flex-1 flex items-center justify-center px-1 py-2.5 text-xs font-medium transition-colors ${
                    filter === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                >
                  {t === 'all' ? `All (${playlists.length})` : `${TYPE_LABELS[t]} (${playlists.filter((p) => p.type === t).length})`}
                </button>
              ))}
            </div>
            <div className="flex">
              {(['spot', 'promo', 'recording'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setFilter(t)}
                  className={`flex-1 flex items-center justify-center px-1 py-2.5 text-xs font-medium transition-colors ${
                    filter === t ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                  }`}
                >
                  {`${TYPE_LABELS[t]} (${playlists.filter((p) => p.type === t).length})`}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {playlists.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-xs text-zinc-500">No playlists yet.</p>
                <p className="text-xs text-zinc-600 mt-1">Use the button above to create one.</p>
              </div>
            ) : filter !== 'all' ? (
              (() => {
                const group = playlists.filter((p) => p.type === filter);
                if (group.length === 0) return (
                  <p className="px-4 py-6 text-xs text-zinc-500 text-center">
                    No {TYPE_LABELS[filter].toLowerCase()} playlists yet.
                  </p>
                );
                return group.map((pl) => <PlaylistItem key={pl.id} pl={pl} selectedId={selectedId} onSelect={setSelectedId}isChecked={checkedIds.has(pl.id)} onToggleCheck={toggleCheck} />);
              })()
            ) : (
              PLAYLIST_TYPES.map((type) => {
                const group = playlists.filter((p) => p.type === type);
                if (group.length === 0) return null;
                const collapsed = collapsedTypes.has(type);
                const TypeIcon = TYPE_ICONS[type];
                return (
                  <div key={type}>
                    <button
                      onClick={() => toggleTypeCollapsed(type)}
                      className="w-full flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors"
                    >
                      <ChevronRight className={`w-3 h-3 text-zinc-300 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                      <TypeIcon className="w-3 h-3 text-zinc-300" />
                      <span className={`text-[11px] font-semibold uppercase tracking-wider ${TYPE_TITLE_COLORS[type]}`}>
                        {TYPE_LABELS[type]} ({group.length})
                      </span>
                    </button>
                    {!collapsed && group.map((pl) => <PlaylistItem key={pl.id} pl={pl} selectedId={selectedId} onSelect={setSelectedId}isChecked={checkedIds.has(pl.id)} onToggleCheck={toggleCheck} />)}
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
            />
          ) : (
            <DynamicEditor
              playlist={selectedPlaylist}
              showToast={showToast}
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
          existingNames={playlists.map((p) => p.name)}
          onConfirm={(name, type, subcategory, kind) =>
            createMutation.mutate({ name, type, subcategory: subcategory ?? undefined, kind })
          }
          onCancel={() => setIsCreating(false)}
          isPending={createMutation.isPending}
        />
      )}
    </div>
  );
}

// ─── Left panel list item ────────────────────────────────────────────────────

const BADGE_DISPLAY = 'flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500 font-medium whitespace-nowrap';
const BADGE_ACTIVE  = 'flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-amber-600/50 text-amber-400 font-medium whitespace-nowrap';
const BADGE_ACTION  = 'flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-dashed border-zinc-700 text-zinc-600 font-medium whitespace-nowrap hover:border-zinc-500 hover:text-zinc-400 transition-colors';

function PlaylistItem({
  pl, selectedId, onSelect, isChecked, onToggleCheck,
}: {
  pl: Playlist;
  selectedId: number | null;
  onSelect: (id: number) => void;
  isChecked: boolean;
  onToggleCheck: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const isSelected = pl.id === selectedId;
  const canBeDefault = DEFAULT_ELIGIBLE_TYPES.has(pl.type);
  const isMusic = pl.type === 'music';
  const isJingle = pl.type === 'jingle';
  const isDynamic = pl.kind === 'dynamic';
  const isHotPlay = pl.subcategory === 'hot_play';
  const isHeavyRotation = pl.subcategory === 'heavy_rotation';

  const setSubcategoryMutation = useMutation({
    mutationFn: (subcategory: PlaylistSubcategory) =>
      apiPatch<Playlist>(`/playlists/${pl.id}`, { subcategory }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
  });

  const defaultMutation = useMutation({
    mutationFn: (value: boolean) => apiPatch<Playlist>(`/playlists/${pl.id}`, { is_default: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
  });

  const toggleSubcategory = (e: React.MouseEvent, sub: PlaylistSubcategory) => {
    e.stopPropagation();
    if (setSubcategoryMutation.isPending) return;
    setSubcategoryMutation.mutate(pl.subcategory === sub ? 'standard' : sub);
  };

  useEffect(() => {
    if (isHeavyRotation && pl.is_default) defaultMutation.mutate(false);
  }, [isHeavyRotation, pl.is_default]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      onClick={() => onSelect(pl.id)}
      className={`w-full text-left px-3 py-2 border-b border-zinc-800/40 transition-colors cursor-pointer select-none ${
        isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'
      }`}
    >
      {/* Row 1: checkbox + name + fixed badge column */}
      <div className="flex items-center gap-2 min-w-0">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => onToggleCheck(pl.id)}
          onClick={(e) => e.stopPropagation()}
          className="flex-shrink-0 w-3.5 h-3.5 accent-indigo-500 cursor-pointer rounded"
        />
        <span className="text-sm text-white truncate flex-1 min-w-0">{pl.name}</span>
        {pl.total_seconds != null && pl.total_seconds > 0 && (
          <span className="text-xs font-mono text-zinc-500 flex-shrink-0">{fmtTotalDuration(pl.total_seconds)}</span>
        )}
        {/* Badge column — natural width, no reserved slots for absent badges */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Jingle subcategory — only shown for jingle type */}
          {isJingle && pl.subcategory && (
            <span className={BADGE_DISPLAY}>{SUBCATEGORY_LABELS[pl.subcategory] ?? pl.subcategory}</span>
          )}
          {/* S/D — music only; other types are always static so no badge */}
          {isMusic && (
            <span className="w-4 text-center text-xs font-bold text-white">{isDynamic ? 'D' : 'S'}</span>
          )}
          {/* Default — eligible types only; disabled (non-clickable) for heavy rotation */}
          {canBeDefault && (isHeavyRotation ? (
            <span className={BADGE_DISPLAY} title="Not available for heavy rotation playlists">default</span>
          ) : pl.is_default ? (
            <button
              onClick={(e) => { e.stopPropagation(); defaultMutation.mutate(false); }}
              className={BADGE_ACTIVE}
              title="Remove default status"
            >
              default
            </button>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); defaultMutation.mutate(true); }}
              className={BADGE_ACTION}
              title="Set as default"
            >
              default
            </button>
          ))}
        </div>
      </div>

      {/* Row 2 (music only): hot-play and heavy-rotation icon toggles */}
      {isMusic && (
        <div className="flex items-center gap-1 mt-1 pl-[22px]">
          <button
            onClick={(e) => toggleSubcategory(e, 'hot_play')}
            title={isHotPlay ? 'Hot Play — click to reset to Standard' : 'Set as Hot Play'}
            className={`p-1 rounded transition-colors ${
              isHotPlay
                ? 'text-red-400 bg-red-500/15'
                : 'text-zinc-400 hover:text-red-400'
            }`}
          >
            <Flame className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={isDynamic ? (e) => e.stopPropagation() : (e) => toggleSubcategory(e, 'heavy_rotation')}
            disabled={isDynamic}
            title={
              isDynamic ? 'Heavy Rotation not available for dynamic playlists'
              : isHeavyRotation ? 'Heavy Rotation — click to reset to Standard'
              : 'Set as Heavy Rotation'
            }
            className={`p-1 rounded transition-colors ${
              isHeavyRotation
                ? 'text-violet-300 bg-violet-500/15'
                : isDynamic
                  ? 'text-zinc-600 cursor-not-allowed'
                  : 'text-zinc-400 hover:text-violet-400'
            }`}
          >
            <TrendingUp className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Shared editor header ────────────────────────────────────────────────────

function PlaylistHeader({
  playlist,
  showToast,
  count,
}: {
  playlist: Playlist;
  showToast: (type: 'success' | 'error', message: string) => void;
  count?: number | null;
}) {
  const queryClient = useQueryClient();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(playlist.name);

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

  const setSubcategoryMutation = useMutation({
    mutationFn: (subcategory: PlaylistSubcategory) =>
      apiPatch<Playlist>(`/playlists/${playlist.id}`, { subcategory }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
    onError: (e) => showToast('error', (e as Error).message),
  });

  const toggleDefaultMutation = useMutation({
    mutationFn: (value: boolean) => apiPatch<Playlist>(`/playlists/${playlist.id}`, { is_default: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['playlists'] }),
    onError: (e) => showToast('error', (e as Error).message),
  });

  const canBeDefault = DEFAULT_ELIGIBLE_TYPES.has(playlist.type);
  const isHeavyRotation = playlist.subcategory === 'heavy_rotation';

  useEffect(() => {
    if (isHeavyRotation && playlist.is_default) toggleDefaultMutation.mutate(false);
  }, [isHeavyRotation, playlist.is_default]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === playlist.name) { setEditingName(false); return; }
    renameMutation.mutate(trimmed);
  };

  return (
    <div className="flex-shrink-0 flex flex-col gap-2.5 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      {/* Row 1: name */}
      <div className="min-w-0">
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
            className="flex items-baseline gap-1.5 text-left hover:text-indigo-200 transition-colors w-full"
            title="Click to rename"
          >
            <span className="text-lg font-semibold text-white truncate min-w-0">{playlist.name}</span>
            {count != null && <span className="text-base text-zinc-400 font-normal flex-shrink-0">({count})</span>}
          </button>
        )}
      </div>

      {/* Row 2: type + S/D (music only) + default badges */}
      <div className="flex items-center gap-2">
        <span className={`text-xs px-2.5 py-0.5 rounded-full font-medium ${TYPE_COLORS[playlist.type]}`}>
          {playlist.type !== 'music' && playlist.subcategory
            ? `${TYPE_LABELS[playlist.type]} / ${SUBCATEGORY_LABELS[playlist.subcategory] ?? playlist.subcategory}`
            : TYPE_LABELS[playlist.type]}
        </span>
        {playlist.type === 'music' && (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-indigo-600/30 text-indigo-300">
            {playlist.kind}
          </span>
        )}
        {canBeDefault && (isHeavyRotation ? (
          <span
            title="Not available for heavy rotation playlists"
            className="text-xs px-2.5 py-0.5 rounded-full font-medium text-zinc-600 border border-dashed border-zinc-700 cursor-default"
          >
            Default
          </span>
        ) : (
          <button
            onClick={() => toggleDefaultMutation.mutate(!playlist.is_default)}
            disabled={toggleDefaultMutation.isPending}
            title={playlist.is_default ? 'Remove default status' : 'Set as default'}
            className={`text-xs px-2.5 py-0.5 rounded-full font-medium transition-colors disabled:opacity-50 ${
              playlist.is_default
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'text-zinc-500 border border-dashed border-zinc-600 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/10'
            }`}
          >
            Default
          </button>
        ))}
      </div>

      {/* Row 3: music subcategory toggle with icons */}
      {playlist.type === 'music' && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 flex-shrink-0">Use</span>
          <div className="flex rounded border border-zinc-700 overflow-hidden text-xs">
            {(PLAYLIST_SUBCATEGORIES.music as readonly string[]).map((sub) => {
              const unavailable = sub === 'heavy_rotation' && playlist.kind === 'dynamic';
              const isActive = playlist.subcategory === sub;
              return (
                <button
                  key={sub}
                  onClick={() => !unavailable && setSubcategoryMutation.mutate(sub as PlaylistSubcategory)}
                  disabled={setSubcategoryMutation.isPending || unavailable}
                  title={unavailable ? 'Heavy Rotation is not available for dynamic playlists' : undefined}
                  className={`flex items-center gap-1 px-3 py-1 font-medium transition-colors ${
                    isActive
                      ? 'bg-zinc-700 text-white'
                      : unavailable
                        ? 'text-zinc-700 cursor-not-allowed'
                        : 'bg-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                  }`}
                >
                  {sub === 'hot_play' && (
                    <Flame className={`w-3.5 h-3.5 ${isActive ? 'text-red-400' : unavailable ? 'text-zinc-700' : 'text-zinc-500'}`} />
                  )}
                  {sub === 'heavy_rotation' && (
                    <TrendingUp className={`w-3.5 h-3.5 ${isActive ? 'text-violet-300' : unavailable ? 'text-zinc-700' : 'text-zinc-500'}`} />
                  )}
                  {SUBCATEGORY_LABELS[sub] ?? sub}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Static editor ────────────────────────────────────────────────────────────

function StaticEditor({
  playlist, showToast,
}: {
  playlist: Playlist;
  showToast: (type: 'success' | 'error', message: string) => void;
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
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const removeTrackMutation = useMutation({
    mutationFn: (trackId: number) => apiDelete(`/playlists/${playlist.id}/tracks/${trackId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['playlist-tracks', playlist.id] });
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
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
      <PlaylistHeader playlist={playlist} showToast={showToast} count={tracks.length} />

      {/* Track list */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg">
        {/* Search / add */}
        <div className="flex-shrink-0 border-b border-zinc-800 px-4 py-3">
          <LibrarySearch
            category={playlistMediaCategory(playlist.type, playlist.subcategory)}
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
  playlist, showToast,
}: {
  playlist: Playlist;
  showToast: (type: 'success' | 'error', message: string) => void;
}) {
  const queryClient = useQueryClient();

  const initialRules: DynamicRules = playlist.rules ?? { match: 'all', conditions: [] };
  const [rules, setRules] = useState<DynamicRules>(initialRules);
  const [dirty, setDirty] = useState(false);

  // Keep in sync when switching playlists
  useEffect(() => {
    setRules(playlist.rules ?? { match: 'all', conditions: [] });
    setDirty(false);
    setShowAll(false);
    setAllSample([]);
  }, [playlist.id, playlist.rules]);

  // Debounced preview
  const [preview, setPreview] = useState<PlaylistPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Full-list expansion
  const [showAll, setShowAll] = useState(false);
  const [allSample, setAllSample] = useState<PlaylistPreview['sample']>([]);
  const [allSampleLoading, setAllSampleLoading] = useState(false);

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
    setShowAll(false);
    setAllSample([]);
  };

  const handleShowAll = async () => {
    if (!preview || allSampleLoading) return;
    setAllSampleLoading(true);
    try {
      const result = await apiPost<PlaylistPreview>(
        `/playlists/${playlist.id}/preview?limit=${Math.min(preview.count, 500)}`,
        rules,
      );
      setAllSample(result.sample);
      setShowAll(true);
    } catch {
      // silent
    } finally {
      setAllSampleLoading(false);
    }
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
      <PlaylistHeader playlist={playlist} showToast={showToast} count={previewLoading ? null : (preview?.count ?? null)} />

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
              No conditions — playlist will match all {playlist.subcategory ? (SUBCATEGORY_LABELS[playlist.subcategory] ?? playlist.subcategory).toLowerCase() : TYPE_LABELS[playlist.type].toLowerCase()} tracks.
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
              className={BTN_PRIMARY_SM}
            >
              {saveMutation.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save rules
            </button>
          )}
        </div>
      </div>

      {/* Preview */}
      <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Preview</span>
            {(previewLoading || allSampleLoading) && <Loader className="w-3.5 h-3.5 text-indigo-400 animate-spin" />}
          </div>
          {showAll && (
            <button
              onClick={() => { setShowAll(false); setAllSample([]); }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Show less
            </button>
          )}
        </div>

        {preview && !previewLoading ? (
          <>
            <p className="text-sm text-zinc-300 mb-2">
              <span className="font-semibold text-white">{preview.count}</span> track{preview.count !== 1 ? 's' : ''} match
            </p>
            {showAll ? (
              <div className="max-h-60 overflow-y-auto space-y-1 pr-1">
                {allSample.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className="flex-1 truncate">
                      {t.title ?? <span className="italic text-zinc-500">{t.original_filename}</span>}
                      {t.artist && <span className="text-zinc-500"> · {t.artist}</span>}
                    </span>
                    <span className="flex-shrink-0 font-mono">{fmtDuration(t.duration_seconds)}</span>
                  </div>
                ))}
                {preview.count > 500 && (
                  <p className="text-xs text-zinc-600 pt-1">Showing first 500 of {preview.count} matches.</p>
                )}
              </div>
            ) : (
              preview.sample.length > 0 && (
                <div className="space-y-1">
                  {preview.sample.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 text-xs text-zinc-400">
                      <span className="flex-1 truncate">
                        {t.title ?? <span className="italic text-zinc-500">{t.original_filename}</span>}
                        {t.artist && <span className="text-zinc-500"> · {t.artist}</span>}
                      </span>
                      <span className="flex-shrink-0 font-mono">{fmtDuration(t.duration_seconds)}</span>
                    </div>
                  ))}
                  {preview.count > 5 && (
                    <button
                      onClick={handleShowAll}
                      disabled={allSampleLoading}
                      className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
                    >
                      and {preview.count - 5} more…
                    </button>
                  )}
                </div>
              )
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
