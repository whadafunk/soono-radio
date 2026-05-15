import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
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
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus, GripVertical, Trash2, Check, X, Clock,
  ChevronDown, ChevronRight, Radio,
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
  SegmentSweeperConfig,
  SweepSourceEntry,
  SWEEP_SOURCES,
  SIMPLE_ROTATION_TYPES,
  SimpleRotationType,
  FINISH_POLICIES,
  JOIN_POLICIES,
  OVERRUN_POLICIES,
  FinishPolicy,
  JoinPolicy,
  OverrunPolicy,
  Rotation,
  Show,
} from '@radio/shared';
import {
  fetchClocks,
  fetchClockSegments,
  createClock,
  updateClock,
  deleteClock,
  replaceClockSegments,
  fetchPlaylists,
  fetchShows,
  fetchRotations,
  fetchSupervisorConfig,
} from '../../api';
import type { PlaylistSummary } from '../../api';

// ─── Handover / sweep labels ──────────────────────────────────────────────────

const FINISH_POLICY_LABELS: Record<FinishPolicy, { label: string; desc: string }> = {
  hard_cut:        { label: 'Hard cut',        desc: 'Cut the active segment immediately when a hard-start successor arrives.' },
  finish_segment:  { label: 'Finish segment',  desc: 'Let the active segment finish naturally before handing over (may overrun by minutes).' },
};

const JOIN_POLICY_LABELS: Record<JoinPolicy, { label: string; desc: string }> = {
  join_top:  { label: 'Join at top',  desc: 'Always start the clock at segment 1, regardless of when the slot begins.' },
  join_mid:  { label: 'Join mid',     desc: 'Skip ahead to the segment that would be playing at the current wall-clock minute. Preserves break-time alignment.' },
};

const OVERRUN_POLICY_LABELS: Record<OverrunPolicy, { label: string; desc: string }> = {
  loop_top:      { label: 'Loop from top',  desc: 'Restart the clock at segment 1 if the show outlives its clock.' },
  loop_mid:      { label: 'Loop at mid',    desc: 'Resume at the segment matching the wall-clock minute. Maintains alignment.' },
  fall_through:  { label: 'Fall through',   desc: 'No clock structure beyond the first pass — keep playing the show\'s content sources.' },
};

const SWEEP_SOURCE_LABELS: Record<typeof SWEEP_SOURCES[number], string> = {
  commercial:  'Campaigns',
  promo:       'Promo',
  station_id:  'Station ID',
  jingle:      'Jingle',
};

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
  live:          ['live', 'show_beds', 'playlist'],
  live_audience: ['live', 'show_beds', 'playlist'],
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

const DEFAULT_MUSIC_SWEEPER_CONFIG: SegmentSweeperConfig = {
  per_hour: 3,
  min_gap_minutes: 8,
  sources: [
    { type: 'commercial', weight: 2, rotation_id: null },
    { type: 'promo',      weight: 1, rotation_id: null },
    { type: 'station_id', weight: 1, rotation_id: null },
    { type: 'jingle',     weight: 1, rotation_id: null },
  ],
};

const DEFAULT_LIVE_SWEEPER_CONFIG: SegmentSweeperConfig = {
  per_hour: 1,
  min_gap_minutes: 15,
  sources: [
    { type: 'station_id', weight: 1, rotation_id: null },
    { type: 'jingle',     weight: 1, rotation_id: null },
  ],
};

