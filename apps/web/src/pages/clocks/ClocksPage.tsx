import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus, GripVertical, Trash2, Check, X, Clock,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import {
  Clock as ClockType,
  ClockSegment,
  ClockSegmentType,
  SegmentSourceEntry,
  CLOCK_SEGMENT_TYPES,
  StartPolicy,
  SweeperType,
  SWEEPER_TYPES,
  SilenceDetectionAction,
  SILENCE_DETECTION_ACTIONS,
  RecoveryTactic,
  RECOVERY_TACTICS,
  TrailingTimeStrategy,
  TRAILING_TIME_STRATEGIES,
} from '@radio/shared';
import {
  fetchClocks,
  fetchClockSegments,
  createClock,
  updateClock,
  deleteClock,
  replaceClockSegments,
} from '../../api';

// ─── Segment metadata ─────────────────────────────────────────────────────────

const SEGMENT_META: Record<ClockSegmentType, { label: string; color: string; bg: string; border: string; text: string }> = {
  music:         { label: 'Music',          color: '#6366f1', bg: 'bg-indigo-500/15',  border: 'border-indigo-500/40',  text: 'text-indigo-300'  },
  live:          { label: 'Live',           color: '#10b981', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300' },
  live_audience: { label: 'Live Audience',  color: '#06b6d4', bg: 'bg-cyan-500/15',    border: 'border-cyan-500/40',    text: 'text-cyan-300'    },
  stop_set:      { label: 'Stop Set',       color: '#f59e0b', bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-300'   },
  news:          { label: 'News',           color: '#f43f5e', bg: 'bg-rose-500/15',    border: 'border-rose-500/40',    text: 'text-rose-300'    },
  voice_track:   { label: 'Voice Tracking', color: '#fb923c', bg: 'bg-orange-500/15',  border: 'border-orange-500/40',  text: 'text-orange-300'  },
  bulletin:      { label: 'Bulletin',       color: '#a78bfa', bg: 'bg-violet-500/15',  border: 'border-violet-500/40',  text: 'text-violet-300'  },
};

// Source type labels (for SegmentSourceEntry['type'])
const SOURCE_LABELS: Record<SegmentSourceEntry['type'], string> = {
  show_playlist: 'Show playlist',
  show_jingles:  'Show jingles',
  show_beds:     'Show beds',
  promos:        'Promos',
  playlist:      'Specific playlist',
  campaigns:     'Campaigns',
  live:          'Harbor (live)',
  recording:     'Recording',
};

// Available source types per segment type
const VALID_SOURCE_TYPES: Record<ClockSegmentType, SegmentSourceEntry['type'][]> = {
  music:         ['show_playlist', 'playlist'],
  live:          ['live'],
  live_audience: ['live'],
  stop_set:      ['campaigns', 'promos', 'playlist'],
  news:          ['live', 'recording'],
  voice_track:   ['playlist'],
  bulletin:      ['live'],
};

const RECOVERY_TACTIC_LABELS: Record<RecoveryTactic, string> = {
  trim_outro:  'Trim outro',
  skip_song:   'Skip song',
  drop_queued: 'Drop queued',
};

const RECOVERY_TACTIC_DESC: Record<RecoveryTactic, string> = {
  trim_outro:  'Fade the current track out a few seconds early. Least disruptive — applied gradually across multiple tracks to claw back small amounts of drift.',
  skip_song:   'Abort the current track and jump to the next pick. Used when trimming alone is not recovering fast enough.',
  drop_queued: 'Flush the entire queue and re-pick fresh. Last resort for large drift — most disruptive to the listener.',
};

const TRAILING_TIME_LABELS: Record<TrailingTimeStrategy, string> = {
  skip_events:        'Skip late events',
  fill:               'Fill gap',
  early_handover:     'Hand over early',
  hard_cut_with_jingle: 'Hard cut with jingle',
};

const TRAILING_TIME_DESC: Record<TrailingTimeStrategy, string> = {
  skip_events:        "Stop queuing content that won't finish before the incoming hard cut. Prevents events being abruptly cut mid-track.",
  fill:               'Fill the remaining gap with short clips from the filler playlist (jingles, promos) to keep the air time occupied cleanly.',
  early_handover:     "If the gap can't be filled, give up the remaining time and let the next segment start ahead of schedule. Only works if the next segment permits early starts.",
  hard_cut_with_jingle: 'Cut the current content immediately, play one short clip from the end clip playlist as a bridge, then hand over to the next segment.',
};

const DURATION_DEFAULT: Record<ClockSegmentType, number> = {
  music:          480,
  live:           600,
  live_audience:  300,
  stop_set:       180,
  news:           120,
  voice_track:     60,
  bulletin:        60,
};

const DURATION_STEP: Record<ClockSegmentType, number> = {
  music:          30,
  live:           60,
  live_audience:  30,
  stop_set:       30,
  news:           30,
  voice_track:    15,
  bulletin:       15,
};

type SegmentDraft = ClockSegment;

const TYPE_DEFAULTS: Record<ClockSegmentType, {
  sources: SegmentSourceEntry[];
  start_policy: StartPolicy;
  trailing_time: TrailingTimeStrategy[];
  accept_live: boolean;
  accept_sweepers: SweeperType[];
  recovery_tactics: RecoveryTactic[];
}> = {
  music:         { sources: [{ type: 'show_playlist', weight: 1 }],           start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: ['skip_events', 'fill', 'early_handover'], accept_live: true,  accept_sweepers: ['commercial', 'promo', 'station_id', 'jingle'], recovery_tactics: ['trim_outro', 'skip_song', 'drop_queued'] },
  live:          { sources: [{ type: 'live' }],                                start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: [],                                         accept_live: true,  accept_sweepers: ['station_id', 'jingle'],                         recovery_tactics: [] },
  live_audience: { sources: [{ type: 'live' }],                                start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: [],                                         accept_live: true,  accept_sweepers: ['station_id', 'jingle'],                         recovery_tactics: [] },
  stop_set:      { sources: [{ type: 'campaigns' }, { type: 'promos', weight: 1 }], start_policy: { type: 'hard' },                                    trailing_time: ['skip_events', 'fill'],                     accept_live: false, accept_sweepers: [],                                               recovery_tactics: [] },
  news:          { sources: [{ type: 'live' }],                                start_policy: { type: 'hard' },                                    trailing_time: ['skip_events', 'fill'],                     accept_live: true,  accept_sweepers: [],                                               recovery_tactics: [] },
  voice_track:   { sources: [],                                                 start_policy: { type: 'hard' },                                    trailing_time: [],                                         accept_live: false, accept_sweepers: [],                                               recovery_tactics: [] },
  bulletin:      { sources: [{ type: 'live' }],                                start_policy: { type: 'hard' },                                    trailing_time: [],                                         accept_live: true,  accept_sweepers: [],                                               recovery_tactics: [] },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}m` : `${m}m ${r}s`;
}

function totalSeconds(segments: SegmentDraft[]): number {
  return segments.reduce((acc, s) => acc + s.duration_seconds, 0);
}

function makeDefaultSource(type: SegmentSourceEntry['type']): SegmentSourceEntry {
  switch (type) {
    case 'show_playlist': return { type, weight: 1 };
    case 'show_jingles':  return { type, weight: 1 };
    case 'show_beds':     return { type, weight: 1 };
    case 'promos':        return { type, weight: 1 };
    case 'playlist':      return { type, playlist_id: 1, weight: 1, hot_play: false, heavy_rotation: false };
    case 'campaigns':     return { type };
    case 'live':          return { type };
    case 'recording':     return { type };
  }
}

let _tempId = -1;
function newTempId() { return _tempId--; }

function segmentFromType(clockId: number, type: ClockSegmentType, order: number): SegmentDraft {
  const d = TYPE_DEFAULTS[type];
  return {
    id: newTempId(),
    clock_id: clockId,
    sort_order: order,
    name: SEGMENT_META[type].label,
    type,
    duration_seconds: DURATION_DEFAULT[type],
    sources: d.sources,
    filler_playlist_id: null,
    start_clip_playlist_id: null,
    end_clip_playlist_id: null,
    bed_playlist_id: null,
    interstitial_jingle_playlist_id: null,
    jingle_every_n_tracks: null,
    start_policy: d.start_policy,
    trailing_time: d.trailing_time,
    recovery_tactics: d.recovery_tactics,
    accept_live: d.accept_live,
    accept_sweepers: d.accept_sweepers,
    silence_detection_action: null,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ClocksPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftClock, setDraftClock] = useState<ClockType | null>(null);
  const [draftSegs, setDraftSegs] = useState<SegmentDraft[]>([]);
  const [clockDirty, setClockDirty] = useState(false);
  const [segsDirty, setSegsDirty] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty = clockDirty || segsDirty;

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });

  const { data: loadedSegments = [] } = useQuery({
    queryKey: ['clock-segments', selectedId],
    queryFn: () => fetchClockSegments(selectedId!),
    enabled: selectedId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const promises: Promise<unknown>[] = [];
      if (clockDirty && draftClock)
        promises.push(updateClock(draftClock.id, { name: draftClock.name, description: draftClock.description, sweep_config: draftClock.sweep_config }));
      if (segsDirty && draftClock)
        promises.push(replaceClockSegments(draftClock.id, draftSegs));
      await Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      queryClient.invalidateQueries({ queryKey: ['clock-segments', selectedId] });
      setClockDirty(false);
      setSegsDirty(false);
      showToast('success', 'Clock saved');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const createMutation = useMutation({
    mutationFn: createClock,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      setCreatingNew(false);
      setNewName('');
      selectClock(created, []);
      showToast('success', 'Clock created');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteClock,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      queryClient.removeQueries({ queryKey: ['clock-segments', selectedId] });
      setSelectedId(null);
      setDraftClock(null);
      setDraftSegs([]);
      setClockDirty(false);
      setSegsDirty(false);
      setConfirmDelete(false);
      setExpandedId(null);
      showToast('success', 'Clock deleted');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const selectClock = (clock: ClockType, segments: ClockSegment[]) => {
    setSelectedId(clock.id);
    setDraftClock(JSON.parse(JSON.stringify(clock)));
    setDraftSegs(JSON.parse(JSON.stringify(segments)));
    setClockDirty(false);
    setSegsDirty(false);
    setConfirmDelete(false);
    setExpandedId(null);
  };

  const handleClockClick = (clock: ClockType) => {
    if (clock.id === selectedId) return;
    const segs = queryClient.getQueryData<ClockSegment[]>(['clock-segments', clock.id]) ?? [];
    selectClock(clock, segs);
  };

  if (selectedId !== null && !segsDirty && draftSegs.length === 0 && loadedSegments.length > 0) {
    setDraftSegs(JSON.parse(JSON.stringify(loadedSegments)));
  }

  const updateDraftClock = (updater: (c: ClockType) => ClockType) => {
    setDraftClock((prev) => prev ? updater(prev) : prev);
    setClockDirty(true);
  };

  const handleDiscard = () => {
    const originalClock = clocks.find((c) => c.id === selectedId);
    if (originalClock) {
      setDraftClock(JSON.parse(JSON.stringify(originalClock)));
      setClockDirty(false);
    }
    setDraftSegs(JSON.parse(JSON.stringify(loadedSegments)));
    setSegsDirty(false);
    setExpandedId(null);
  };

  // ── Segment operations ──────────────────────────────────────────────────────

  const updateSeg = (id: number, patch: Partial<SegmentDraft>) => {
    setDraftSegs((prev) => prev.map((s) => s.id === id ? { ...s, ...patch } : s));
    setSegsDirty(true);
  };

  const addSeg = (type: ClockSegmentType) => {
    if (!draftClock) return;
    const newSeg = segmentFromType(draftClock.id, type, draftSegs.length);
    setDraftSegs((prev) => [...prev, newSeg]);
    setSegsDirty(true);
    setExpandedId(newSeg.id);
  };

  const deleteSeg = (id: number) => {
    setDraftSegs((prev) => prev.filter((s) => s.id !== id));
    if (expandedId === id) setExpandedId(null);
    setSegsDirty(true);
  };

  const reorderSegs = (oldIndex: number, newIndex: number) => {
    setDraftSegs((prev) => arrayMove(prev, oldIndex, newIndex));
    setSegsDirty(true);
  };

  const changeSegType = (id: number, newType: ClockSegmentType) => {
    const d = TYPE_DEFAULTS[newType];
    setDraftSegs((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      return {
        ...s,
        type: newType,
        name: s.name === SEGMENT_META[s.type].label ? SEGMENT_META[newType].label : s.name,
        sources: d.sources,
        duration_seconds: s.duration_seconds === DURATION_DEFAULT[s.type] ? DURATION_DEFAULT[newType] : s.duration_seconds,
        start_policy: d.start_policy,
        trailing_time: d.trailing_time,
        accept_live: d.accept_live,
        accept_sweepers: d.accept_sweepers,
        recovery_tactics: d.recovery_tactics,
      };
    }));
    setSegsDirty(true);
  };

  const total = totalSeconds(draftSegs);
  const overflow = total > 3600;

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">Clocks</h1>
          <p className="text-zinc-400 mt-1 text-sm">Build reusable hour templates — drag segments to reorder.</p>
        </div>
      </div>

      {toast && (
        <div className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm ${toast.type === 'success' ? 'bg-green-900/20 border border-green-800 text-green-300' : 'bg-red-900/20 border border-red-800 text-red-300'}`}>
          {toast.message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: clock list */}
        <div className="w-56 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Clocks</span>
            <button onClick={() => setCreatingNew(true)} className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors" title="New clock">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {creatingNew && (
            <div className="px-3 py-2 border-b border-zinc-800 flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) createMutation.mutate({ name: newName.trim() });
                  if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
                }}
                placeholder="Clock name…"
                className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <button onClick={() => newName.trim() && createMutation.mutate({ name: newName.trim() })} className="p-1 text-indigo-400 hover:text-indigo-300 transition-colors">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setCreatingNew(false); setNewName(''); }} className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            {clocks.length === 0 && !creatingNew && (
              <p className="px-4 py-6 text-xs text-zinc-400 text-center">No clocks yet.<br />Create one to get started.</p>
            )}
            {clocks.map((clock) => {
              const segs = clock.id === selectedId ? draftSegs : (queryClient.getQueryData<ClockSegment[]>(['clock-segments', clock.id]) ?? []);
              const secs = totalSeconds(segs);
              const isSelected = clock.id === selectedId;
              return (
                <button key={clock.id} onClick={() => handleClockClick(clock)} className={`w-full text-left px-4 py-3 border-b border-zinc-800/60 transition-colors ${isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'}`}>
                  <div className="flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-white truncate">{clock.name}</span>
                  </div>
                  <div className="flex gap-2 mt-1 ml-5">
                    <span className={`text-xs ${secs > 3600 ? 'text-red-400' : 'text-zinc-400'}`}>{fmtDuration(secs)}</span>
                    <span className="text-xs text-zinc-400">· {segs.length} seg</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: editor */}
        {draftClock ? (
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Clock header */}
            <div className="flex-shrink-0 flex items-start gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
              <div className="flex-1 min-w-0">
                <input
                  value={draftClock.name}
                  onChange={(e) => updateDraftClock((c) => ({ ...c, name: e.target.value }))}
                  className="text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-full transition-colors pb-0.5"
                />
                <input
                  value={draftClock.description ?? ''}
                  onChange={(e) => updateDraftClock((c) => ({ ...c, description: e.target.value || null }))}
                  placeholder="Add a description…"
                  className="mt-1 text-sm text-zinc-300 bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-full transition-colors pb-0.5 placeholder:text-zinc-500"
                />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {dirty && (
                  <>
                    <button onClick={handleDiscard} className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">Discard</button>
                    <button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50">
                      {saveMutation.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
                {!dirty && !confirmDelete && (
                  <button onClick={() => setConfirmDelete(true)} className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors" title="Delete clock">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                {confirmDelete && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">Delete?</span>
                    <button onClick={() => deleteMutation.mutate(draftClock.id)} disabled={deleteMutation.isPending} className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors">Yes</button>
                    <button onClick={() => setConfirmDelete(false)} className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
                  </div>
                )}
              </div>
            </div>

            {/* Timeline */}
            <ClockTimeline segments={draftSegs} total={total} overflow={overflow} />

            {/* Segment list */}
            <div className="flex-1 min-h-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Segments</span>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded ${overflow ? 'bg-red-900/30 text-red-400' : 'bg-zinc-800 text-zinc-400'}`}>
                    {fmtDuration(total)} / 60m{overflow ? ` — over by ${fmtDuration(total - 3600)}` : ''}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 justify-end">
                  {CLOCK_SEGMENT_TYPES.map((type) => {
                    const meta = SEGMENT_META[type];
                    return (
                      <button key={type} onClick={() => addSeg(type)} className={`px-2.5 py-1 text-xs rounded border transition-colors ${meta.bg} ${meta.border} ${meta.text} hover:brightness-125`}>
                        + {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                <SegmentList
                  segments={draftSegs}
                  expandedId={expandedId}
                  onExpandToggle={(id) => setExpandedId((prev) => prev === id ? null : id)}
                  onDragStart={() => setExpandedId(null)}
                  onReorder={reorderSegs}
                  onUpdate={updateSeg}
                  onDelete={deleteSeg}
                  onChangeType={changeSegType}
                />
                {draftSegs.length === 0 && (
                  <div className="px-5 py-10 text-center text-zinc-400 text-sm">
                    No segments yet — use the buttons above to add segments.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg">
            <p className="text-zinc-400 text-sm">Select a clock to edit it</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function ClockTimeline({ segments, total, overflow }: { segments: SegmentDraft[]; total: number; overflow: boolean }) {
  const cap = Math.max(total, 3600);
  return (
    <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Hour overview</span>
        <span className="text-xs text-zinc-400 font-mono">60 min</span>
      </div>
      <div className="relative h-12 flex rounded overflow-hidden bg-zinc-800">
        {segments.map((seg) => {
          const meta = SEGMENT_META[seg.type];
          const widthPct = (seg.duration_seconds / cap) * 100;
          return (
            <div key={seg.id} className="flex items-center justify-center overflow-hidden transition-all duration-150 border-r border-zinc-900/50 last:border-r-0" style={{ width: `${widthPct}%`, backgroundColor: meta.color + '33' }} title={`${seg.name} · ${fmtDuration(seg.duration_seconds)}`}>
              {seg.duration_seconds >= 240 && (
                <span className="text-xs font-medium truncate px-1" style={{ color: meta.color }}>
                  {seg.duration_seconds >= 480 ? seg.name : fmtDuration(seg.duration_seconds)}
                </span>
              )}
            </div>
          );
        })}
        {total < 3600 && (
          <div className="flex items-center justify-center" style={{ width: `${((3600 - total) / 3600) * 100}%` }}>
            <span className="text-xs text-zinc-400">{fmtDuration(3600 - total)} free</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
        {CLOCK_SEGMENT_TYPES.filter((t) => segments.some((s) => s.type === t)).map((type) => {
          const meta = SEGMENT_META[type];
          const secs = segments.filter((s) => s.type === type).reduce((a, s) => a + s.duration_seconds, 0);
          return (
            <div key={type} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: meta.color + '88' }} />
              <span className="text-xs text-zinc-300">{meta.label}</span>
              <span className="text-xs text-zinc-400 font-mono">{fmtDuration(secs)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Segment list (accordion) ─────────────────────────────────────────────────

function SegmentList({
  segments, expandedId, onExpandToggle, onDragStart, onReorder, onUpdate, onDelete, onChangeType,
}: {
  segments: SegmentDraft[];
  expandedId: number | null;
  onExpandToggle: (id: number) => void;
  onDragStart: () => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragStart = (_event: DragStartEvent) => { onDragStart(); };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = segments.findIndex((s) => s.id === active.id);
    const newIndex = segments.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) onReorder(oldIndex, newIndex);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SortableContext items={segments.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div className="divide-y divide-zinc-800/60">
          {segments.map((seg) => (
            <SortableSegmentItem
              key={seg.id}
              segment={seg}
              isExpanded={expandedId === seg.id}
              onExpand={() => onExpandToggle(seg.id)}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onChangeType={onChangeType}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ─── Sortable segment item ────────────────────────────────────────────────────

function SortableSegmentItem({
  segment, isExpanded, onExpand, onUpdate, onDelete, onChangeType,
}: {
  segment: SegmentDraft;
  isExpanded: boolean;
  onExpand: () => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segment.id });
  const meta = SEGMENT_META[segment.type];

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative' as const,
  };

  const ttAbbrev = segment.trailing_time
    .map((s) => ({ skip_events: 'skip', fill: 'fill', early_handover: '↩', hard_cut_with_jingle: '♪↩' }[s]))
    .join('·');

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer group transition-colors ${isExpanded ? 'bg-zinc-800/60' : 'hover:bg-zinc-800/30'}`}
        onClick={onExpand}
      >
        <button
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
          className="cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-300 transition-colors touch-none flex-shrink-0 p-0.5"
        >
          <GripVertical className="w-4 h-4" />
        </button>

        <span className="text-zinc-500 flex-shrink-0">
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>

        <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded border ${meta.bg} ${meta.border} ${meta.text}`}>
          {meta.label}
        </span>

        <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate">{segment.name}</span>

        <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded ${segment.start_policy.type === 'hard' ? 'bg-red-900/20 text-red-400' : 'bg-zinc-800 text-zinc-400'}`}>
          {segment.start_policy.type === 'hard' ? 'hard' : 'soft'} start
        </span>

        {ttAbbrev && (
          <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">
            {ttAbbrev}
          </span>
        )}

        <span className="flex-shrink-0 text-xs text-zinc-400 font-mono w-12 text-right">{fmtDuration(segment.duration_seconds)}</span>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(segment.id); }}
          className="flex-shrink-0 p-1 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className={`overflow-hidden transition-all duration-200 ${isExpanded ? 'max-h-[700px]' : 'max-h-0'}`}>
        {isExpanded && (
          <SegmentDrawer
            segment={segment}
            onApply={(patch) => onUpdate(segment.id, patch)}
            onChangeType={(type) => onChangeType(segment.id, type)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Segment drawer ───────────────────────────────────────────────────────────

type DrawerTab = 'content' | 'timing' | 'transitions' | 'live';

function SegmentDrawer({
  segment, onApply, onChangeType,
}: {
  segment: SegmentDraft;
  onApply: (patch: Partial<SegmentDraft>) => void;
  onChangeType: (type: ClockSegmentType) => void;
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const [draft, setDraft] = useState<SegmentDraft>({ ...segment });

  const update = (patch: Partial<SegmentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const meta = SEGMENT_META[draft.type];
  const isLive = draft.type === 'live' || draft.type === 'live_audience' || draft.type === 'bulletin';

  const TABS: { id: DrawerTab; label: string }[] = [
    { id: 'content', label: 'Content' },
    { id: 'timing', label: 'Timing' },
    { id: 'transitions', label: 'Branding' },
    { id: 'live', label: 'Sweepers & Live' },
  ];

  const softPolicy = draft.start_policy.type === 'soft'
    ? (draft.start_policy as Extract<StartPolicy, { type: 'soft' }>)
    : null;

  return (
    <div className="border-t border-zinc-700/60 bg-zinc-800/40">
      <div className="flex border-b border-zinc-700/60 px-4">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
              tab === t.id ? 'border-indigo-500 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-5">

        {/* ── Content tab ── */}
        {tab === 'content' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <input
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </Field>

            <Field label="Type">
              <select
                value={draft.type}
                onChange={(e) => {
                  const t = e.target.value as ClockSegmentType;
                  onChangeType(t);
                  const d = TYPE_DEFAULTS[t];
                  update({
                    type: t,
                    sources: d.sources,
                    start_policy: d.start_policy,
                    trailing_time: d.trailing_time,
                    accept_live: d.accept_live,
                    accept_sweepers: d.accept_sweepers,
                    recovery_tactics: d.recovery_tactics,
                  });
                }}
                className={`w-full px-3 py-1.5 rounded border text-sm bg-zinc-900 cursor-pointer focus:outline-none focus:border-indigo-500 ${meta.border} ${meta.text}`}
              >
                {CLOCK_SEGMENT_TYPES.map((t) => (
                  <option key={t} value={t} className="bg-zinc-900 text-white">{SEGMENT_META[t].label}</option>
                ))}
              </select>
            </Field>

            <Field label="Duration">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update({ duration_seconds: Math.max(DURATION_STEP[draft.type], draft.duration_seconds - DURATION_STEP[draft.type]) })}
                  className="w-7 h-7 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-sm font-bold"
                >−</button>
                <input
                  type="number"
                  min={1}
                  max={7200}
                  value={draft.duration_seconds}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1 && v <= 7200) update({ duration_seconds: v }); }}
                  className="w-20 text-center bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 py-1.5"
                />
                <button
                  onClick={() => update({ duration_seconds: Math.min(7200, draft.duration_seconds + DURATION_STEP[draft.type]) })}
                  className="w-7 h-7 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-sm font-bold"
                >+</button>
                <span className="text-sm text-zinc-400">{fmtDuration(draft.duration_seconds)}</span>
              </div>
            </Field>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-zinc-400 mb-2">Sources</label>
              <SourcesEditor
                sources={draft.sources}
                segType={draft.type}
                onChange={(sources) => update({ sources })}
              />
            </div>
          </div>
        )}

        {/* ── Timing tab ── */}
        {tab === 'timing' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start policy">
              <select
                value={draft.start_policy.type}
                onChange={(e) => {
                  const t = e.target.value as StartPolicy['type'];
                  update({ start_policy: t === 'hard' ? { type: 'hard' } : { type: 'soft', plus_seconds: 30, minus_seconds: 0 } });
                }}
                className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
              >
                <option value="hard" className="bg-zinc-900">Hard — cut on schedule</option>
                <option value="soft" className="bg-zinc-900">Soft — wait for natural end</option>
              </select>
            </Field>

            {softPolicy && (
              <Field label="Timing window" hint="How far late (+) or early (−) this segment may start.">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500">+</span>
                    <input
                      type="number"
                      min={0}
                      value={softPolicy.plus_seconds}
                      onChange={(e) => update({ start_policy: { type: 'soft', plus_seconds: parseInt(e.target.value) || 0, minus_seconds: softPolicy.minus_seconds } })}
                      className="w-16 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
                    />
                    <span className="text-xs text-zinc-500">s</span>
                  </div>
                  <span className="text-zinc-700">·</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-500">−</span>
                    <input
                      type="number"
                      min={0}
                      value={softPolicy.minus_seconds}
                      onChange={(e) => update({ start_policy: { type: 'soft', plus_seconds: softPolicy.plus_seconds, minus_seconds: parseInt(e.target.value) || 0 } })}
                      className="w-16 px-2 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
                    />
                    <span className="text-xs text-zinc-500">s</span>
                  </div>
                </div>
              </Field>
            )}

            <Field label="Recovery tactics" className="col-span-2">
              <p className="mb-2.5 text-xs text-zinc-500">Applied in order when this segment is <span className="text-zinc-400">running over</span> its scheduled end toward a hard-start successor. Tactics escalate from least to most disruptive.</p>
              <div className="space-y-2.5">
                {RECOVERY_TACTICS.map((t) => (
                  <label key={t} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.recovery_tactics.includes(t)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? RECOVERY_TACTICS.filter((x) => draft.recovery_tactics.includes(x) || x === t)
                          : draft.recovery_tactics.filter((x) => x !== t);
                        update({ recovery_tactics: next });
                      }}
                      className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-xs font-medium text-zinc-200">{RECOVERY_TACTIC_LABELS[t]}</span>
                      <p className="text-xs text-zinc-500">{RECOVERY_TACTIC_DESC[t]}</p>
                    </div>
                  </label>
                ))}
              </div>
            </Field>

            <Field label="Trailing time" className="col-span-2">
              <p className="mb-2.5 text-xs text-zinc-500">Applied when this segment has <span className="text-zinc-400">leftover time</span> before being cut short by an incoming hard-start successor. Strategies are tried in order.</p>
              <div className="space-y-2.5">
                {TRAILING_TIME_STRATEGIES.map((s) => (
                  <label key={s} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.trailing_time.includes(s)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? TRAILING_TIME_STRATEGIES.filter((x) => draft.trailing_time.includes(x) || x === s)
                          : draft.trailing_time.filter((x) => x !== s);
                        update({ trailing_time: next });
                      }}
                      className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                    />
                    <div>
                      <span className="text-xs font-medium text-zinc-200">{TRAILING_TIME_LABELS[s]}</span>
                      <p className="text-xs text-zinc-500">{TRAILING_TIME_DESC[s]}</p>
                    </div>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}

        {/* ── Transitions tab ── */}
        {tab === 'transitions' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start clip playlist" hint="Plays before segment content">
              <PlaylistIdInput value={draft.start_clip_playlist_id} onChange={(v) => update({ start_clip_playlist_id: v })} />
            </Field>
            <Field label="End clip playlist" hint="Plays after segment content">
              <PlaylistIdInput value={draft.end_clip_playlist_id} onChange={(v) => update({ end_clip_playlist_id: v })} />
            </Field>
            {isLive && (
              <Field label="Bed playlist" hint="Background audio under harbor input">
                <PlaylistIdInput value={draft.bed_playlist_id} onChange={(v) => update({ bed_playlist_id: v })} />
              </Field>
            )}
            <Field label="Filler playlist" hint="Short content to fill gaps from look-ahead scheduling">
              <PlaylistIdInput value={draft.filler_playlist_id} onChange={(v) => update({ filler_playlist_id: v })} />
            </Field>

            {draft.type === 'music' && (
              <div className="col-span-2 border-t border-zinc-800 pt-4 mt-1">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Interstitial jingles</p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Jingle playlist" hint="Short station IDs or show jingles inserted between tracks">
                    <PlaylistIdInput
                      value={draft.interstitial_jingle_playlist_id}
                      onChange={(v) => update({ interstitial_jingle_playlist_id: v })}
                    />
                  </Field>
                  <Field label="Every N songs" hint="Insert one jingle after every N tracks (leave blank to disable)">
                    <input
                      type="number"
                      min={1}
                      max={20}
                      placeholder="—"
                      value={draft.jingle_every_n_tracks ?? ''}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        update({ jingle_every_n_tracks: !isNaN(v) && v >= 1 ? v : null });
                      }}
                      className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Sweepers & Live tab ── */}
        {tab === 'live' && (
          <div className="grid grid-cols-2 gap-4">
            {!isLive && (
              <Field label="Accept live (harbor)" className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.accept_live}
                    onChange={(e) => update({ accept_live: e.target.checked })}
                    className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-zinc-300">Allow DJ to go live during this segment</span>
                </label>
              </Field>
            )}

            {draft.type !== 'stop_set' && (
              <Field label="Accept sweepers" className="col-span-2">
                <div className="flex gap-4">
                  {SWEEPER_TYPES.map((t) => (
                    <label key={t} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.accept_sweepers.includes(t)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...draft.accept_sweepers, t]
                            : draft.accept_sweepers.filter((x) => x !== t);
                          update({ accept_sweepers: next });
                        }}
                        className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-zinc-300">{t.replace(/_/g, ' ')}</span>
                    </label>
                  ))}
                </div>
              </Field>
            )}

            {isLive && (
              <Field label="Silence detection action" hint="Triggered when silence is detected on the harbor input">
                <select
                  value={draft.silence_detection_action ?? 'none'}
                  onChange={(e) => update({ silence_detection_action: e.target.value === 'none' ? null : e.target.value as SilenceDetectionAction })}
                  className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
                >
                  <option value="none" className="bg-zinc-900">None</option>
                  {SILENCE_DETECTION_ACTIONS.filter((a) => a !== 'none').map((a) => (
                    <option key={a} value={a} className="bg-zinc-900">{a.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 px-5 pb-4">
        <button
          onClick={() => onApply(draft)}
          className="px-4 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ─── Sources editor ───────────────────────────────────────────────────────────

const IMPLICIT_LIVE_TYPES: ClockSegmentType[] = ['live', 'live_audience', 'bulletin'];

type PlaylistSource = Extract<SegmentSourceEntry, { type: 'playlist' }>;

function SourcesEditor({
  sources, segType, onChange,
}: {
  sources: SegmentSourceEntry[];
  segType: ClockSegmentType;
  onChange: (sources: SegmentSourceEntry[]) => void;
}) {
  // Live types — harbor is implicit, nothing to configure
  if (IMPLICIT_LIVE_TYPES.includes(segType)) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="text-sm text-zinc-400">Harbor (live input)</span>
      </div>
    );
  }

  // News — single source, either harbor or recordings (mutually exclusive)
  if (segType === 'news') {
    const currentType = (sources[0]?.type ?? 'live') as 'live' | 'recording';
    return (
      <select
        value={currentType}
        onChange={(e) => onChange([makeDefaultSource(e.target.value as 'live' | 'recording')])}
        className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
      >
        <option value="live" className="bg-zinc-900">Harbor (live)</option>
        <option value="recording" className="bg-zinc-900">Recordings</option>
      </select>
    );
  }

  // Voice track — single fixed playlist
  if (segType === 'voice_track') {
    const current = sources[0] as PlaylistSource | undefined;
    return (
      <PlaylistIdInput
        value={current?.playlist_id ?? null}
        onChange={(v) => onChange(v !== null ? [{ type: 'playlist', playlist_id: v, weight: 1, hot_play: false, heavy_rotation: false }] : [])}
      />
    );
  }

  // Music and stop_set — multi-source list
  const validTypes = VALID_SOURCE_TYPES[segType];
  const showWeight = segType === 'music';

  // 'playlist' can appear multiple times; all other types are single-use
  const REPEATABLE = new Set<SegmentSourceEntry['type']>(['playlist']);

  const addSource = () => {
    const usedSingles = new Set(sources.filter((s) => !REPEATABLE.has(s.type)).map((s) => s.type));
    const pick = validTypes.find((t) => !REPEATABLE.has(t) && !usedSingles.has(t))
      ?? validTypes.find((t) => REPEATABLE.has(t));
    if (pick) onChange([...sources, makeDefaultSource(pick)]);
  };

  const updateSource = (i: number, entry: SegmentSourceEntry) =>
    onChange(sources.map((s, idx) => (idx === i ? entry : s)));

  const removeSource = (i: number) =>
    onChange(sources.filter((_, idx) => idx !== i));

  const usedSingles = new Set(sources.filter((s) => !REPEATABLE.has(s.type)).map((s) => s.type));
  const canAdd = validTypes.some((t) => REPEATABLE.has(t)) || validTypes.some((t) => !usedSingles.has(t));

  return (
    <div className="space-y-2">
      {sources.map((src, i) => {
        // Only block single-use types from being selected in other rows
        const usedByOthers = new Set(
          sources
            .filter((_, idx) => idx !== i)
            .filter((s) => !REPEATABLE.has(s.type))
            .map((s) => s.type),
        );
        return (
          <SourceRow
            key={i}
            source={src}
            validTypes={validTypes}
            usedTypes={usedByOthers}
            showWeight={showWeight}
            showRotationFlags={showWeight && src.type === 'playlist'}
            onChange={(entry) => updateSource(i, entry)}
            onRemove={() => removeSource(i)}
          />
        );
      })}
      {canAdd && (
        <button onClick={addSource} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          + Add source
        </button>
      )}
    </div>
  );
}

function SourceRow({
  source, validTypes, usedTypes, showWeight, showRotationFlags, onChange, onRemove,
}: {
  source: SegmentSourceEntry;
  validTypes: SegmentSourceEntry['type'][];
  usedTypes: Set<SegmentSourceEntry['type']>;
  showWeight: boolean;
  showRotationFlags: boolean;
  onChange: (entry: SegmentSourceEntry) => void;
  onRemove: () => void;
}) {
  const availableTypes = validTypes.filter((t) => t === source.type || !usedTypes.has(t));
  const hasTier = source.type === 'show_playlist';
  const isPlaylist = source.type === 'playlist';
  const hasWeight = showWeight && 'weight' in source;
  const playlistSrc = isPlaylist ? (source as PlaylistSource) : null;

  // Playlist entries use a structured multi-line layout for clarity
  if (isPlaylist && playlistSrc) {
    const weightVal = hasWeight ? (source as Extract<SegmentSourceEntry, { weight: number }>).weight : 1;
    return (
      <div className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
        {/* Header row: type selector + remove */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800/60">
          <select
            value={source.type}
            onChange={(e) => onChange(makeDefaultSource(e.target.value as SegmentSourceEntry['type']))}
            className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
          >
            {availableTypes.map((t) => (
              <option key={t} value={t} className="bg-zinc-900">{SOURCE_LABELS[t]}</option>
            ))}
          </select>
          <button
            onClick={onRemove}
            className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-red-900/20 flex-shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
        {/* Fields row: playlist ID + weight */}
        <div className="flex items-center gap-4 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Playlist ID</span>
            <input
              type="number"
              min={1}
              placeholder="—"
              value={playlistSrc.playlist_id || ''}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) onChange({ ...playlistSrc, playlist_id: v });
              }}
              className="w-16 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
            />
          </div>
          {showWeight && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-500">Weight</span>
              <input
                type="number"
                min={1}
                max={100}
                value={weightVal}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1) onChange({ ...playlistSrc, weight: v });
                }}
                className="w-12 px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
              />
            </div>
          )}
        </div>
        {/* Rotation flags row */}
        {showRotationFlags && (
          <div className="flex items-center gap-4 px-3 pb-2.5">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={playlistSrc.hot_play}
                onChange={(e) => onChange({ ...playlistSrc, hot_play: e.target.checked })}
                className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
              />
              <span className="text-xs text-zinc-300">Hot play</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={playlistSrc.heavy_rotation}
                onChange={(e) => onChange({ ...playlistSrc, heavy_rotation: e.target.checked })}
                className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
              />
              <span className="text-xs text-zinc-300">Heavy rotation</span>
            </label>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-zinc-900 rounded px-2 py-1.5">
      <select
        value={source.type}
        onChange={(e) => onChange(makeDefaultSource(e.target.value as SegmentSourceEntry['type']))}
        className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
      >
        {availableTypes.map((t) => (
          <option key={t} value={t} className="bg-zinc-900">{SOURCE_LABELS[t]}</option>
        ))}
      </select>

      {hasTier && (
        <input
          type="text"
          placeholder="tier"
          value={(source as Extract<SegmentSourceEntry, { type: 'show_playlist' }>).tier ?? ''}
          onChange={(e) => {
            const s = source as Extract<SegmentSourceEntry, { type: 'show_playlist' }>;
            onChange({ ...s, tier: e.target.value || undefined });
          }}
          className="w-20 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
        />
      )}

      {hasWeight && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500">Weight</span>
          <input
            type="number"
            min={1}
            max={100}
            value={(source as Extract<SegmentSourceEntry, { weight: number }>).weight}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1) {
                const s = source as Extract<SegmentSourceEntry, { weight: number }>;
                onChange({ ...s, weight: v });
              }
            }}
            className="w-12 px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
          />
        </div>
      )}

      <button
        onClick={onRemove}
        className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-red-900/20 flex-shrink-0"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-zinc-400 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

function PlaylistIdInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <input
      type="number"
      min={1}
      placeholder="Playlist ID (none)"
      value={value ?? ''}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10);
        onChange(isNaN(v) ? null : v);
      }}
      className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-500"
    />
  );
}
