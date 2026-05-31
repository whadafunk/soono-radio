import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, X, Trash2, Music, Megaphone, ChevronRight } from 'lucide-react';
import { Rotation, RotationType, RotationKind, SongPosition, ROTATION_TYPES, ROTATION_KINDS, SONG_POSITIONS } from '@soono/shared';
import { fetchRotations, createRotation, updateRotation, deleteRotation, fetchPlaylists } from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';
import { SaveStatus } from '../../components/SaveStatus';
import { BTN_PRIMARY, BTN_SECONDARY, BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM, INPUT, SELECT, MODAL_OVERLAY, MODAL_BOX } from '../../ui';

const KIND_META: Record<RotationKind, { label: string; icon: typeof Music; desc: string }> = {
  music:   { label: 'Music',   icon: Music,      desc: 'Draws from playlists. Used by show playlists and music-segment sources.' },
  sweeper: { label: 'Sweeper', icon: Megaphone,  desc: 'Drives sweep overlays (jingles, station IDs, promos, ad spots). Source pool is derived from sweeper type, not configured here.' },
};

const SONG_POSITION_LABELS: Record<SongPosition, string> = {
  any:         'Any time',
  song_start:  'At song start',
  song_end:    'At song end',
};

const TYPE_META: Record<RotationType, { label: string; short: string; bg: string; border: string; text: string; desc: string }> = {
  random_separation: {
    label: 'Random Separation', short: 'Random Sep.',
    bg: 'bg-brand-500/15', border: 'border-brand-500/40', text: 'text-brand-300',
    desc: 'Picks tracks at random while enforcing a minimum gap before a track or artist can repeat.',
  },
  least_recently_played: {
    label: 'Least Recently Played', short: 'LRP',
    bg: 'bg-teal-500/15', border: 'border-teal-500/40', text: 'text-teal-300',
    desc: 'Always picks the track that was played furthest in the past.',
  },
  round_robin: {
    label: 'Round Robin', short: 'Round Robin',
    bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-300',
    desc: 'Cycles through the playlist in a fixed order, wrapping around at the end.',
  },
  weighted: {
    label: 'Weighted', short: 'Weighted',
    bg: 'bg-violet-500/15', border: 'border-violet-500/40', text: 'text-violet-300',
    desc: 'Picks tracks at random with probability proportional to their weight in the playlist.',
  },
};

const DEFAULT_PARAMS: Record<RotationType, Record<string, unknown>> = {
  random_separation:     { separation_minutes: 60, artist_separation_minutes: 0 },
  least_recently_played: {},
  round_robin:           { order_by: 'added_date' },
  weighted:              {},
};

type RotationDraft = {
  id: number;
  name: string;
  kind: RotationKind;
  type: RotationType;
  song_position: SongPosition | null;
  params: Record<string, unknown>;
  hot_play_playlist_id: number | null;
  hot_play_every_n_tracks: number | null;
  heavy_rotation_enabled: boolean;
};