const TYPE_DEFAULTS: Record<ClockSegmentType, {
  sources: SegmentSourceEntry[];
  start_policy: StartPolicy;
  trailing_time: TrailingTimeStrategy[];
  accept_live: boolean;
  sweeper_config: SegmentSweeperConfig | null;
  recovery_tactics: RecoveryTactic[];
}> = {
  music:         { sources: [{ type: 'show_playlist', weight: 1 }],                start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: ['skip_events', 'fill', 'early_handover'], accept_live: true,  sweeper_config: DEFAULT_MUSIC_SWEEPER_CONFIG, recovery_tactics: ['trim_outro', 'skip_song', 'drop_queued'] },
  live:          { sources: [{ type: 'live' }],                                     start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: [],                                         accept_live: true,  sweeper_config: DEFAULT_LIVE_SWEEPER_CONFIG,  recovery_tactics: [] },
  live_audience: { sources: [{ type: 'live' }],                                     start_policy: { type: 'soft', plus_seconds: 30, minus_seconds: 0 }, trailing_time: [],                                         accept_live: true,  sweeper_config: DEFAULT_LIVE_SWEEPER_CONFIG,  recovery_tactics: [] },
  stop_set:      { sources: [{ type: 'campaigns' }, { type: 'promos', weight: 1 }], start_policy: { type: 'hard' },                                    trailing_time: ['skip_events', 'fill'],                     accept_live: false, sweeper_config: null,                         recovery_tactics: [] },
  news:          { sources: [{ type: 'live' }],                                     start_policy: { type: 'hard' },                                    trailing_time: ['skip_events', 'fill'],                     accept_live: true,  sweeper_config: null,                         recovery_tactics: [] },
  voice_track:   { sources: [],                                                      start_policy: { type: 'hard' },                                    trailing_time: [],                                         accept_live: false, sweeper_config: null,                         recovery_tactics: [] },
  bulletin:      { sources: [{ type: 'live' }],                                     start_policy: { type: 'hard' },                                    trailing_time: [],                                         accept_live: true,  sweeper_config: null,                         recovery_tactics: [] },
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
    case 'playlist':      return { type, playlist_id: 0, weight: 1, hot_play: false, heavy_rotation: false };
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
    accept_sweepers: [],
    sweeper_config: d.sweeper_config,
    silence_detection_action: null,
    rotation_type: null,
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ClocksPage() {
  const queryClient = useQueryClient();
  const { id: urlId } = useParams<{ id?: string }>();
  const autoSelectedRef = useRef(false);
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
  const [headerOpen, setHeaderOpen] = useState(true);
  const [listConfirmDeleteId, setListConfirmDeleteId] = useState<number | null>(null);

  const dirty = clockDirty || segsDirty;

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });
  const { data: allPlaylists = [] } = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const { data: allShows = [] } = useQuery({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: allRotations = [] } = useQuery({ queryKey: ['rotations'], queryFn: fetchRotations });
  const { data: supervisorConfig } = useQuery({ queryKey: ['supervisor-config'], queryFn: fetchSupervisorConfig });

  const musicRotations = allRotations.filter((r) => (r.kind ?? 'music') === 'music');
  const sweeperRotations = allRotations.filter((r) => r.kind === 'sweeper');

  const { data: loadedSegments = [] } = useQuery({
    queryKey: ['clock-segments', selectedId],
    queryFn: () => fetchClockSegments(selectedId!),
    enabled: selectedId !== null,
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Save-time validation: unassigned clocks need a playlist source on every music segment.
      // Backend enforces the same rule; we surface it here for a faster, clearer UX.
      if (draftClock && draftClock.show_id === null) {
        const offending = draftSegs
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => s.type === 'music' && !s.sources.some(
            (src) => src.type === 'playlist' && (src as Extract<typeof src, { type: 'playlist' }>).playlist_id > 0,
          ));
        if (offending.length > 0) {
          throw new Error(
            `Unassigned clock requires a specific playlist source (with a playlist selected) on every music segment (segment${
              offending.length > 1 ? 's' : ''
            } #${offending.map(({ i }) => i + 1).join(', #')})`,
          );
        }
      }
      const promises: Promise<unknown>[] = [];
      if (clockDirty && draftClock)
        promises.push(updateClock(draftClock.id, {
          name: draftClock.name,
          description: draftClock.description,
          show_id: draftClock.show_id,
          station_id_playlist_id: draftClock.station_id_playlist_id,
          jingle_playlist_id: draftClock.jingle_playlist_id,
          finish_policy: draftClock.finish_policy,
          join_policy: draftClock.join_policy,
          overrun_policy: draftClock.overrun_policy,
        }));
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
      setListConfirmDeleteId(null);
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

  // Auto-select the clock from the URL param (e.g. navigated from schedule page)
  useEffect(() => {
    if (!urlId || autoSelectedRef.current || clocks.length === 0) return;
    const target = clocks.find((c) => c.id === Number(urlId));
    if (!target) return;
    autoSelectedRef.current = true;
    const segs = queryClient.getQueryData<ClockSegment[]>(['clock-segments', target.id]) ?? [];
    selectClock(target, segs);
  }, [urlId, clocks]); // eslint-disable-line react-hooks/exhaustive-deps

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
        accept_sweepers: [],
        sweeper_config: d.sweeper_config,
        recovery_tactics: d.recovery_tactics,
      };
    }));
    setSegsDirty(true);
  };

  const total = totalSeconds(draftSegs);
  const overflow = total > 3600;

  return (
    <div className="h-full flex flex-col gap-4">
      {toast && (
        <div className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm ${toast.type === 'success' ? 'bg-green-900/20 border border-green-800 text-green-300' : 'bg-red-900/20 border border-red-800 text-red-300'}`}>
          {toast.message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: clock list */}
        <div className="w-64 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-4 border-b border-zinc-700 bg-zinc-800/50 flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Clocks</span>
            <button onClick={() => setCreatingNew(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md transition-colors">
              <Plus className="w-3.5 h-3.5" />
              New Clock
            </button>
          </div>

          {creatingNew && (
            <div className="px-3 py-2 border-b border-zinc-800 flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim() && !createMutation.isPending) createMutation.mutate({ name: newName.trim() });
                  if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
                }}
                placeholder="Clock name…"
                className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => newName.trim() && !createMutation.isPending && createMutation.mutate({ name: newName.trim() })}
                disabled={!newName.trim() || createMutation.isPending}
                className="p-1 text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-40 disabled:cursor-default"
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
              const assignedShow = clock.show_id != null ? allShows.find((s) => s.id === clock.show_id) : null;
              const confirmingDelete = listConfirmDeleteId === clock.id;
              return (
                <div key={clock.id} className={`group relative border-b border-zinc-800/60 transition-colors ${isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'}`}>
                  <button onClick={() => handleClockClick(clock)} className="w-full text-left px-4 py-3">
                    <div className="flex items-center gap-2 pr-6">
                      <Clock className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-white truncate">{clock.name}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1 ml-5 items-center">
                      <span className={`text-[10px] px-1 py-0.5 rounded ${clock.used ? 'bg-emerald-900/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}>
                        {clock.used ? 'Used' : 'Not used'}
                      </span>
                      <span className="text-[10px] text-zinc-500 truncate">
                        {assignedShow ? assignedShow.name : 'Unassigned'}
                      </span>
                      <span className="basis-full" />
                      <span className={`text-xs ${secs > 3600 ? 'text-red-400' : 'text-zinc-400'}`}>{fmtDuration(secs)}</span>
                      <span className="text-xs text-zinc-400">· {segs.length} seg</span>
                    </div>
                  </button>
                  {confirmingDelete ? (
                    <div className="px-4 pb-3 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <span className="text-xs text-zinc-400 flex-1">Delete?</span>
                      <button
                        onClick={() => deleteMutation.mutate(clock.id)}
                        disabled={deleteMutation.isPending}
                        className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors disabled:opacity-50"
                      >Yes</button>
                      <button
                        onClick={() => setListConfirmDeleteId(null)}
                        className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                      >Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); setListConfirmDeleteId(clock.id); }}
                      className="absolute top-2.5 right-2.5 p-1 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete clock"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: editor */}
        {draftClock ? (
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Clock header — collapsible */}
            <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">

              {/* Collapsed bar */}
              {!headerOpen && (
                <div className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => setHeaderOpen(true)} className="flex-shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors">
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                  <input
                    value={draftClock.name}
                    onChange={(e) => updateDraftClock((c) => ({ ...c, name: e.target.value }))}
                    className="flex-1 min-w-0 text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none transition-colors pb-0.5"
                  />
                  <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded ${draftClock.used ? 'bg-emerald-900/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}>
                    {draftClock.used ? 'Used in schedule' : 'Not used'}
                  </span>
                  <ClockActions dirty={dirty} isPending={saveMutation.isPending} confirmDelete={confirmDelete}
                    onSave={() => saveMutation.mutate()} onDiscard={handleDiscard}
                    onDeleteRequest={() => setConfirmDelete(true)} onDeleteConfirm={() => deleteMutation.mutate(draftClock.id)}
                    onDeleteCancel={() => setConfirmDelete(false)} row
                  />
                </div>
              )}

              {/* Expanded: two-panel */}
              {headerOpen && (
                <div className="flex items-stretch">
                  {/* Left: identity + handover */}
                  <div className="flex-1 min-w-0 px-5 py-4 space-y-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <button type="button" onClick={() => setHeaderOpen(false)} className="flex-shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors">
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <input
                          value={draftClock.name}
                          onChange={(e) => updateDraftClock((c) => ({ ...c, name: e.target.value }))}
                          className="flex-1 min-w-0 text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none transition-colors pb-0.5"
                        />
                      </div>
                      <input
                        value={draftClock.description ?? ''}
                        onChange={(e) => updateDraftClock((c) => ({ ...c, description: e.target.value || null }))}
                        placeholder="Add a description…"
                        className="mt-2 ml-5 text-sm text-zinc-400 bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-[calc(100%-1.25rem)] transition-colors pb-0.5 placeholder:text-zinc-600"
                      />
                    </div>

                    {/* Handover */}
                    <div className="space-y-3">
                      <p className="text-xs font-medium text-zinc-400">Handover</p>
                      {(
                        [
                          { key: 'finish_policy',  label: 'Finish policy',  options: FINISH_POLICIES,  def: supervisorConfig?.finish_policy  ?? 'finish_segment', labelsMap: FINISH_POLICY_LABELS  },
                          { key: 'join_policy',    label: 'Join policy',    options: JOIN_POLICIES,    def: supervisorConfig?.join_policy    ?? 'join_top',        labelsMap: JOIN_POLICY_LABELS    },
                          { key: 'overrun_policy', label: 'Overrun policy', options: OVERRUN_POLICIES, def: supervisorConfig?.overrun_policy ?? 'loop_top',        labelsMap: OVERRUN_POLICY_LABELS },
                        ] as const
                      ).map(({ key, label, options, def, labelsMap }) => {
                        const lm = labelsMap as Record<string, { label: string; desc: string }>;
                        return (
                          <div key={key}>
                            <p className="text-xs text-zinc-400 mb-1">{label}</p>
                            <select
                              value={(draftClock[key as keyof ClockType] as string | null) ?? ''}
                              onChange={(e) => updateDraftClock((c) => ({ ...c, [key]: e.target.value === '' ? null : e.target.value }))}
                              className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 focus:outline-none focus:border-indigo-500"
                            >
                              <option value="" className="bg-zinc-900 text-zinc-400">Station default — {lm[def].label}</option>
                              {options.map((o) => (
                                <option key={o} value={o} className="bg-zinc-900">{lm[o].label}</option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="w-px bg-zinc-800 flex-shrink-0" />

                  {/* Right: show + playlists */}
                  <div className="flex-shrink-0 w-56 px-5 py-4 space-y-4">
                    {/* Show */}
                    <div>
                      <p className="text-xs font-medium text-zinc-400 mb-1">Show</p>
                      <select
                        value={draftClock.show_id ?? ''}
                        onChange={(e) => updateDraftClock((c) => ({ ...c, show_id: e.target.value === '' ? null : Number(e.target.value) }))}
                        className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="" className="bg-zinc-900">Unassigned</option>
                        {allShows.map((s) => (
                          <option key={s.id} value={s.id} className="bg-zinc-900">{s.name}</option>
                        ))}
                      </select>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className={`text-xs px-2 py-0.5 rounded ${draftClock.used ? 'bg-emerald-900/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}>
                          {draftClock.used ? 'Used in schedule' : 'Not used'}
                        </span>
                        {draftClock.show_id === null && (
                          <span className="text-xs text-amber-400">Segments need explicit playlist sources</span>
                        )}
                      </div>
                    </div>

                    {/* Playlists */}
                    <div className="space-y-3">
                      <p className="text-xs font-medium text-zinc-400">Playlists</p>
                      <div>
                        <p className="text-xs text-zinc-400 mb-1">Station ID</p>
                        <PlaylistDropdown
                          value={draftClock.station_id_playlist_id ?? null}
                          onChange={(id) => updateDraftClock((c) => ({ ...c, station_id_playlist_id: id }))}
                          playlists={allPlaylists}
                          categories={['jingle']}
                        />
                      </div>
                      {draftClock.show_id === null && (
                        <div>
                          <p className="text-xs text-zinc-400 mb-1">Jingle</p>
                          <PlaylistDropdown
                            value={draftClock.jingle_playlist_id ?? null}
                            onChange={(id) => updateDraftClock((c) => ({ ...c, jingle_playlist_id: id }))}
                            playlists={allPlaylists}
                            categories={['jingle']}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Divider */}
                  <div className="w-px bg-zinc-800 flex-shrink-0" />

                  {/* Actions */}
                  <div className="flex-shrink-0 px-3 py-4 flex flex-col items-center justify-center gap-2">
                    <ClockActions dirty={dirty} isPending={saveMutation.isPending} confirmDelete={confirmDelete}
                      onSave={() => saveMutation.mutate()} onDiscard={handleDiscard}
                      onDeleteRequest={() => setConfirmDelete(true)} onDeleteConfirm={() => deleteMutation.mutate(draftClock.id)}
                      onDeleteCancel={() => setConfirmDelete(false)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Timeline */}
            <ClockTimeline
              segments={draftSegs}
              total={total}
              overflow={overflow}
              expandedId={expandedId}
              onExpandToggle={(id) => setExpandedId((prev) => prev === id ? null : id)}
              onReorder={reorderSegs}
            />

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
                  playlists={allPlaylists}
                  musicRotations={musicRotations}
                  sweeperRotations={sweeperRotations}
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

function SortableTimelineItem({
  seg, cap, isActive, isDraggingAny, onExpandToggle,
}: {
  seg: SegmentDraft;
  cap: number;
  isActive: boolean;
  isDraggingAny: boolean;
  onExpandToggle: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: seg.id });
  const meta = SEGMENT_META[seg.type];
  const widthPct = (seg.duration_seconds / cap) * 100;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={isDraggingAny ? undefined : () => onExpandToggle(seg.id)}
      className={`flex items-center justify-center overflow-hidden border-r border-zinc-900/50 last:border-r-0 cursor-pointer transition-colors ${isDragging ? 'opacity-50' : ''} ${!isActive && !isDragging ? 'hover:brightness-125' : ''}`}
      style={{
        width: `${widthPct}%`,
        flexShrink: 0,
        backgroundColor: meta.color + (isActive ? '55' : '33'),
        transform: CSS.Transform.toString(transform),
        transition,
        position: 'relative',
        zIndex: isDragging ? 10 : undefined,
        outline: isActive ? '2px solid rgba(255,255,255,0.7)' : undefined,
        outlineOffset: isActive ? '-2px' : undefined,
      }}
      title={`${seg.name} · ${fmtDuration(seg.duration_seconds)}`}
    >
      {seg.duration_seconds >= 240 && (
        <span className="text-xs font-medium truncate px-1 pointer-events-none select-none" style={{ color: meta.color }}>
          {seg.name}
        </span>
      )}
    </div>
  );
}

function ClockTimeline({
  segments, total, overflow, expandedId, onExpandToggle, onReorder,
}: {
  segments: SegmentDraft[];
  total: number;
  overflow: boolean;
  expandedId: number | null;
  onExpandToggle: (id: number) => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
}) {
  const cap = Math.max(total, 3600);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [timelineDragging, setTimelineDragging] = useState(false);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setTimeout(() => setTimelineDragging(false), 0);
    if (!over || active.id === over.id) return;
    const oldIndex = segments.findIndex(s => s.id === active.id);
    const newIndex = segments.findIndex(s => s.id === over.id);
    if (oldIndex !== -1 && newIndex !== -1) onReorder(oldIndex, newIndex);
  };

  return (
    <div className="flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Hour overview</span>
        <span className="text-xs text-zinc-400 font-mono">60 min</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => setTimelineDragging(true)}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setTimeout(() => setTimelineDragging(false), 0)}
      >
        <SortableContext items={segments.map(s => s.id)} strategy={horizontalListSortingStrategy}>
          <div className="relative h-12 flex rounded overflow-hidden bg-zinc-800">
            {segments.map((seg) => (
              <SortableTimelineItem
                key={seg.id}
                seg={seg}
                cap={cap}
                isActive={expandedId === seg.id}
                isDraggingAny={timelineDragging}
                onExpandToggle={onExpandToggle}
              />
            ))}
            {total < 3600 && (
              <div
                className="flex items-center justify-center pointer-events-none"
                style={{ width: `${((3600 - total) / 3600) * 100}%` }}
              >
                <span className="text-xs text-zinc-400">{fmtDuration(3600 - total)} free</span>
              </div>
            )}
          </div>
        </SortableContext>
      </DndContext>
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
  segments, expandedId, onExpandToggle, onDragStart, onReorder, onUpdate, onDelete, onChangeType, playlists, musicRotations, sweeperRotations,
}: {
  segments: SegmentDraft[];
  expandedId: number | null;
  onExpandToggle: (id: number) => void;
  onDragStart: () => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
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
              playlists={playlists}
              musicRotations={musicRotations}
              sweeperRotations={sweeperRotations}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ─── Sortable segment item ────────────────────────────────────────────────────

function SortableSegmentItem({
  segment, isExpanded, onExpand, onUpdate, onDelete, onChangeType, playlists, musicRotations, sweeperRotations,
}: {
  segment: SegmentDraft;
  isExpanded: boolean;
  onExpand: () => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
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

        <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded ${segment.start_policy.type === 'hard' ? 'bg-red-900/20 text-red-400' : 'bg-green-900/20 text-green-400'}`}>
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
            playlists={playlists}
            musicRotations={musicRotations}
            sweeperRotations={sweeperRotations}
          />
        )}
      </div>
    </div>
  );
}

// ─── Segment drawer ───────────────────────────────────────────────────────────

type DrawerTab = 'content' | 'timing' | 'transitions' | 'live';

function SegmentDrawer({
  segment, onApply, onChangeType, playlists, musicRotations, sweeperRotations,
}: {
  segment: SegmentDraft;
  onApply: (patch: Partial<SegmentDraft>) => void;
  onChangeType: (type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const [draft, setDraft] = useState<SegmentDraft>({ ...segment });
  const [applied, setApplied] = useState(false);

  const drawerDirty = JSON.stringify(draft) !== JSON.stringify(segment);

  const update = (patch: Partial<SegmentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const handleApply = () => {
    onApply(draft);
    setApplied(true);
    setTimeout(() => setApplied(false), 1500);
  };

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
                    accept_sweepers: [],
                    sweeper_config: d.sweeper_config,
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
                playlists={playlists}
              />
            </div>

            {/* Music rotation — one rotation document for ALL playlists in this segment collectively.
                Shown at segment level; the rotation_id is written to every playlist source on change. */}
            {draft.type === 'music' && draft.sources.some((s) => s.type === 'playlist') && (
              musicRotations.length > 0 ? (
                <Field label="Music rotation">
                  <select
                    value={(() => {
                      const pl = draft.sources.find((s) => s.type === 'playlist') as Extract<SegmentSourceEntry, { type: 'playlist' }> | undefined;
                      return pl?.rotation_id ?? musicRotations[0]?.id ?? '';
                    })()}
                    onChange={(e) => {
                      const rid = e.target.value === '' ? null : Number(e.target.value);
                      update({
                        sources: draft.sources.map((s) =>
                          s.type === 'playlist' ? { ...s, rotation_id: rid } : s
                        ),
                      });
                    }}
                    className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
                  >
                    {musicRotations.map((r) => (
                      <option key={r.id} value={r.id} className="bg-zinc-900">{r.name}{r.is_default ? ' (default)' : ''}</option>
                    ))}
                  </select>
                </Field>
              ) : (
                <p className="text-xs text-zinc-500">
                  No rotation documents —{' '}
                  <Link to="/rotations" className="text-indigo-400 hover:text-indigo-300 underline-offset-2 hover:underline">
                    create one in Rotations
                  </Link>{' '}
                  to control play order.
                </p>
              )
            )}

            {/* Live segments: bed rotation visible when at least one bed source (show_beds or playlist) is
                present. This rotates across ALL bed sources collectively — it is not per-playlist.
                Stop-set rotation lives per slot inside SourcesEditor; no segment-level rotation here. */}
            {(draft.type === 'live' || draft.type === 'live_audience') &&
              draft.sources.some((s) => s.type !== 'live') && (
                <Field label="Bed rotation">
                  <select
                    value={draft.rotation_type ?? ''}
                    onChange={(e) => update({ rotation_type: e.target.value === '' ? null : e.target.value as SimpleRotationType })}
                    className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
                  >
                    <option value="" className="bg-zinc-900">Default</option>
                    {SIMPLE_ROTATION_TYPES.map((t) => (
                      <option key={t} value={t} className="bg-zinc-900">{t === 'round_robin' ? 'Round robin' : 'Random'}</option>
                    ))}
                  </select>
                </Field>
              )}
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
              <PlaylistDropdown value={draft.start_clip_playlist_id} onChange={(v) => update({ start_clip_playlist_id: v })} playlists={playlists} categories={['jingle', 'promo']} />
            </Field>
            <Field label="End clip playlist" hint="Plays after segment content">
              <PlaylistDropdown value={draft.end_clip_playlist_id} onChange={(v) => update({ end_clip_playlist_id: v })} playlists={playlists} categories={['jingle', 'promo']} />
            </Field>
            {isLive && (
              <Field label="Bed playlist" hint="Background audio under harbor input">
                <PlaylistDropdown value={draft.bed_playlist_id} onChange={(v) => update({ bed_playlist_id: v })} playlists={playlists} categories={['bed']} />
              </Field>
            )}
            <Field label="Filler playlist" hint="Short content to fill gaps from look-ahead scheduling">
              <PlaylistDropdown value={draft.filler_playlist_id} onChange={(v) => update({ filler_playlist_id: v })} playlists={playlists} categories={['jingle', 'promo']} />
            </Field>

            {draft.type === 'music' && (
              <div className="col-span-2 border-t border-zinc-800 pt-4 mt-1">
                <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Between-track jingles</p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Jingle playlist" hint="Short station IDs or show jingles inserted between tracks">
                    <PlaylistDropdown
                      value={draft.interstitial_jingle_playlist_id}
                      onChange={(v) => update({ interstitial_jingle_playlist_id: v })}
                      playlists={playlists}
                      categories={['jingle']}
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
              <div className="col-span-2">
                <SegmentSweeperEditor
                  config={draft.sweeper_config ?? null}
                  sweeperRotations={sweeperRotations}
                  onChange={(c) => update({ sweeper_config: c })}
                />
              </div>
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

      <div className="flex justify-end items-center gap-3 px-5 pb-4">
        {drawerDirty && !applied && (
          <span className="text-xs text-amber-400">Unapplied changes</span>
        )}
        <button
          onClick={handleApply}
          disabled={!drawerDirty}
          className={`px-4 py-1.5 text-xs rounded-lg transition-all duration-200 ${
            applied
              ? 'bg-green-600 text-white'
              : drawerDirty
              ? 'bg-indigo-600 hover:bg-indigo-700 text-white'
              : 'bg-zinc-800 text-zinc-500 cursor-default'
          }`}
        >
          {applied ? '✓ Applied' : 'Apply'}
        </button>
      </div>
    </div>
  );
}

// ─── Sources editor ───────────────────────────────────────────────────────────

const IMPLICIT_LIVE_TYPES: ClockSegmentType[] = ['bulletin'];

type PlaylistSource = Extract<SegmentSourceEntry, { type: 'playlist' }>;

function playlistCategoriesForSegType(segType: ClockSegmentType): string[] {
  if (segType === 'music') return ['music'];
  if (segType === 'live' || segType === 'live_audience') return ['bed'];
  if (segType === 'stop_set') return ['promo'];
  return [];
}

function SourcesEditor({
  sources, segType, onChange, playlists,
}: {
  sources: SegmentSourceEntry[];
  segType: ClockSegmentType;
  onChange: (sources: SegmentSourceEntry[]) => void;
  playlists: PlaylistSummary[];
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

  // Stop-set — two fixed slots: campaigns + promos. See docs/clocks-rotations-redesign.md §3.
  if (segType === 'stop_set') {
    return <StopSetSourcesEditor sources={sources} onChange={onChange} playlists={playlists} />;
  }

  // Music, live, live_audience — multi-source list
  const validTypes = VALID_SOURCE_TYPES[segType];
  const showWeight = segType === 'music';

  // 'playlist' can appear multiple times; all other types are single-use
  const REPEATABLE = new Set<SegmentSourceEntry['type']>(['playlist']);

  // Playlist IDs already in use by other rows — for dropdown exclusion
  const usedPlaylistIds = (excludeIdx: number) =>
    new Set(
      sources
        .filter((s, idx) => idx !== excludeIdx && s.type === 'playlist')
        .map((s) => (s as Extract<SegmentSourceEntry, { type: 'playlist' }>).playlist_id),
    );

  const addSource = () => {
    const usedSingles = new Set(sources.filter((s) => !REPEATABLE.has(s.type)).map((s) => s.type));
    const pick = validTypes.find((t) => !REPEATABLE.has(t) && !usedSingles.has(t))
      ?? validTypes.find((t) => REPEATABLE.has(t));
    if (!pick) return;
    if (pick === 'playlist') {
      const cats = playlistCategoriesForSegType(segType);
      const usedIds = new Set(
        sources.filter((s) => s.type === 'playlist').map((s) => (s as Extract<SegmentSourceEntry, { type: 'playlist' }>).playlist_id),
      );
      const candidates = cats.length ? playlists.filter((p) => cats.includes(p.type)) : playlists;
      const first = candidates.find((p) => !usedIds.has(p.id)) ?? candidates[0];
      onChange([...sources, { type: 'playlist', playlist_id: first?.id ?? 0, weight: 1, hot_play: false, heavy_rotation: false, rotation_id: null }]);
    } else {
      onChange([...sources, makeDefaultSource(pick)]);
    }
  };

  const updateSource = (i: number, entry: SegmentSourceEntry) =>
    onChange(sources.map((s, idx) => (idx === i ? entry : s)));

  const removeSource = (i: number) =>
    onChange(sources.filter((_, idx) => idx !== i));

  const usedSingles = new Set(sources.filter((s) => !REPEATABLE.has(s.type)).map((s) => s.type));
  // Live segments allow only one bed playlist (show_beds counts separately as a single-use type).
  const bedPlaylistCapped = (segType === 'live' || segType === 'live_audience') &&
    sources.filter((s) => s.type === 'playlist').length >= 1;
  const cats = playlistCategoriesForSegType(segType);
  const eligiblePlaylists = cats.length ? playlists.filter((p) => cats.includes(p.type)) : playlists;
  const canAddPlaylist = !bedPlaylistCapped && validTypes.includes('playlist') && eligiblePlaylists.length > 0;
  const canAddOther = validTypes.some((t) => !REPEATABLE.has(t) && !usedSingles.has(t));
  const canAdd = canAddPlaylist || canAddOther;

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
            usedPlaylistIds={usedPlaylistIds(i)}
            showWeight={showWeight}
            onChange={(entry) => updateSource(i, entry)}
            onRemove={() => removeSource(i)}
            playlists={playlists}
            segType={segType}
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

// ─── Stop-set two-slot editor ────────────────────────────────────────────────
//
// Each slot (Campaigns, Promos) has a "Creative rotation" selector. This controls
// how the supervisor cycles through multiple creatives within the SAME campaign or
// promo — e.g. round-robin across spots booked for this break. It does NOT
// determine which campaigns or promos are eligible to play in this segment; that
// eligibility is resolved by the campaign scheduler based on booking rules.

type StopSetCampaignsMode = 'none' | 'campaigns' | 'playlist';
type StopSetPromosMode    = 'none' | 'promos' | 'playlist';

function classifyStopSetSources(sources: SegmentSourceEntry[], playlists: PlaylistSummary[]) {
  let campaignsMode: StopSetCampaignsMode = 'none';
  let campaignsRotation: SimpleRotationType | undefined;
  let campaignsPlaylistId: number | null = null;

  let promosMode: StopSetPromosMode = 'none';
  let promosRotation: SimpleRotationType | undefined;
  let promosPlaylistId: number | null = null;

  for (const s of sources) {
    if (s.type === 'campaigns') {
      campaignsMode = 'campaigns';
      campaignsRotation = s.rotation;
    } else if (s.type === 'promos') {
      promosMode = 'promos';
      promosRotation = s.rotation;
    } else if (s.type === 'playlist') {
      const pl = playlists.find((p) => p.id === s.playlist_id);
      if (pl?.type === 'spot') {
        campaignsMode = 'playlist';
        campaignsPlaylistId = s.playlist_id;
        campaignsRotation = s.rotation;
      } else {
        promosMode = 'playlist';
        promosPlaylistId = s.playlist_id;
        promosRotation = s.rotation;
      }
    }
  }
  return {
    campaignsMode, campaignsRotation, campaignsPlaylistId,
    promosMode,    promosRotation,    promosPlaylistId,
  };
}

function StopSetSourcesEditor({
  sources, onChange, playlists,
}: {
  sources: SegmentSourceEntry[];
  onChange: (sources: SegmentSourceEntry[]) => void;
  playlists: PlaylistSummary[];
}) {
  const state = classifyStopSetSources(sources, playlists);

  const buildSources = (next: typeof state): SegmentSourceEntry[] => {
    const out: SegmentSourceEntry[] = [];
    // Campaigns slot
    if (next.campaignsMode === 'campaigns') {
      out.push({ type: 'campaigns', rotation: next.campaignsRotation });
    } else if (next.campaignsMode === 'playlist' && next.campaignsPlaylistId !== null) {
      out.push({
        type: 'playlist', playlist_id: next.campaignsPlaylistId, weight: 1,
        hot_play: false, heavy_rotation: false, rotation: next.campaignsRotation, rotation_id: null,
      });
    }
    // Promos slot
    if (next.promosMode === 'promos') {
      out.push({ type: 'promos', weight: 1, rotation: next.promosRotation });
    } else if (next.promosMode === 'playlist' && next.promosPlaylistId !== null) {
      out.push({
        type: 'playlist', playlist_id: next.promosPlaylistId, weight: 1,
        hot_play: false, heavy_rotation: false, rotation: next.promosRotation, rotation_id: null,
      });
    }
    return out;
  };

  const updateState = (patch: Partial<typeof state>) => onChange(buildSources({ ...state, ...patch }));

  return (
    <div className="space-y-3">
      {/* Campaigns slot */}
      <StopSetSlot
        title="Campaigns"
        mode={state.campaignsMode}
        modeOptions={[
          { value: 'none', label: 'None' },
          { value: 'campaigns', label: 'Campaigns' },
          { value: 'playlist', label: 'Campaigns playlist' },
        ]}
        playlistCategory="spot"
        playlistId={state.campaignsPlaylistId}
        rotation={state.campaignsRotation}
        playlists={playlists}
        onModeChange={(mode) => {
          const m = mode as StopSetCampaignsMode;
          const firstSpot = playlists.find((p) => p.type === 'spot');
          updateState({
            campaignsMode: m,
            campaignsPlaylistId: m === 'playlist' ? (state.campaignsPlaylistId ?? firstSpot?.id ?? null) : null,
          });
        }}
        onPlaylistChange={(id) => updateState({ campaignsPlaylistId: id })}
        onRotationChange={(r) => updateState({ campaignsRotation: r })}
      />

      {/* Promos slot */}
      <StopSetSlot
        title="Promos"
        mode={state.promosMode}
        modeOptions={[
          { value: 'none', label: 'None' },
          { value: 'promos', label: 'Promos' },
          { value: 'playlist', label: 'Promos playlist' },
        ]}
        playlistCategory="promo"
        playlistId={state.promosPlaylistId}
        rotation={state.promosRotation}
        playlists={playlists}
        onModeChange={(mode) => {
          const m = mode as StopSetPromosMode;
          const firstPromo = playlists.find((p) => p.type === 'promo');
          updateState({
            promosMode: m,
            promosPlaylistId: m === 'playlist' ? (state.promosPlaylistId ?? firstPromo?.id ?? null) : null,
          });
        }}
        onPlaylistChange={(id) => updateState({ promosPlaylistId: id })}
        onRotationChange={(r) => updateState({ promosRotation: r })}
      />
    </div>
  );
}

function StopSetSlot({
  title, mode, modeOptions, playlistCategory, playlistId, rotation, playlists,
  onModeChange, onPlaylistChange, onRotationChange,
}: {
  title: string;
  mode: string;
  modeOptions: { value: string; label: string }[];
  playlistCategory: 'spot' | 'promo';
  playlistId: number | null;
  rotation: SimpleRotationType | undefined;
  playlists: PlaylistSummary[];
  onModeChange: (v: string) => void;
  onPlaylistChange: (id: number | null) => void;
  onRotationChange: (r: SimpleRotationType | undefined) => void;
}) {
  const isNone = mode === 'none';
  return (
    <div className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800/60">
        <span className="text-xs font-medium text-zinc-300 w-24">{title}</span>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
        >
          {modeOptions.map((o) => (
            <option key={o.value} value={o.value} className="bg-zinc-900">{o.label}</option>
          ))}
        </select>
      </div>
      {!isNone && (
        <div className="flex items-center gap-3 px-3 py-2">
          {mode === 'playlist' && (
            <div className="flex-1 min-w-0">
              <PlaylistDropdown
                value={playlistId}
                onChange={onPlaylistChange}
                playlists={playlists}
                categories={[playlistCategory]}
              />
            </div>
          )}
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-xs text-zinc-500">Creative rotation</span>
            <select
              value={rotation ?? ''}
              onChange={(e) => onRotationChange(e.target.value === '' ? undefined : (e.target.value as SimpleRotationType))}
              className="px-1.5 py-0.5 bg-zinc-800 border border-zinc-700/60 rounded text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
            >
              <option value="" className="bg-zinc-900">Default</option>
              <option value="round_robin" className="bg-zinc-900">Round robin</option>
              <option value="random" className="bg-zinc-900">Random</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function getSourceLabel(type: SegmentSourceEntry['type'], segType: ClockSegmentType): string {
  if (type === 'playlist' && (segType === 'live' || segType === 'live_audience')) return 'Beds playlist';
  return SOURCE_LABELS[type];
}

function SourceRow({
  source, validTypes, usedTypes, usedPlaylistIds, showWeight, onChange, onRemove, playlists, segType,
}: {
  source: SegmentSourceEntry;
  validTypes: SegmentSourceEntry['type'][];
  usedTypes: Set<SegmentSourceEntry['type']>;
  usedPlaylistIds: Set<number>;
  showWeight: boolean;
  onChange: (entry: SegmentSourceEntry) => void;
  onRemove: () => void;
  playlists: PlaylistSummary[];
  segType: ClockSegmentType;
}) {
  const availableTypes = validTypes.filter((t) => t === source.type || !usedTypes.has(t));
  const hasTier = source.type === 'show_playlist';
  const isPlaylist = source.type === 'playlist';
  const hasWeight = showWeight && 'weight' in source;
  const playlistSrc = isPlaylist ? (source as PlaylistSource) : null;

  // ── Stop-set virtual-type tracking ────────────────────────────────────────
  // stop_set exposes 'playlist_promo' and 'playlist_spot' as UI variants of
  // the shared 'playlist' source type. We derive the variant from the resolved
  // playlist's category, then hold it in state for the brief window before a
  // playlist is selected or when playlists haven't loaded yet.
  const derivedVariant = useMemo<'playlist_promo' | 'playlist_spot' | null>(() => {
    if (segType !== 'stop_set' || source.type !== 'playlist') return null;
    const ps = source as PlaylistSource;
    const pl = playlists.find(p => p.id === ps.playlist_id);
    if (!pl) return null;
    return pl.type === 'spot' ? 'playlist_spot' : 'playlist_promo';
  }, [segType, source, playlists]);

  const [stopSetVariant, setStopSetVariant] = useState<'playlist_promo' | 'playlist_spot'>('playlist_promo');

  useEffect(() => {
    if (derivedVariant !== null) setStopSetVariant(derivedVariant);
  }, [derivedVariant]);

  // Playlist category filter for the dropdown
  const playlistCategories: string[] = (() => {
    if (segType === 'music') return ['music'];
    if (segType === 'live' || segType === 'live_audience') return ['bed'];
    if (segType === 'stop_set') return stopSetVariant === 'playlist_spot' ? ['spot'] : ['promo'];
    return [];
  })();

  const typeSelectorValue = segType === 'stop_set' && isPlaylist ? stopSetVariant : source.type;

  const handleTypeChange = (val: string) => {
    if (val === 'playlist_promo') {
      setStopSetVariant('playlist_promo');
      const first = playlists.find(p => p.type === 'promo');
      onChange({ type: 'playlist', playlist_id: first?.id ?? 0, weight: 1, hot_play: false, heavy_rotation: false });
    } else if (val === 'playlist_spot') {
      setStopSetVariant('playlist_spot');
      const first = playlists.find(p => p.type === 'spot');
      onChange({ type: 'playlist', playlist_id: first?.id ?? 0, weight: 1, hot_play: false, heavy_rotation: false });
    } else {
      onChange(makeDefaultSource(val as SegmentSourceEntry['type']));
    }
  };

  const typeOptions = (types: SegmentSourceEntry['type'][]) =>
    segType === 'stop_set'
      ? types.flatMap(t =>
          t === 'playlist'
            ? [
                <option key="playlist_promo" value="playlist_promo" className="bg-zinc-900">Promos playlist</option>,
                <option key="playlist_spot" value="playlist_spot" className="bg-zinc-900">Campaigns playlist</option>,
              ]
            : [<option key={t} value={t} className="bg-zinc-900">{SOURCE_LABELS[t]}</option>]
        )
      : types.map(t => (
          <option key={t} value={t} className="bg-zinc-900">{getSourceLabel(t, segType)}</option>
        ));

  // Playlist entries use a structured multi-line layout
  if (isPlaylist && playlistSrc) {
    const weightVal = hasWeight ? (source as Extract<SegmentSourceEntry, { weight: number }>).weight : 1;
    // Exclude playlists already chosen by sibling rows. Keep the current row's selection.
    const filteredPlaylists = playlists.filter(
      (p) => p.id === playlistSrc.playlist_id || !usedPlaylistIds.has(p.id),
    );
    const noPlaylistSelected = !playlistSrc.playlist_id;
    return (
      <div className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
        {/* Header row: type selector + remove */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800/60">
          <select
            value={typeSelectorValue}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
          >
            {typeOptions(availableTypes)}
          </select>
          <button onClick={onRemove} className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-red-900/20 flex-shrink-0">
            <X className="w-3 h-3" />
          </button>
        </div>
        {/* Fields row: playlist picker + optional weight */}
        <div className="flex items-center gap-4 px-3 py-2">
          <div className="flex-1 min-w-0 space-y-1">
            <PlaylistDropdown
              value={playlistSrc.playlist_id || null}
              onChange={(v) => onChange({ ...playlistSrc, playlist_id: v ?? 0 })}
              playlists={filteredPlaylists}
              categories={playlistCategories}
              invalid={noPlaylistSelected}
              allowNone={false}
            />
            {noPlaylistSelected && (
              <p className="text-xs text-red-400">A playlist must be selected.</p>
            )}
          </div>
          {showWeight && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
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
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 bg-zinc-900 rounded px-2 py-1.5">
      <select
        value={source.type}
        onChange={(e) => handleTypeChange(e.target.value)}
        className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
      >
        {typeOptions(availableTypes)}
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

      {'rotation' in source && (
        <select
          value={(source as { rotation?: string }).rotation ?? ''}
          onChange={(e) => {
            const s = source as Extract<SegmentSourceEntry, { rotation?: SimpleRotationType }>;
            onChange({ ...s, rotation: e.target.value === '' ? undefined : e.target.value as SimpleRotationType });
          }}
          className="px-1.5 py-1 bg-zinc-800 border border-zinc-700/60 rounded text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
        >
          <option value="" className="bg-zinc-900">Default</option>
          <option value="round_robin" className="bg-zinc-900">Round robin</option>
          <option value="random" className="bg-zinc-900">Random</option>
        </select>
      )}

      <button onClick={onRemove} className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-red-900/20 flex-shrink-0">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ─── Segment sweeper editor ───────────────────────────────────────────────────

function SegmentSweeperEditor({
  config, sweeperRotations, onChange,
}: {
  config: SegmentSweeperConfig | null;
  sweeperRotations: Rotation[];
  onChange: (c: SegmentSweeperConfig | null) => void;
}) {
  const enabled = config !== null;

  const toggle = () => {
    if (enabled) {
      onChange(null);
    } else {
      onChange({ per_hour: 3, min_gap_minutes: 8, sources: [{ type: 'jingle', weight: 1, rotation_id: null }] });
    }
  };

  const update = (patch: Partial<SegmentSweeperConfig>) => {
    if (!config) return;
    onChange({ ...config, ...patch });
  };

  const updateSource = (i: number, patch: Partial<SweepSourceEntry>) => {
    if (!config) return;
    onChange({ ...config, sources: config.sources.map((s, idx) => idx === i ? { ...s, ...patch } : s) });
  };

  const addSource = () => {
    if (!config) return;
    const used = new Set(config.sources.map((s) => s.type));
    const pick = SWEEP_SOURCES.find((t) => !used.has(t)) ?? 'jingle';
    onChange({ ...config, sources: [...config.sources, { type: pick, weight: 1, rotation_id: null }] });
  };

  const removeSource = (i: number) => {
    if (!config) return;
    onChange({ ...config, sources: config.sources.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="pt-2">
      <div className="flex items-center gap-3 mb-2">
        <label className="text-xs font-medium text-zinc-400">Sweepers</label>
        <button
          type="button"
          onClick={toggle}
          className={`relative inline-flex h-4 w-8 items-center rounded-full transition-colors ${enabled ? 'bg-indigo-600' : 'bg-zinc-700'}`}
        >
          <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {enabled && config && (
        <div className="space-y-2">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Per hour</span>
              <input type="number" min={0} max={20} value={config.per_hour}
                onChange={(e) => update({ per_hour: Math.max(0, Math.min(20, parseInt(e.target.value) || 0)) })}
                className="w-14 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">Min gap</span>
              <input type="number" min={1} value={config.min_gap_minutes}
                onChange={(e) => update({ min_gap_minutes: Math.max(1, parseInt(e.target.value) || 1) })}
                className="w-14 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
              />
              <span className="text-xs text-zinc-500">min</span>
            </div>
          </div>
          <div className="space-y-1.5">
            {config.sources.map((src, i) => {
              const usedByOthers = new Set(config.sources.filter((_, idx) => idx !== i).map((s) => s.type));
              return (
                <div key={i} className="flex items-center gap-2">
                  <select value={src.type}
                    onChange={(e) => updateSource(i, { type: e.target.value as typeof SWEEP_SOURCES[number] })}
                    className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
                  >
                    {SWEEP_SOURCES.filter((t) => t === src.type || !usedByOthers.has(t)).map((t) => (
                      <option key={t} value={t} className="bg-zinc-900">{SWEEP_SOURCE_LABELS[t]}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-zinc-500">wt</span>
                    <input type="number" min={1} value={src.weight}
                      onChange={(e) => updateSource(i, { weight: Math.max(1, parseInt(e.target.value) || 1) })}
                      className="w-12 px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
                    />
                  </div>
                  <select value={src.rotation_id ?? ''}
                    onChange={(e) => updateSource(i, { rotation_id: e.target.value === '' ? null : Number(e.target.value) })}
                    className="px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-300 focus:outline-none focus:border-indigo-500 max-w-[160px]"
                    title="Sweeper rotation document"
                  >
                    <option value="" className="bg-zinc-900">Default rotation</option>
                    {sweeperRotations.map((r) => (
                      <option key={r.id} value={r.id} className="bg-zinc-900">{r.name}{r.is_default ? ' (default)' : ''}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeSource(i)}
                    className="p-1 text-zinc-600 hover:text-red-400 transition-colors rounded hover:bg-red-900/20"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
            {config.sources.length < SWEEP_SOURCES.length && (
              <button type="button" onClick={addSource} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                + Add type
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Handover policy editor ───────────────────────────────────────────────────


// ─── Small helpers ────────────────────────────────────────────────────────────

function ClockActions({ dirty, isPending, confirmDelete, onSave, onDiscard, onDeleteRequest, onDeleteConfirm, onDeleteCancel, row }: {
  dirty: boolean; isPending: boolean; confirmDelete: boolean; row?: boolean;
  onSave: () => void; onDiscard: () => void;
  onDeleteRequest: () => void; onDeleteConfirm: () => void; onDeleteCancel: () => void;
}) {
  if (dirty) return (
    <div className={`flex ${row ? 'flex-row' : 'flex-col'} items-center gap-2`}>
      <button onClick={onSave} disabled={isPending} className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50">
        {isPending ? 'Saving…' : 'Save'}
      </button>
      <button onClick={onDiscard} className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors">Discard</button>
    </div>
  );
  if (confirmDelete) return (
    <div className={`flex ${row ? 'flex-row' : 'flex-col'} items-center gap-1.5`}>
      <span className="text-xs text-zinc-400">Delete?</span>
      <button onClick={onDeleteConfirm} className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors">Yes</button>
      <button onClick={onDeleteCancel} className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
    </div>
  );
  return (
    <button onClick={onDeleteRequest} className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors" title="Delete clock">
      <Trash2 className="w-3.5 h-3.5" />
    </button>
  );
}

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

function PlaylistDropdown({ value, onChange, playlists, categories, invalid, allowNone = true }: {
  value: number | null;
  onChange: (v: number | null) => void;
  playlists: PlaylistSummary[];
  categories?: string[];
  invalid?: boolean;
  allowNone?: boolean;
}) {
  const filtered = categories?.length ? playlists.filter(p => categories.includes(p.type)) : playlists;
  return (
    <select
      value={value ?? ''}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10);
        onChange(isNaN(v) || v <= 0 ? null : v);
      }}
      className={`w-full px-3 py-1.5 bg-zinc-900 border rounded text-sm text-zinc-300 cursor-pointer focus:outline-none ${invalid ? 'border-red-500 focus:border-red-400' : 'border-zinc-700 focus:border-indigo-500'}`}
    >
      {allowNone && <option value="" className="bg-zinc-900 text-zinc-500">— None —</option>}
      {!allowNone && filtered.length === 0 && (
        <option value="" disabled className="bg-zinc-900 text-zinc-500">No playlists available</option>
      )}
      {filtered.map(p => (
        <option key={p.id} value={p.id} className="bg-zinc-900">{p.name}{p.is_default ? ' (default)' : ''}</option>
      ))}
    </select>
  );
}
