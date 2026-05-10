import { useState } from 'react';
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
import { Plus, GripVertical, Trash2, Check, X, Clock } from 'lucide-react';
import {
  Clock as ClockType,
  ClockSegment,
  ClockSegmentType,
  SegmentSourceType,
  CLOCK_SEGMENT_TYPES,
  DelayPolicy,
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
  music:      { label: 'Music',      color: '#6366f1', bg: 'bg-indigo-500/15',  border: 'border-indigo-500/40',  text: 'text-indigo-300'  },
  commercial: { label: 'Commercial', color: '#f59e0b', bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-300'   },
  jingle:     { label: 'Jingle',     color: '#14b8a6', bg: 'bg-teal-500/15',    border: 'border-teal-500/40',    text: 'text-teal-300'    },
  news:       { label: 'News',       color: '#f43f5e', bg: 'bg-rose-500/15',    border: 'border-rose-500/40',    text: 'text-rose-300'    },
  live:       { label: 'Live',       color: '#10b981', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300' },
  promo:      { label: 'Promo',      color: '#8b5cf6', bg: 'bg-violet-500/15',  border: 'border-violet-500/40',  text: 'text-violet-300'  },
  silence:    { label: 'Silence',    color: '#71717a', bg: 'bg-zinc-500/10',    border: 'border-zinc-500/40',    text: 'text-zinc-400'    },
};

const SOURCE_LABELS: Record<SegmentSourceType, string> = {
  show_playlist: 'Show playlist',
  show_jingles:  'Show jingles',
  show_beds:     'Show beds',
  show_promos:   'Show promos',
  playlist:      'Playlist',
  campaigns:     'Campaigns',
  live:          'Live',
  recording:     'Recording',
};

// Valid source types per segment type
const VALID_SOURCES: Record<ClockSegmentType, SegmentSourceType[]> = {
  music:      ['show_playlist', 'playlist'],
  commercial: ['campaigns', 'show_promos', 'playlist'],
  jingle:     ['show_jingles', 'playlist'],
  promo:      ['show_promos', 'playlist'],
  news:       ['live', 'recording'],
  live:       ['live'],
  silence:    ['show_playlist'],
};

// Sensible defaults when adding/changing a segment type
const SOURCE_DEFAULT: Record<ClockSegmentType, SegmentSourceType> = {
  music:      'show_playlist',
  commercial: 'campaigns',
  jingle:     'show_jingles',
  promo:      'show_promos',
  news:       'live',
  live:       'live',
  silence:    'show_playlist',
};

const DURATION_DEFAULT: Record<ClockSegmentType, number> = {
  music:      480,  // 8 min
  commercial: 180,  // 3 min
  jingle:      30,
  promo:       60,
  news:       120,  // 2 min
  live:       600,  // 10 min
  silence:     30,
};

const DURATION_STEP: Record<ClockSegmentType, number> = {
  music:      30,
  commercial: 30,
  jingle:      5,
  promo:       5,
  news:       30,
  live:       60,
  silence:     5,
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

// ─── Draft type ───────────────────────────────────────────────────────────────
// Positive id = existing DB record. Negative = new, not yet persisted.

type SegmentDraft = Pick<
  ClockSegment,
  | 'id' | 'clock_id' | 'sort_order' | 'name' | 'type' | 'duration_seconds'
  | 'source_type' | 'blocks_live_override' | 'delay_policy' | 'recovery_tactics'
  | 'source_tier' | 'source_playlist_id' | 'source_rotation_id'
  | 'filler_sources' | 'mix_ratio' | 'fallback_source'
  | 'start_clip_playlist_id' | 'end_clip_playlist_id' | 'bed_playlist_id'
>;

let _tempId = -1;
function newTempId() { return _tempId--; }

function segmentFromType(clockId: number, type: ClockSegmentType, order: number): SegmentDraft {
  const blocksLive = ['commercial', 'jingle', 'promo'].includes(type);
  return {
    id: newTempId(),
    clock_id: clockId,
    sort_order: order,
    name: SEGMENT_META[type].label,
    type,
    duration_seconds: DURATION_DEFAULT[type],
    source_type: SOURCE_DEFAULT[type],
    source_tier: null,
    source_playlist_id: null,
    source_rotation_id: null,
    filler_sources: [],
    mix_ratio: null,
    fallback_source: null,
    start_clip_playlist_id: null,
    end_clip_playlist_id: null,
    bed_playlist_id: null,
    blocks_live_override: blocksLive,
    delay_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 },
    recovery_tactics: type === 'music' ? ['trim_outro', 'skip_song', 'drop_queued'] : [],
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
  };

  // When the loaded segments arrive for a newly selected clock, sync them into draft
  const handleClockClick = (clock: ClockType) => {
    if (clock.id === selectedId) return;
    const segs = queryClient.getQueryData<ClockSegment[]>(['clock-segments', clock.id]) ?? [];
    selectClock(clock, segs);
  };

  // Once segments load for the selected clock, push them into draft (only if not dirty)
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
  };

  const deleteSeg = (id: number) => {
    setDraftSegs((prev) => prev.filter((s) => s.id !== id));
    setSegsDirty(true);
  };

  const reorderSegs = (oldIndex: number, newIndex: number) => {
    setDraftSegs((prev) => arrayMove(prev, oldIndex, newIndex));
    setSegsDirty(true);
  };

  const changeSegType = (id: number, newType: ClockSegmentType) => {
    const validSources = VALID_SOURCES[newType];
    setDraftSegs((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      const source_type = validSources.includes(s.source_type) ? s.source_type : SOURCE_DEFAULT[newType];
      return {
        ...s,
        type: newType,
        source_type,
        blocks_live_override: ['commercial', 'jingle', 'promo'].includes(newType),
        recovery_tactics: newType === 'music' ? ['trim_outro', 'skip_song', 'drop_queued'] : [],
        duration_seconds: s.duration_seconds === DURATION_DEFAULT[s.type]
          ? DURATION_DEFAULT[newType]
          : s.duration_seconds,
      };
    }));
    setSegsDirty(true);
  };

  const total = totalSeconds(draftSegs);
  const overflow = total > 3600;

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
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
            <button
              onClick={() => setCreatingNew(true)}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
              title="New clock"
            >
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
              <button
                onClick={() => newName.trim() && createMutation.mutate({ name: newName.trim() })}
                className="p-1 text-indigo-400 hover:text-indigo-300 transition-colors"
              >
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
                <button
                  key={clock.id}
                  onClick={() => handleClockClick(clock)}
                  className={`w-full text-left px-4 py-3 border-b border-zinc-800/60 transition-colors ${
                    isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'
                  }`}
                >
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
                    <button onClick={handleDiscard} className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">
                      Discard
                    </button>
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
                      <button
                        key={type}
                        onClick={() => addSeg(type)}
                        className={`px-2.5 py-1 text-xs rounded border transition-colors ${meta.bg} ${meta.border} ${meta.text} hover:brightness-125`}
                      >
                        + {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                <SegmentList
                  segments={draftSegs}
                  onReorder={reorderSegs}
                  onUpdate={updateSeg}
                  onDelete={deleteSeg}
                  onChangeType={changeSegType}
                />
                {draftSegs.length === 0 && (
                  <div className="px-5 py-10 text-center text-zinc-400 text-sm">
                    No segments yet — use the buttons above to add music, commercials, jingles, and more.
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

// ─── Timeline visualization ───────────────────────────────────────────────────

function ClockTimeline({ segments, total, overflow }: { segments: SegmentDraft[]; total: number; overflow: boolean }) {
  const cap = Math.max(total, 3600);
  return (
    <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Hour overview</span>
        <span className="text-xs text-zinc-400 font-mono">60 min</span>
      </div>
      <div className="relative h-10 flex rounded overflow-hidden bg-zinc-800">
        {segments.map((seg) => {
          const meta = SEGMENT_META[seg.type];
          const widthPct = (seg.duration_seconds / cap) * 100;
          return (
            <div
              key={seg.id}
              className="flex items-center justify-center overflow-hidden transition-all duration-150 border-r border-zinc-900/50 last:border-r-0"
              style={{ width: `${widthPct}%`, backgroundColor: meta.color + '33' }}
              title={`${seg.name} · ${fmtDuration(seg.duration_seconds)}`}
            >
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

// ─── Sortable segment list ────────────────────────────────────────────────────

function SegmentList({
  segments, onReorder, onUpdate, onDelete, onChangeType,
}: {
  segments: SegmentDraft[];
  onReorder: (oldIndex: number, newIndex: number) => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = segments.findIndex((s) => s.id === active.id);
    const newIndex = segments.findIndex((s) => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) onReorder(oldIndex, newIndex);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={segments.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800">
            <tr>
              <th className="w-8" />
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider w-28">Type</th>
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider">Name</th>
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider w-36">Source</th>
              <th className="py-2 px-4 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider w-28">Delay</th>
              <th className="py-2 px-4 text-right text-xs font-medium text-zinc-400 uppercase tracking-wider w-36">Duration</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {segments.map((seg) => (
              <SortableSegmentRow
                key={seg.id}
                segment={seg}
                onUpdate={onUpdate}
                onDelete={onDelete}
                onChangeType={onChangeType}
              />
            ))}
          </tbody>
        </table>
      </SortableContext>
    </DndContext>
  );
}

// ─── Segment row ──────────────────────────────────────────────────────────────

const DELAY_LABELS: Record<DelayPolicy['type'], string> = {
  hard:     'Hard',
  soft:     'Soft',
  postpone: 'Postpone',
};

function SortableSegmentRow({
  segment, onUpdate, onDelete, onChangeType,
}: {
  segment: SegmentDraft;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segment.id });
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(segment.name);
  const meta = SEGMENT_META[segment.type];
  const validSources = VALID_SOURCES[segment.type];
  const step = DURATION_STEP[segment.type];

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const commitName = () => {
    onUpdate(segment.id, { name: nameValue.trim() || SEGMENT_META[segment.type].label });
    setEditingName(false);
  };

  const cycleDelay = () => {
    const order: DelayPolicy['type'][] = ['soft', 'hard', 'postpone'];
    const next = order[(order.indexOf(segment.delay_policy.type) + 1) % order.length];
    const policy: DelayPolicy =
      next === 'hard'     ? { type: 'hard' } :
      next === 'soft'     ? { type: 'soft', plus_seconds: 30, minus_seconds: 0 } :
                            { type: 'postpone', max_plus_seconds: 120, minus_seconds: 0 };
    onUpdate(segment.id, { delay_policy: policy });
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-zinc-800/60 hover:bg-zinc-800/30 group">
      {/* Drag handle */}
      <td className="pl-3 pr-1 py-2.5 w-8">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-zinc-500 hover:text-zinc-200 transition-colors touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      </td>

      {/* Type */}
      <td className="px-4 py-2.5 w-28">
        <select
          value={segment.type}
          onChange={(e) => onChangeType(segment.id, e.target.value as ClockSegmentType)}
          className={`text-xs px-2 py-1 rounded border bg-transparent cursor-pointer focus:outline-none ${meta.border} ${meta.text}`}
        >
          {CLOCK_SEGMENT_TYPES.map((t) => (
            <option key={t} value={t} className="bg-zinc-900 text-white">{SEGMENT_META[t].label}</option>
          ))}
        </select>
      </td>

      {/* Name */}
      <td className="px-4 py-2.5">
        {editingName ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-sm text-white focus:outline-none focus:border-indigo-500"
          />
        ) : (
          <button
            onClick={() => { setNameValue(segment.name); setEditingName(true); }}
            className="text-sm text-left w-full text-zinc-200 hover:text-white"
          >
            {segment.name}
          </button>
        )}
      </td>

      {/* Source type */}
      <td className="px-4 py-2.5 w-36">
        {segment.type === 'silence' ? (
          <span className="text-xs text-zinc-500 italic">—</span>
        ) : (
          <select
            value={segment.source_type}
            onChange={(e) => onUpdate(segment.id, { source_type: e.target.value as SegmentSourceType })}
            className="text-xs px-2 py-1 rounded border border-zinc-700 bg-zinc-800 text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500 w-full"
          >
            {validSources.map((s) => (
              <option key={s} value={s} className="bg-zinc-900">{SOURCE_LABELS[s]}</option>
            ))}
          </select>
        )}
      </td>

      {/* Delay policy */}
      <td className="px-4 py-2.5 w-28">
        <button
          onClick={cycleDelay}
          title="Click to cycle: soft → hard → postpone"
          className={`text-xs px-2 py-0.5 rounded border transition-colors ${
            segment.delay_policy.type === 'hard'
              ? 'bg-red-900/20 border-red-800/50 text-red-400'
              : segment.delay_policy.type === 'postpone'
              ? 'bg-amber-900/20 border-amber-800/50 text-amber-400'
              : 'bg-zinc-800 border-zinc-700 text-zinc-400'
          }`}
        >
          {DELAY_LABELS[segment.delay_policy.type]}
        </button>
      </td>

      {/* Duration */}
      <td className="px-4 py-2.5 text-right w-36">
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={() => onUpdate(segment.id, { duration_seconds: Math.max(step, segment.duration_seconds - step) })}
            className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-xs font-bold"
          >−</button>
          <input
            type="number"
            min={1}
            max={7200}
            value={segment.duration_seconds}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 1 && v <= 7200) onUpdate(segment.id, { duration_seconds: v });
            }}
            className="w-14 text-center bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 py-0.5"
          />
          <button
            onClick={() => onUpdate(segment.id, { duration_seconds: Math.min(7200, segment.duration_seconds + step) })}
            className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors text-xs font-bold"
          >+</button>
          <span className="text-xs text-zinc-400 w-10 text-left">{fmtDuration(segment.duration_seconds)}</span>
        </div>
      </td>

      {/* Delete */}
      <td className="pr-3 py-2.5 w-10">
        <button
          onClick={() => onDelete(segment.id)}
          className="p-1 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  );
}