export function RotationsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<RotationDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<RotationKind>('music');
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | 'warning'; message: string } | null>(null);
  const [kindFilter, setKindFilter] = useState<RotationKind | 'all'>('all');
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [collapsedKinds, setCollapsedKinds] = useState<Set<RotationKind>>(new Set());

  const nameExists = (name: string, excludeId?: number) =>
    rotations.some((r) => r.id !== excludeId && r.name.trim().toLowerCase() === name.trim().toLowerCase());

  const toggleKindCollapsed = (k: RotationKind) =>
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset confirmation if selection changes
  useEffect(() => {
    if (confirmingDelete) {
      setConfirmingDelete(false);
      if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedIds, selectedId]);

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
      setConfirmingDelete(false);
      if (checkedIds.size > 0) deleteMutation.mutate([...checkedIds]);
      else if (selectedId !== null) deleteMutation.mutate([selectedId]);
    } else {
      setConfirmingDelete(true);
      deleteConfirmTimer.current = setTimeout(() => setConfirmingDelete(false), 4000);
    }
  };

  const showSaveStatus = (type: 'success' | 'error' | 'warning', message: string) => {
    setSaveStatus({ type, message });
    setTimeout(() => setSaveStatus(null), 3000);
  };

  const { data: rotations = [] } = useQuery({ queryKey: ['rotations'], queryFn: fetchRotations });
  // For the hot-play playlist picker (music kind only). Filtered to music-type playlists below.
  const { data: allPlaylists = [] } = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const musicPlaylists = allPlaylists.filter((p) => p.type === 'music' && ((p.total_seconds ?? 0) > 0 || p.kind === 'dynamic'));

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('No draft');
      return updateRotation(draft.id, {
        name: draft.name,
        type: draft.type,
        song_position: draft.kind === 'sweeper' ? draft.song_position : null,
        params: draft.params,
        // hot_play only applies to music-kind rotations; clear it on sweeper draft saves.
        hot_play_playlist_id:
          draft.kind === 'music' ? draft.hot_play_playlist_id : null,
        hot_play_every_n_tracks:
          draft.kind === 'music' ? draft.hot_play_every_n_tracks : null,
        // heavy_rotation similarly only applies to music rotations.
        heavy_rotation_enabled:
          draft.kind === 'music' ? draft.heavy_rotation_enabled : false,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setDirty(false);
      showSaveStatus('success', 'Rotation saved');
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
  });

  const createMutation = useMutation({
    mutationFn: ({ name, kind }: { name: string; kind: RotationKind }) =>
      createRotation({
        name,
        kind,
        type: 'round_robin',
        song_position: kind === 'sweeper' ? 'any' : null,
        params: DEFAULT_PARAMS.round_robin,
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setCreatingNew(false);
      setNewName('');
      selectRotation(created);
      showSaveStatus('success', 'Rotation created');
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(deleteRotation)),
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setCheckedIds(new Set());
      if (selectedId !== null && ids.includes(selectedId)) {
        setSelectedId(null);
        setDraft(null);
        setDirty(false);
      }
      showSaveStatus('error', ids.length === 1 ? 'Rotation deleted' : `${ids.length} rotations deleted`);
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: number) => updateRotation(id, { is_default: true }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      const name = rotations.find((r) => r.id === id)?.name;
      showSaveStatus('warning', name ? `"${name}" set as default` : 'Default updated');
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
  });

  const selectRotation = (r: Rotation) => {
    setSelectedId(r.id);
    setDraft({
      id: r.id,
      name: r.name,
      kind: r.kind ?? 'music',
      type: r.type,
      song_position: r.song_position ?? null,
      params: JSON.parse(JSON.stringify(r.params)),
      hot_play_playlist_id: r.hot_play_playlist_id ?? null,
      hot_play_every_n_tracks: r.hot_play_every_n_tracks ?? null,
      heavy_rotation_enabled: r.heavy_rotation_enabled ?? false,
    });
    setDirty(false);
  };

  const updateDraft = (updater: (d: RotationDraft) => RotationDraft) => {
    setDraft((prev) => (prev ? updater(prev) : prev));
    setDirty(true);
  };

  const handleDiscard = () => {
    const original = rotations.find((r) => r.id === selectedId);
    if (original) {
      setDraft({
        id: original.id,
        name: original.name,
        kind: original.kind ?? 'music',
        type: original.type,
        song_position: original.song_position ?? null,
        params: JSON.parse(JSON.stringify(original.params)),
        hot_play_playlist_id: original.hot_play_playlist_id ?? null,
        hot_play_every_n_tracks: original.hot_play_every_n_tracks ?? null,
        heavy_rotation_enabled: original.heavy_rotation_enabled ?? false,
      });
      setDirty(false);
    }
  };

  const handleTypeChange = (newType: RotationType) => {
    updateDraft((d) => ({ ...d, type: newType, params: { ...DEFAULT_PARAMS[newType] } }));
  };

  const updateParam = (key: string, value: unknown) => {
    updateDraft((d) => ({ ...d, params: { ...d.params, [key]: value } }));
  };

  return (
    <>
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center gap-4 flex-shrink-0">
        <h1 className="text-xl font-semibold text-white flex-shrink-0">Rotations</h1>
        <div className="flex-1"><SaveStatus status={saveStatus} /></div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {draft && (
            <>
              {rotations.find((r) => r.id === draft.id)?.is_default ? (
                <span className="text-xs px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium">
                  Default
                </span>
              ) : (
                <button
                  onClick={() => setDefaultMutation.mutate(draft.id)}
                  disabled={setDefaultMutation.isPending}
                  className="text-xs px-2.5 py-1 rounded-full text-zinc-500 border border-zinc-700 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/10 transition-colors disabled:opacity-50"
                >
                  Set as default
                </button>
              )}
              <div className="w-px h-5 bg-zinc-700 mx-1" />
              <button onClick={handleDiscard} disabled={!dirty} className={BTN_SECONDARY_SM}>
                Discard
              </button>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!dirty || saveMutation.isPending || (!!draft && nameExists(draft.name, draft.id))}
                className={BTN_PRIMARY_SM}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
          <div className="w-px h-5 bg-zinc-700 mx-1" />
          <button
            onClick={() => setCheckedIds(new Set())}
            disabled={checkedIds.size === 0}
            className={BTN_SECONDARY_SM}
          >
            Deselect
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={(checkedIds.size === 0 && selectedId === null) || deleteMutation.isPending}
            title={checkedIds.size === 0 && selectedId === null ? 'Select a rotation to delete' : undefined}
            className={`${BTN_DESTRUCTIVE_SM} ${confirmingDelete ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmingDelete ? 'Click again to delete' : `Delete${checkedIds.size > 0 ? ` (${checkedIds.size})` : ''}`}
          </button>
          <button onClick={() => setCreatingNew(true)} className={BTN_PRIMARY_SM}>
            <Plus className="w-3.5 h-3.5" />
            New Rotation
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: list */}
        <div className="w-[311px] flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {/* Kind filter tabs */}
          <div className="flex border-b border-zinc-800">
            {(['all', ...ROTATION_KINDS] as const).map((k) => {
              const Icon = k !== 'all' ? KIND_META[k].icon : null;
              return (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={`flex items-center justify-center gap-1.5 px-4 py-3.5 text-xs font-medium transition-colors ${
                  kindFilter === k ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                {Icon && <Icon className="w-3 h-3" />}
                {k === 'all'
                  ? `All (${rotations.length})`
                  : `${KIND_META[k].label} (${rotations.filter((r) => (r.kind ?? 'music') === k).length})`}
              </button>
              );
            })}
          </div>


          <div className="flex-1 overflow-auto">
            {rotations.length === 0 && (
              <p className="px-4 py-6 text-xs text-zinc-400 text-center">No rotations yet.<br />Create one to get started.</p>
            )}
            {(() => {
              const renderItem = (r: Rotation) => {
                const meta = TYPE_META[r.type];
                const kind = r.kind ?? 'music';
                const KindIcon = KIND_META[kind].icon;
                const isSelected = r.id === selectedId;
                return (
                  <button
                    key={r.id}
                    onClick={() => selectRotation(r)}
                    className={`group w-full text-left px-4 py-3 border-b border-zinc-800/60 transition-colors ${
                      isSelected ? 'bg-brand-600/20 border-l-2 border-l-brand-500' : 'hover:bg-zinc-800/50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checkedIds.has(r.id)}
                        onChange={() => {}}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCheckedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.id)) next.delete(r.id); else next.add(r.id);
                            return next;
                          });
                        }}
                        className="w-3.5 h-3.5 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer flex-shrink-0"
                      />
                      <KindIcon className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-white truncate flex-1">{r.name}</span>
                      {r.is_default ? (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium">
                          default
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setDefaultMutation.mutate(r.id); }}
                          className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded text-zinc-600 border border-zinc-700 hover:text-amber-300 hover:border-amber-500/30 hover:bg-amber-500/10 transition-colors opacity-0 group-hover:opacity-100"
                          title="Set as default"
                        >
                          default
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 ml-5 flex gap-1.5">
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{KIND_META[kind].label}</span>
                      <span className="text-zinc-700">·</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded border ${meta.bg} ${meta.border} ${meta.text}`}>
                        {meta.short}
                      </span>
                    </div>
                  </button>
                );
              };

              if (kindFilter !== 'all') {
                return rotations
                  .filter((r) => (r.kind ?? 'music') === kindFilter)
                  .map(renderItem);
              }

              return ROTATION_KINDS.map((k) => {
                const group = rotations.filter((r) => (r.kind ?? 'music') === k);
                if (group.length === 0) return null;
                const collapsed = collapsedKinds.has(k);
                const KindIcon = KIND_META[k].icon;
                return (
                  <div key={k}>
                    <button
                      onClick={() => toggleKindCollapsed(k)}
                      className="w-full flex items-center gap-2 px-3 py-2 border-b border-zinc-800/60 bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors"
                    >
                      <ChevronRight className={`w-3 h-3 text-zinc-300 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
                      <KindIcon className="w-3 h-3 text-zinc-300" />
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-300">{KIND_META[k].label} ({group.length})</span>
                    </button>
                    {!collapsed && group.map(renderItem)}
                  </div>
                );
              });
            })()}
          </div>
        </div>

        {/* Right: editor */}
        {draft ? (
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Kind + Type + Params */}
            <div className="flex-1 min-h-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 pb-5 pt-3 space-y-6 overflow-auto">
              <div>
                <label className="flex items-center gap-1 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                  Name
                  <HelpTooltip text="Display name for this rotation. Used in show playlists, clock segments, and logs." />
                </label>
                <input
                  value={draft.name}
                  onChange={(e) => updateDraft((d) => ({ ...d, name: e.target.value }))}
                  className={`w-full px-3 py-2 bg-zinc-800 border rounded-lg text-sm text-white focus:outline-none ${nameExists(draft.name, draft.id) ? 'border-red-500 focus:border-red-500' : 'border-zinc-700 focus:border-brand-500'}`}
                />
                {nameExists(draft.name, draft.id) && (
                  <p className="mt-1.5 text-xs text-red-400">A rotation with this name already exists.</p>
                )}
              </div>
              <div className="flex items-center gap-3 pb-3 border-b border-zinc-800/60">
                {(() => {
                  const Icon = KIND_META[draft.kind].icon;
                  return <Icon className="w-4 h-4 text-zinc-400" />;
                })()}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200">{KIND_META[draft.kind].label} rotation</div>
                  <div className="text-xs text-zinc-500">{KIND_META[draft.kind].desc}</div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Algorithm
                </label>
                <div className="flex flex-wrap gap-2">
                  {ROTATION_TYPES.map((type) => {
                    const meta = TYPE_META[type];
                    const isActive = draft.type === type;
                    return (
                      <button
                        key={type}
                        onClick={() => handleTypeChange(type)}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          isActive
                            ? `${meta.bg} ${meta.border} ${meta.text} font-medium`
                            : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                        }`}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-zinc-500">{TYPE_META[draft.type].desc}</p>
              </div>

              {draft.kind === 'sweeper' && (
                <div>
                  <label className="flex items-center gap-1 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                    Fire at
                    <HelpTooltip text={<>When this sweeper fires relative to the underlying music track. <span className="font-semibold text-white">At song start</span> fires before the first bar; <span className="font-semibold text-white">At song end</span> fires after it finishes; <span className="font-semibold text-white">Any time</span> fires mid-track. Source pool is defined in Clocks → Sweepers.</>} />
                  </label>
                  <select
                    value={draft.song_position ?? 'any'}
                    onChange={(e) =>
                      updateDraft((d) => ({ ...d, song_position: e.target.value as SongPosition }))
                    }
                    className={`max-w-xs ${SELECT}`}
                  >
                    {SONG_POSITIONS.map((p) => (
                      <option key={p} value={p} className="bg-zinc-900">{SONG_POSITION_LABELS[p]}</option>
                    ))}
                  </select>
                </div>
              )}

              <ParamsForm type={draft.type} params={draft.params} onChange={updateParam} />

              {draft.kind === 'music' && (
                <div className="pt-4 border-t border-zinc-800/60">
                  <div className="flex items-center gap-2 mb-3">
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                      Hot play
                    </label>
                    <HelpTooltip text="Slips one track from the hot-play playlist into this rotation every N picks from the main pool. Leave the playlist as 'None' to disable." />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500">playlist</span>
                      <select
                        value={draft.hot_play_playlist_id ?? ''}
                        onChange={(e) => {
                          const v = e.target.value === '' ? null : Number(e.target.value);
                          updateDraft((d) => ({
                            ...d,
                            hot_play_playlist_id: v,
                            // Clearing the playlist also clears the cadence so the
                            // two fields stay consistent (both null = disabled).
                            hot_play_every_n_tracks:
                              v === null ? null : (d.hot_play_every_n_tracks ?? 3),
                          }));
                        }}
                        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 focus:outline-none focus:border-brand-500"
                      >
                        <option value="">None</option>
                        {musicPlaylists.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    {draft.hot_play_playlist_id != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-500">every</span>
                        <input
                          type="number"
                          min={1}
                          value={draft.hot_play_every_n_tracks ?? 3}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            updateDraft((d) => ({
                              ...d,
                              hot_play_every_n_tracks: Number.isFinite(n) && n >= 1 ? n : null,
                            }));
                          }}
                          className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-200 text-center focus:outline-none focus:border-brand-500"
                        />
                        <span className="text-xs text-zinc-500">tracks</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    e.g. rotation plays 80s music with one current hit slipped in every 3 tracks: {`80s, 80s, 80s, HOT, 80s, 80s, 80s, HOT…`}
                  </p>
                </div>
              )}

              {draft.kind === 'music' && (
                <div className="pt-4 border-t border-zinc-800/60">
                  <div className="flex items-center gap-2 mb-3">
                    <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                      Heavy rotation
                    </label>
                    <HelpTooltip text="When enabled, this rotation prioritizes tracks from active music campaigns (managed under Advertising → Music Campaigns) by per-day pacing before drawing from its normal pool. Contracted songs that are behind their daily target play first." />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-zinc-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.heavy_rotation_enabled}
                      onChange={(e) =>
                        updateDraft((d) => ({ ...d, heavy_rotation_enabled: e.target.checked }))
                      }
                      className="accent-brand-500"
                    />
                    <span>Prioritize active music campaigns by pacing</span>
                  </label>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg">
            <p className="text-zinc-400 text-sm">Select a rotation to edit it</p>
          </div>
        )}
      </div>
    </div>

    {/* New Rotation modal */}

    {creatingNew && (
      <div className={MODAL_OVERLAY} onClick={() => { setCreatingNew(false); setNewName(''); }}>
        <div className={`${MODAL_BOX} max-w-sm p-6 gap-5`} onClick={(e) => e.stopPropagation()}>
          <h2 className="text-base font-semibold text-white">New Rotation</h2>

          <div className="flex gap-2">
            {ROTATION_KINDS.map((k) => {
              const Icon = KIND_META[k].icon;
              return (
                <button
                  key={k}
                  onClick={() => setNewKind(k)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-colors ${
                    newKind === k
                      ? 'bg-brand-600/30 text-brand-300 border-brand-500/50'
                      : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {KIND_META[k].label}
                </button>
              );
            })}
          </div>

          <div>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim() && !createMutation.isPending && !nameExists(newName)) createMutation.mutate({ name: newName.trim(), kind: newKind });
                if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
              }}
              placeholder="Rotation name…"
              className={`${INPUT} ${newName.trim() && nameExists(newName) ? 'border-red-500 focus:border-red-500' : ''}`}
            />
            {newName.trim() && nameExists(newName) && (
              <p className="mt-1.5 text-xs text-red-400">A rotation with this name already exists.</p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { setCreatingNew(false); setNewName(''); }} className={BTN_SECONDARY}>
              Cancel
            </button>
            <button
              onClick={() => newName.trim() && !nameExists(newName) && !createMutation.isPending && createMutation.mutate({ name: newName.trim(), kind: newKind })}
              disabled={!newName.trim() || nameExists(newName) || createMutation.isPending}
              className={BTN_PRIMARY}
            >
              {createMutation.isPending ? 'Creating…' : 'Create Rotation'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function ParamsForm({
  type, params, onChange,
}: {
  type: RotationType;
  params: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  if (type === 'random_separation') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="flex items-center gap-1 text-sm text-zinc-300 mb-1.5">
              Track separation
              <HelpTooltip text="Minimum minutes that must pass before the same track can play again. Set higher for small playlists to reduce repetition." />
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={480}
                value={(params.separation_minutes as number) ?? 60}
                onChange={(e) => onChange('separation_minutes', Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500"
              />
              <span className="text-xs text-zinc-400">min</span>
            </div>
          </div>
          <div>
            <label className="flex items-center gap-1 text-sm text-zinc-300 mb-1.5">
              Artist separation
              <HelpTooltip text={<>Minimum minutes between tracks by the same artist. Set to <span className="font-semibold text-white">0</span> to disable artist separation entirely.</>} />
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={240}
                value={(params.artist_separation_minutes as number) ?? 0}
                onChange={(e) => onChange('artist_separation_minutes', Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500"
              />
              <span className="text-xs text-zinc-400">min (0 = off)</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'least_recently_played') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div>
          <label className="flex items-center gap-1 text-sm text-zinc-300 mb-1.5">
            Pool size
            <span className="text-zinc-500">(optional)</span>
            <HelpTooltip text="Limits candidates to the N tracks played least recently. Leave blank to consider the entire playlist." />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              placeholder="All"
              value={(params.pool_size as number | undefined) ?? ''}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                onChange('pool_size', isNaN(v) ? undefined : Math.max(1, v));
              }}
              className="w-20 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-white focus:outline-none focus:border-brand-500 placeholder:text-zinc-600"
            />
            <span className="text-xs text-zinc-400">tracks (blank = all)</span>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'round_robin') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div>
          <label className="flex items-center gap-1 text-sm text-zinc-300 mb-1.5">
            Order by
            <HelpTooltip text={<>Fixed cycle order. <span className="font-semibold text-white">Date added</span> cycles chronologically; <span className="font-semibold text-white">Manual order</span> follows the playlist's drag order.</>} />
          </label>
          <select
            value={(params.order_by as string) ?? 'added_date'}
            onChange={(e) => onChange('order_by', e.target.value)}
            className={`max-w-xs ${SELECT}`}
          >
            <option value="added_date">Date added</option>
            <option value="title">Title (A–Z)</option>
            <option value="artist">Artist (A–Z)</option>
            <option value="manual">Manual order</option>
          </select>
        </div>
      </div>
    );
  }

  // weighted — no params
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
        Parameters
      </label>
      <p className="text-sm text-zinc-500">
        Weighted rotation has no extra parameters. Track probability is controlled by the weight
        column in the playlist.
      </p>
    </div>
  );
}
