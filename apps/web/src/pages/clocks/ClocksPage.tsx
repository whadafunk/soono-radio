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
  Plus, GripVertical, Trash2, Check, X, Clock, Lock,
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
  DRIFT_EVENT_TYPES,
  DriftEventType,
  SegmentSweeperConfig,
  SweepSourceEntry,
  SWEEP_SOURCES,
  SIMPLE_ROTATION_TYPES,
  SimpleRotationType,
  JOIN_POLICIES,
  JoinPolicy,
  Rotation,
  playlistMediaCategory,
  type Playlist,
  type ShowPlaylist,
} from '@radio/shared';
import {
  fetchClocks,
  fetchClockSegments,
  createClock,
  updateClock,
  deleteClock,
  replaceClockSegments,
  fetchPlaylists,
  fetchRotations,
  fetchSupervisorConfig,
  fetchShowPlaylists,
} from '../../api';
import type { PlaylistSummary } from '../../api';
import { HelpTooltip, BadgeTooltip } from '../../components/HelpTooltip';
import { SaveStatus } from '../../components/SaveStatus';

// ─── Handover / sweep labels ──────────────────────────────────────────────────


function startBadge(policy: StartPolicy): { label: string; cls: string } {
  if (policy.type === 'hard') return { label: 'fixed', cls: 'bg-red-900/20 text-red-400' };
  const lateOn  = policy.late_seconds  !== 0;
  const earlyOn = policy.early_seconds !== 0;
  if (lateOn && earlyOn) return { label: 'flexible',   cls: 'bg-green-900/20 text-green-400' };
  if (lateOn)            return { label: 'flexi-late',  cls: 'bg-amber-900/20 text-amber-400' };
  if (earlyOn)           return { label: 'flexi-early', cls: 'bg-blue-900/20 text-blue-400' };
  return { label: 'fixed', cls: 'bg-red-900/20 text-red-400' };
}

const JOIN_POLICY_LABELS: Record<JoinPolicy, { label: string; desc: string }> = {
  join_top:  { label: 'Join at top',  desc: 'Always start the clock at segment 1, regardless of when the slot begins.' },
  join_mid:  { label: 'Join mid',     desc: 'Skip ahead to the segment that would be playing at the current wall-clock minute. Preserves break-time alignment.' },
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
  stop_set:      { label: 'Stop Set',       color: '#f59e0b', bg: 'bg-amber-500/15',   border: 'border-amber-500/40',   text: 'text-amber-300'   },
  news:          { label: 'News',           color: '#f43f5e', bg: 'bg-rose-500/15',    border: 'border-rose-500/40',    text: 'text-rose-300'    },
  voice_track:   { label: 'Tracking',       color: '#fb923c', bg: 'bg-orange-500/15',  border: 'border-orange-500/40',  text: 'text-orange-300'  },
  bulletin:      { label: 'Bulletin',       color: '#a78bfa', bg: 'bg-violet-500/15',  border: 'border-violet-500/40',  text: 'text-violet-300'  },
};

// Source type labels (for SegmentSourceEntry['type'])
const SOURCE_LABELS: Record<SegmentSourceEntry['type'], string> = {
  show_playlist: 'Show Playlist',
  show_jingles:  'Show jingles',
  show_beds:     'Show beds',
  promos:        'Promos',
  playlist:      'Segment Playlist',
  campaigns:     'Campaigns',
  live:          'Harbor (live)',
  recording:     'Recording',
};

// Available source types per segment type
const VALID_SOURCE_TYPES: Record<ClockSegmentType, SegmentSourceEntry['type'][]> = {
  music:         ['show_playlist', 'playlist'],
  live:          ['live', 'show_beds', 'playlist'],
  stop_set:      ['campaigns', 'promos', 'playlist'],
  news:          ['live', 'recording'],
  voice_track:   ['playlist'],
  bulletin:      ['live', 'recording'],
};

const DRIFT_EVENT_LABELS: Record<DriftEventType, string> = {
  songs:       'Songs',
  jingles:     'Jingles',
  station_ids: 'Station IDs',
  spots:       'Spots',
  promos:      'Promos',
};

// Which event types are applicable for catching-up (skip) per segment type
const CATCHUP_TYPES: Record<ClockSegmentType, DriftEventType[]> = {
  music:         ['jingles', 'station_ids', 'songs'],
  stop_set:      ['promos', 'spots'],
  news:          [],
  live:          [],
  voice_track:   ['jingles', 'station_ids'],
  bulletin:      [],
};

// Which event types are applicable for coasting (fill) per segment type
const COASTING_TYPES: Record<ClockSegmentType, DriftEventType[]> = {
  music:         ['jingles', 'station_ids', 'songs'],
  stop_set:      ['promos', 'spots'],
  news:          [],
  live:          [],
  voice_track:   ['jingles', 'station_ids'],
  bulletin:      ['jingles', 'station_ids'],
};

const DURATION_DEFAULT: Record<ClockSegmentType, number> = {
  music:          480,
  live:           600,
  stop_set:       180,
  news:           120,
  voice_track:     60,
  bulletin:        60,
};

const DURATION_STEP: Record<ClockSegmentType, number> = {
  music:          30,
  live:           60,
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
  can_skip: boolean;
  can_fill: boolean;
  can_reschedule: boolean;
  catching_up_order: DriftEventType[];
  coasting_order: DriftEventType[];
  accept_live: boolean;
  sweeper_config: SegmentSweeperConfig | null;
}> = {
  music:         { sources: [],                                         start_policy: { type: 'flexible', late_seconds: null, early_seconds: 0 }, can_skip: true,  can_fill: true,  can_reschedule: false, catching_up_order: ['jingles', 'station_ids', 'songs'],  coasting_order: ['jingles', 'station_ids', 'songs'],  accept_live: true,  sweeper_config: DEFAULT_MUSIC_SWEEPER_CONFIG },
  live:          { sources: [{ type: 'live' }],                                     start_policy: { type: 'flexible', late_seconds: null, early_seconds: 0 }, can_skip: false, can_fill: false, can_reschedule: false, catching_up_order: [],                                   coasting_order: [],                                   accept_live: true,  sweeper_config: DEFAULT_LIVE_SWEEPER_CONFIG  },
  stop_set:      { sources: [{ type: 'campaigns' }, { type: 'promos', weight: 1 }], start_policy: { type: 'hard' },                                    can_skip: true,  can_fill: true,  can_reschedule: false, catching_up_order: ['jingles', 'promos', 'spots'],       coasting_order: ['jingles', 'promos'],                accept_live: false, sweeper_config: null                         },
  news:          { sources: [{ type: 'live' }],                                     start_policy: { type: 'hard' },                                    can_skip: false, can_fill: false, can_reschedule: false, catching_up_order: [],                                   coasting_order: [],                                   accept_live: true,  sweeper_config: null                         },
  voice_track:   { sources: [],                                                      start_policy: { type: 'hard' },                                    can_skip: false, can_fill: true,  can_reschedule: true,  catching_up_order: [],                                   coasting_order: ['jingles', 'station_ids'],            accept_live: false, sweeper_config: null                         },
  bulletin:      { sources: [{ type: 'live' }],                                     start_policy: { type: 'flexible', late_seconds: null, early_seconds: 0 }, can_skip: false, can_fill: true,  can_reschedule: true,  catching_up_order: [],                                   coasting_order: ['jingles', 'station_ids'],            accept_live: true,  sweeper_config: null                         },
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
    case 'show_playlist': return { type };
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
    start_clip_playlist_id: null,
    end_clip_playlist_id: null,
    bed_playlist_id: null,
    interstitial_jingles_enabled: false,
    jingle_every_n_tracks: null,
    interstitial_station_id_enabled: false,
    station_id_every_n_tracks: null,
    start_policy: d.start_policy,
    can_skip: d.can_skip,
    can_fill: d.can_fill,
    can_reschedule: d.can_reschedule,
    catching_up_order: d.catching_up_order,
    coasting_order: d.coasting_order,
    accept_live: d.accept_live,
    accept_sweepers: [],
    sweeper_config: d.sweeper_config,
    silence_threshold_seconds: null,
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
  const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(false);
  const [listConfirmDeleteId, setListConfirmDeleteId] = useState<number | null>(null);

  const dirty = clockDirty || segsDirty;

  const showSaveStatus = (type: 'success' | 'error', message: string) => {
    setSaveStatus({ type, message });
    if (type === 'success') setTimeout(() => setSaveStatus(null), 3000);
    // errors stay until dismissed so the message can be read
  };

  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });
  const { data: allPlaylists = [] } = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
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
      const promises: Promise<unknown>[] = [];
      if (clockDirty && draftClock)
        promises.push(updateClock(draftClock.id, {
          name: draftClock.name,
          description: draftClock.description,
          station_id_playlist_id: draftClock.station_id_playlist_id,
          jingle_playlist_id: draftClock.jingle_playlist_id,
          join_policy: draftClock.join_policy,
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
      showSaveStatus('success', 'Clock saved');
    },
    onError: (e) => {
      console.error('[clock save]', e);
      showSaveStatus('error', (e as Error).message);
    },
  });

  const createMutation = useMutation({
    mutationFn: createClock,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['clocks'] });
      setCreatingNew(false);
      setNewName('');
      // POST /clocks returns the raw DB row; augment with derived fields that the
      // GET list handler adds so selectClock doesn't crash on missing properties.
      selectClock({ ...created, duration_seconds: 0, used: false, slot_count: 0, assigned_shows: [] }, []);
      showSaveStatus('success', 'Clock created');
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
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
      showSaveStatus('success', 'Clock deleted');
    },
    onError: (e) => showSaveStatus('error', (e as Error).message),
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
        can_skip: d.can_skip,
        can_fill: d.can_fill,
        can_reschedule: d.can_reschedule,
        catching_up_order: d.catching_up_order,
        coasting_order: d.coasting_order,
        accept_live: d.accept_live,
        accept_sweepers: [],
        sweeper_config: d.sweeper_config,
      };
    }));
    setSegsDirty(true);
  };

  const total = totalSeconds(draftSegs);
  const overflow = total > 3600;
  // Clock is structurally locked only when actually scheduled (calendar / template slots).
  // Show assignment alone does NOT lock — it is a design-time hint.
  const structureLocked = draftClock !== null && draftClock.used;

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: clock list */}
        <div className="w-72 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
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
              const confirmingDelete = listConfirmDeleteId === clock.id;
              const assignedShows = clock.assigned_shows ?? [];
              return (
                <div key={clock.id} className={`group relative border-b border-zinc-800/60 transition-colors ${isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'}`}>
                  <button onClick={() => handleClockClick(clock)} className="w-full text-left px-4 py-3">
                    <div className="flex items-center gap-2 pr-6">
                      <Clock className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                      <span className="text-sm font-medium text-white truncate">{clock.name}</span>
                    </div>
                    <div className="flex gap-x-2 mt-1 ml-5 items-center flex-wrap gap-y-1">
                      <span
                        className={`text-[10px] px-1 py-0.5 rounded whitespace-nowrap cursor-default ${assignedShows.length > 0 ? 'bg-emerald-900/30 text-emerald-300' : 'bg-zinc-800 text-zinc-500'}`}
                      >
                        {assignedShows.length > 0 ? `Assigned (${assignedShows[0].name})` : 'Unassigned'}
                      </span>
                      <span className={`text-[10px] px-1 py-0.5 rounded whitespace-nowrap ${clock.slot_count > 0 ? 'bg-amber-900/30 text-amber-300' : 'bg-zinc-800 text-zinc-500'}`}>
                        {clock.slot_count > 0 ? 'Scheduled' : 'Unscheduled'}
                      </span>
                    </div>
                  </button>
                  {confirmingDelete ? (
                    <div className="px-4 pb-3 flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
                      {assignedShows.length > 0 ? (
                        <>
                          <span className="text-[11px] text-red-400 leading-tight">
                            Assigned to: {assignedShows.slice(0, 3).map((s) => s.name).join(', ')}
                            {assignedShows.length > 3 ? ` and ${assignedShows.length - 3} more` : ''}.
                            Remove assignment from those shows first.
                          </span>
                          <button
                            onClick={() => setListConfirmDeleteId(null)}
                            className="self-start px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                          >OK</button>
                        </>
                      ) : (
                        <>
                          {!!clock.slot_count && (
                            <span className="text-[11px] text-amber-400 leading-tight">
                              Scheduled in {clock.slot_count} slot{clock.slot_count !== 1 ? 's' : ''}. Slots will be orphaned.
                            </span>
                          )}
                          <div className="flex items-center gap-2">
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
                        </>
                      )}
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
                  <BadgeTooltip text={draftClock.slot_count > 0 ? `Active in ${draftClock.slot_count} schedule slot${draftClock.slot_count !== 1 ? 's' : ''}. Visit the Schedule page to view placement.` : 'Not placed on any schedule template or calendar entry. It won\'t air until assigned to a time slot.'}>
                    <span className={`flex-shrink-0 text-xs px-2 py-0.5 rounded ${draftClock.slot_count > 0 ? 'bg-amber-900/30 text-amber-300' : 'bg-zinc-800 text-zinc-500'}`}>
                      {draftClock.slot_count > 0 ? `Scheduled (${draftClock.slot_count})` : 'Unscheduled'}
                    </span>
                  </BadgeTooltip>
                  <SaveStatus status={saveStatus} onDismiss={() => setSaveStatus(null)} />
                  <ClockActions dirty={dirty} isPending={saveMutation.isPending} confirmDelete={confirmDelete} slotCount={draftClock.slot_count}
                    assignedShows={draftClock.assigned_shows}
                    onSave={() => saveMutation.mutate()} onDiscard={handleDiscard}
                    onDeleteRequest={() => setConfirmDelete(true)} onDeleteConfirm={() => deleteMutation.mutate(draftClock.id)}
                    onDeleteCancel={() => setConfirmDelete(false)} row
                  />
                </div>
              )}

              {/* Expanded */}
              {headerOpen && (
                <div>
                  {/* Header row */}
                  <div className="flex items-start gap-3 px-4 py-3 border-b border-zinc-800">
                    <button type="button" onClick={() => setHeaderOpen(false)} className="flex-shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors mt-1">
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <input
                        value={draftClock.name}
                        onChange={(e) => updateDraftClock((c) => ({ ...c, name: e.target.value }))}
                        className="w-full text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none transition-colors pb-0.5"
                      />
                      <input
                        value={draftClock.description ?? ''}
                        onChange={(e) => updateDraftClock((c) => ({ ...c, description: e.target.value || null }))}
                        placeholder="Add a description…"
                        className="mt-1 text-sm text-zinc-400 bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none w-full transition-colors pb-0.5 placeholder:text-zinc-600"
                      />
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                      <SaveStatus status={saveStatus} onDismiss={() => setSaveStatus(null)} />
                      <ClockActions dirty={dirty} isPending={saveMutation.isPending} confirmDelete={confirmDelete} slotCount={draftClock.slot_count}
                        assignedShows={draftClock.assigned_shows}
                        onSave={() => saveMutation.mutate()} onDiscard={handleDiscard}
                        onDeleteRequest={() => setConfirmDelete(true)} onDeleteConfirm={() => deleteMutation.mutate(draftClock.id)}
                        onDeleteCancel={() => setConfirmDelete(false)} row
                      />
                    </div>
                  </div>

                  {/* Body */}
                  <div className="flex items-stretch">
                    {/* Left: fields (~2/3) */}
                    <div className="flex-[2] min-w-0 px-5 py-4 space-y-3">
                      <div>
                        <p className="text-xs text-zinc-400 mb-1 flex items-center gap-1">
                          Join policy
                          <HelpTooltip text="How to enter this clock when the slot starts mid-way through its design length. Join at top always starts at segment 1; Join mid skips ahead to the segment that would be playing now, preserving wall-clock break alignment." />
                        </p>
                        <select
                          value={draftClock.join_policy ?? ''}
                          onChange={(e) => updateDraftClock((c) => ({ ...c, join_policy: e.target.value === '' ? null : e.target.value as typeof JOIN_POLICIES[number] }))}
                          className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 focus:outline-none focus:border-indigo-500"
                        >
                          <option value="" className="bg-zinc-900 text-zinc-400">Station default — {JOIN_POLICY_LABELS[supervisorConfig?.join_policy ?? 'join_top'].label}</option>
                          {JOIN_POLICIES.map((o) => (
                            <option key={o} value={o} className="bg-zinc-900">{JOIN_POLICY_LABELS[o].label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <p className="text-xs text-zinc-400 mb-1">Jingles Playlist</p>
                        {draftClock.assigned_shows.length > 0 ? (
                          <p className="text-xs text-zinc-400 px-3 py-1.5 border border-zinc-800 rounded bg-zinc-800/40 opacity-70">
                            {allPlaylists.find((p) => p.id === draftClock.assigned_shows[0].jingle_playlist_id)?.name ?? 'None'}
                            <span className="ml-1.5 text-zinc-500">(from show)</span>
                          </p>
                        ) : (
                          <PlaylistDropdown
                            value={draftClock.jingle_playlist_id ?? null}
                            onChange={(id) => updateDraftClock((c) => ({ ...c, jingle_playlist_id: id }))}
                            playlists={allPlaylists}
                            categories={['jingle']}
                            filter={(p) => p.subcategory === 'show'}
                          />
                        )}
                      </div>
                      <div>
                        <p className="text-xs text-zinc-400 mb-1">Station ID Playlist</p>
                        <PlaylistDropdown
                          value={draftClock.station_id_playlist_id ?? null}
                          onChange={(id) => updateDraftClock((c) => ({ ...c, station_id_playlist_id: id }))}
                          playlists={allPlaylists}
                          categories={['jingle']}
                          filter={(p) => p.subcategory === 'stationid'}
                        />
                      </div>
                    </div>

                    {/* Divider */}
                    <div className="w-px bg-zinc-800 flex-shrink-0" />

                    {/* Right: used by shows (~1/3) */}
                    <div className="flex-[1] min-w-0 px-5 py-4 space-y-3">
                      <BadgeTooltip text={draftClock.slot_count > 0 ? `Active in ${draftClock.slot_count} schedule slot${draftClock.slot_count !== 1 ? 's' : ''}. Visit the Schedule page to view placement.` : 'Not placed on any schedule template or calendar entry. It won\'t air until assigned to a time slot.'}>
                        <span className={`inline-flex whitespace-nowrap text-xs px-2 py-0.5 rounded ${draftClock.slot_count > 0 ? 'bg-amber-900/30 text-amber-300' : 'bg-zinc-800 text-zinc-500'}`}>
                          {draftClock.slot_count > 0 ? `Scheduled (${draftClock.slot_count})` : 'Unscheduled'}
                        </span>
                      </BadgeTooltip>
                      <div>
                        <p className="text-xs font-medium text-zinc-400 mb-2">Assigned by</p>
                        {draftClock.assigned_shows.length === 0 ? (
                          <p className="text-xs text-zinc-500 italic">No shows assigned</p>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {draftClock.assigned_shows.map((s) => (
                              <span key={s.id} className="text-xs text-zinc-300 truncate">{s.name}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
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
              locked={structureLocked}
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
                      <button
                        key={type}
                        onClick={() => !structureLocked && addSeg(type)}
                        disabled={structureLocked}
                        title={structureLocked ? 'Structure is locked — clock is scheduled or assigned' : undefined}
                        className={`px-2.5 py-1 text-xs rounded border transition-colors ${meta.bg} ${meta.border} ${meta.text} ${structureLocked ? 'opacity-30 cursor-not-allowed' : 'hover:brightness-125'}`}
                      >
                        + {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {structureLocked && (
                <div className="px-5 py-2.5 bg-amber-500/8 border-b border-amber-500/20 flex items-center gap-2 flex-shrink-0">
                  <Lock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <p className="text-xs text-amber-400/80">
                    Structure locked — clock is scheduled in {draftClock!.slot_count} slot{draftClock!.slot_count !== 1 ? 's' : ''}. Segment count, order, types, and durations cannot change.
                  </p>
                </div>
              )}

              <div className="flex-1 overflow-auto">
                <SegmentList
                  segments={draftSegs}
                  expandedId={expandedId}
                  locked={structureLocked}
                  onExpandToggle={(id) => setExpandedId((prev) => prev === id ? null : id)}
                  onDragStart={() => setExpandedId(null)}
                  onReorder={reorderSegs}
                  onUpdate={updateSeg}
                  onDelete={deleteSeg}
                  onChangeType={changeSegType}
                  playlists={allPlaylists}
                  musicRotations={musicRotations}
                  sweeperRotations={sweeperRotations}
                  assignedShows={draftClock!.assigned_shows}
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
  seg, cap, isActive, isDraggingAny, locked, onExpandToggle,
}: {
  seg: SegmentDraft;
  cap: number;
  isActive: boolean;
  isDraggingAny: boolean;
  locked: boolean;
  onExpandToggle: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: seg.id, disabled: locked });
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
  segments, total, overflow, expandedId, locked, onExpandToggle, onReorder,
}: {
  segments: SegmentDraft[];
  total: number;
  overflow: boolean;
  expandedId: number | null;
  locked: boolean;
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
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Hour overview</span>
      </div>
      <div className="relative h-4 mb-1">
        {[15, 30, 45].map((min) => (
          <span
            key={min}
            className="absolute bottom-0 text-xs text-zinc-400 font-mono -translate-x-1/2"
            style={{ left: `${(min / 60) * 100}%` }}
          >
            {min}m
          </span>
        ))}
        <span className="absolute bottom-0 right-0 text-xs text-zinc-400 font-mono">60m</span>
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
                locked={locked}
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
            {[15, 30, 45].map((min) => (
              <div
                key={min}
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{ left: `${(min / 60) * 100}%` }}
              >
                <div className="w-px h-full bg-zinc-600/60" />
              </div>
            ))}
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
        {segments.length > 0 && (
          <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-700">
            <span className="text-xs text-zinc-300">Total</span>
            <span className={`text-xs font-mono ${total > 3600 ? 'text-red-400' : 'text-zinc-400'}`}>{fmtDuration(total)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Segment list (accordion) ─────────────────────────────────────────────────

function SegmentList({
  segments, expandedId, locked, onExpandToggle, onDragStart, onReorder, onUpdate, onDelete, onChangeType, playlists, musicRotations, sweeperRotations, assignedShows,
}: {
  segments: SegmentDraft[];
  expandedId: number | null;
  locked: boolean;
  onExpandToggle: (id: number) => void;
  onDragStart: () => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
  assignedShows: { id: number; name: string }[];
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
              locked={locked}
              onExpand={() => onExpandToggle(seg.id)}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onChangeType={onChangeType}
              playlists={playlists}
              musicRotations={musicRotations}
              sweeperRotations={sweeperRotations}
              assignedShows={assignedShows}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ─── Sortable segment item ────────────────────────────────────────────────────

function SortableSegmentItem({
  segment, isExpanded, locked, onExpand, onUpdate, onDelete, onChangeType, playlists, musicRotations, sweeperRotations, assignedShows,
}: {
  segment: SegmentDraft;
  isExpanded: boolean;
  locked: boolean;
  onExpand: () => void;
  onUpdate: (id: number, patch: Partial<SegmentDraft>) => void;
  onDelete: (id: number) => void;
  onChangeType: (id: number, type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
  assignedShows: { id: number; name: string }[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segment.id, disabled: locked });
  const meta = SEGMENT_META[segment.type];

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: 'relative' as const,
  };

  const ttAbbrev = [
    segment.can_skip && 'catch',
    segment.can_fill && 'coast',
    segment.can_reschedule && 'resched',
  ].filter(Boolean).join('·');

  return (
    <div ref={setNodeRef} style={style}>
      <div
        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer group transition-colors ${isExpanded ? 'bg-zinc-800/60' : 'hover:bg-zinc-800/30'}`}
        onClick={onExpand}
      >
        <button
          {...attributes}
          {...(locked ? {} : listeners)}
          onClick={(e) => e.stopPropagation()}
          disabled={locked}
          className={`touch-none flex-shrink-0 p-0.5 transition-colors ${locked ? 'text-zinc-700 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing text-zinc-600 hover:text-zinc-300'}`}
          title={locked ? 'Reordering locked' : undefined}
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

        {(() => { const b = startBadge(segment.start_policy); return (
          <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>
        ); })()}

        {ttAbbrev && (
          <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">
            {ttAbbrev}
          </span>
        )}

        <span className="flex-shrink-0 text-xs text-zinc-400 font-mono w-12 text-right">{fmtDuration(segment.duration_seconds)}</span>

        {!locked && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(segment.id); }}
            className="flex-shrink-0 p-1 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors opacity-0 group-hover:opacity-100"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className={`overflow-hidden transition-all duration-200 ${isExpanded ? 'max-h-[700px]' : 'max-h-0'}`}>
        {isExpanded && (
          <div className="border-l-2 mx-3 mb-3 rounded-b overflow-hidden" style={{ borderColor: meta.color }}>
          <SegmentDrawer
            segment={segment}
            locked={locked}
            onApply={(patch) => onUpdate(segment.id, patch)}
            onChangeType={(type) => onChangeType(segment.id, type)}
            playlists={playlists}
            musicRotations={musicRotations}
            sweeperRotations={sweeperRotations}
            assignedShows={assignedShows}
          />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Segment drawer ───────────────────────────────────────────────────────────

type DrawerTab = 'content' | 'timing' | 'transitions' | 'live';

function SegmentDrawer({
  segment, locked, onApply, onChangeType, playlists, musicRotations, sweeperRotations, assignedShows,
}: {
  segment: SegmentDraft;
  locked: boolean;
  onApply: (patch: Partial<SegmentDraft>) => void;
  onChangeType: (type: ClockSegmentType) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  sweeperRotations: Rotation[];
  assignedShows: { id: number; name: string }[];
}) {
  const [tab, setTab] = useState<DrawerTab>('content');
  const [draft, setDraft] = useState<SegmentDraft>({ ...segment });

  const update = (patch: Partial<SegmentDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // Auto-apply: propagate every draft change to the parent immediately so the
  // clock-level Save always sees current state without a manual Apply step.
  const prevJson = useRef(JSON.stringify(segment));
  useEffect(() => {
    const current = JSON.stringify(draft);
    if (current !== prevJson.current) {
      prevJson.current = current;
      onApply(draft);
    }
  }, [draft]);

  const meta = SEGMENT_META[draft.type];
  const isLive = draft.type === 'live';
  const isRundownMode = (draft.type === 'news' || draft.type === 'bulletin')
    && draft.sources.some((s) => s.type === 'recording');
  const isRundownLive = (draft.type === 'news' || draft.type === 'bulletin')
    && draft.sources.length > 0 && draft.sources.every((s) => s.type === 'live');

  const TABS: { id: DrawerTab; label: string }[] = [
    { id: 'content', label: 'Content' },
    { id: 'timing', label: 'Timing' },
    { id: 'transitions', label: 'Branding' },
    ...(draft.type !== 'stop_set' ? [{ id: 'live' as DrawerTab, label: 'Sweepers & Live' }] : []),
  ];

  const flexPolicy = draft.start_policy.type === 'flexible'
    ? (draft.start_policy as Extract<StartPolicy, { type: 'flexible' }>)
    : { type: 'flexible' as const, late_seconds: 0, early_seconds: 0 };

  return (
    <div className="border-t border-zinc-700/60 bg-white/10">
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
                disabled={locked}
                onChange={(e) => {
                  if (locked) return;
                  const t = e.target.value as ClockSegmentType;
                  onChangeType(t);
                  const d = TYPE_DEFAULTS[t];
                  update({
                    type: t,
                    sources: d.sources,
                    start_policy: d.start_policy,
                    can_skip: d.can_skip,
                    can_fill: d.can_fill,
                    can_reschedule: d.can_reschedule,
                    catching_up_order: d.catching_up_order,
                    coasting_order: d.coasting_order,
                    accept_live: d.accept_live,
                    accept_sweepers: [],
                    sweeper_config: d.sweeper_config,
                  });
                }}
                className={`w-full px-3 py-1.5 rounded border text-sm bg-zinc-900 focus:outline-none focus:border-indigo-500 ${meta.border} ${meta.text} ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {CLOCK_SEGMENT_TYPES.map((t) => (
                  <option key={t} value={t} className="bg-zinc-900 text-white">{SEGMENT_META[t].label}</option>
                ))}
              </select>
            </Field>

            <Field label="Duration">
              <div className={`flex items-center gap-2 ${locked ? 'opacity-50' : ''}`}>
                <button
                  onClick={() => !locked && update({ duration_seconds: Math.max(DURATION_STEP[draft.type], draft.duration_seconds - DURATION_STEP[draft.type]) })}
                  disabled={locked}
                  className={`w-7 h-7 flex items-center justify-center rounded text-sm font-bold transition-colors ${locked ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'}`}
                >−</button>
                <input
                  type="number"
                  min={1}
                  max={7200}
                  value={draft.duration_seconds}
                  disabled={locked}
                  onChange={(e) => { if (locked) return; const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1 && v <= 7200) update({ duration_seconds: v }); }}
                  className={`w-20 text-center bg-zinc-900 border border-zinc-700 rounded text-sm text-white py-1.5 focus:outline-none focus:border-indigo-500 ${locked ? 'cursor-not-allowed' : ''}`}
                />
                <button
                  onClick={() => !locked && update({ duration_seconds: Math.min(7200, draft.duration_seconds + DURATION_STEP[draft.type]) })}
                  disabled={locked}
                  className={`w-7 h-7 flex items-center justify-center rounded text-sm font-bold transition-colors ${locked ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'}`}
                >+</button>
                <span className="text-sm text-zinc-400">{fmtDuration(draft.duration_seconds)}</span>
              </div>
            </Field>

            <div className="col-span-2">
              <label className="block text-xs font-medium text-zinc-300 mb-2">
                Source{' '}
                {draft.type === 'music' && (
                  <span className={`ml-1 text-[10px] font-normal px-1 py-0.5 rounded ${assignedShows.length > 0 ? 'bg-emerald-900/30 text-emerald-400' : 'bg-indigo-900/30 text-indigo-400'}`}>
                    {assignedShows.length > 0 ? 'Show' : 'Segment'}
                  </span>
                )}
              </label>
              <SourcesEditor
                sources={draft.sources}
                segType={draft.type}
                onChange={(sources) => update({ sources })}
                playlists={playlists}
                musicRotations={musicRotations}
                assignedShows={assignedShows}
              />
            </div>

            {draft.type === 'music' && assignedShows.length === 0 && draft.sources.some((s) => s.type === 'playlist') && (() => {
              const currentRotationId = (draft.sources.find((s) => s.type === 'playlist') as Extract<SegmentSourceEntry, { type: 'playlist' }> | undefined)?.rotation_id ?? null;
              const hasNoRotation = !currentRotationId;
              if (musicRotations.length === 0) {
                return (
                  <p className="text-xs text-zinc-500 col-span-2">
                    No rotation documents —{' '}
                    <Link to="/rotations" className="text-indigo-400 hover:text-indigo-300 underline-offset-2 hover:underline">
                      create one in Rotations
                    </Link>{' '}
                    to control play order for Segment Playlist mode.
                  </p>
                );
              }
              return (
                <div className="col-span-2 space-y-1">
                  <Field label="Music rotation">
                    <select
                      value={currentRotationId ?? ''}
                      onChange={(e) => {
                        const rid = e.target.value === '' ? null : Number(e.target.value);
                        update({
                          sources: draft.sources.map((s) =>
                            s.type === 'playlist' ? { ...s, rotation_id: rid } : s
                          ),
                        });
                      }}
                      className={`w-full px-3 py-1.5 bg-zinc-900 border rounded text-sm text-zinc-300 cursor-pointer focus:outline-none ${hasNoRotation ? 'border-red-500 focus:border-red-400' : 'border-zinc-700 focus:border-indigo-500'}`}
                    >
                      <option value="" disabled className="bg-zinc-900">— select a rotation —</option>
                      {musicRotations.map((r) => (
                        <option key={r.id} value={r.id} className="bg-zinc-900">{r.name}{r.is_default ? ' (default)' : ''}</option>
                      ))}
                    </select>
                  </Field>
                  {hasNoRotation && (
                    <p className="text-xs text-red-400">A rotation is required for Segment Playlist mode.</p>
                  )}
                </div>
              );
            })()}

{(draft.type === 'live') && (
              <Field label="Silence threshold" hint="Override the global silence detection threshold for this segment. Leave blank to use the Mix Engine default.">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    placeholder="Global default"
                    value={draft.silence_threshold_seconds ?? ''}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      update({ silence_threshold_seconds: !isNaN(v) && v >= 1 ? v : null });
                    }}
                    className="w-28 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
                  />
                  <span className="text-sm text-zinc-500">s</span>
                </div>
              </Field>
            )}

            {(draft.type === 'music' || draft.type === 'news' || draft.type === 'bulletin') && (
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1">
                  Accept live <HelpTooltip text="Allow the DJ to take over this segment via the harbor input" />
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.accept_live}
                    onChange={(e) => update({ accept_live: e.target.checked })}
                    className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-zinc-300">Allow DJ to go live during this segment</span>
                </label>
              </div>
            )}

            {(draft.type === 'news' || draft.type === 'bulletin' || draft.type === 'voice_track') && (
              <Field label="Fallback playlist" hint="Played when no rundown content is assigned. Leave blank to fall back to the segment's source config.">
                <PlaylistDropdown
                  value={draft.fallback_playlist_id ?? null}
                  onChange={(v) => update({ fallback_playlist_id: v })}
                  playlists={playlists}
                />
              </Field>
            )}
          </div>
        )}

        {/* ── Timing tab ── */}
        {tab === 'timing' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <p className="text-xs font-semibold text-zinc-300 mb-2">Start policy</p>
              <div className="space-y-2">
                {/* Start late */}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none w-28 shrink-0">
                    <input
                      type="checkbox"
                      checked={flexPolicy.late_seconds !== 0}
                      onChange={(e) => {
                        const next = { ...flexPolicy, late_seconds: e.target.checked ? null : 0 };
                        update({ start_policy: next.late_seconds === 0 && next.early_seconds === 0 ? { type: 'hard' } : next });
                      }}
                      className="accent-indigo-500"
                    />
                    <span className="text-xs text-zinc-300">Start late</span>
                    <HelpTooltip text="Wait for the previous segment to finish naturally. Empty limit = natural end; set seconds to force a cut after N seconds of overtime." />
                  </label>
                  {flexPolicy.late_seconds !== 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-zinc-300">up to</span>
                      <input
                        type="number"
                        min={1}
                        placeholder="∞"
                        value={flexPolicy.late_seconds ?? ''}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          update({ start_policy: { ...flexPolicy, late_seconds: isNaN(v) || v <= 0 ? null : v } });
                        }}
                        className="w-16 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
                      />
                      <span className="text-xs text-zinc-300">sec late{flexPolicy.late_seconds === null ? ' (natural end)' : ''}</span>
                    </div>
                  )}
                </div>
                {/* Start early */}
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none w-28 shrink-0">
                    <input
                      type="checkbox"
                      checked={flexPolicy.early_seconds !== 0}
                      onChange={(e) => {
                        const next = { ...flexPolicy, early_seconds: e.target.checked ? null : 0 };
                        update({ start_policy: next.late_seconds === 0 && next.early_seconds === 0 ? { type: 'hard' } : next });
                      }}
                      className="accent-indigo-500"
                    />
                    <span className="text-xs text-zinc-300">Start early</span>
                    <HelpTooltip text="Start early if the previous segment finishes ahead of schedule. Empty limit = fill gap immediately; set seconds to cap how early it can pull forward." />
                  </label>
                  {flexPolicy.early_seconds !== 0 && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-zinc-300">up to</span>
                      <input
                        type="number"
                        min={1}
                        placeholder="∞"
                        value={flexPolicy.early_seconds ?? ''}
                        onChange={(e) => {
                          const v = parseInt(e.target.value);
                          update({ start_policy: { ...flexPolicy, early_seconds: isNaN(v) || v <= 0 ? null : v } });
                        }}
                        className="w-16 px-2 py-1 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 text-center"
                      />
                      <span className="text-xs text-zinc-300">sec early{flexPolicy.early_seconds === null ? ' (fill gap)' : ''}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* End policy */}
            <div className="col-span-2 space-y-3">
              <p className="text-xs font-semibold text-zinc-300">End policy</p>

              {(isRundownLive || draft.type === 'live') ? (
                <p className="text-xs text-zinc-500 italic">Live segment — operator controls timing. No automatic catching up or coasting.</p>
              ) : (
                <>
                  {(CATCHUP_TYPES[draft.type].length > 0 || isRundownMode) && (
                    <div>
                      <p className="text-xs text-zinc-300 mb-1.5">Catching up — skip order <HelpTooltip text="Event types to skip when running late, in priority order. Check to enable, drag to reorder." /></p>
                      <DriftOrderList
                        allTypes={isRundownMode ? (['jingles', 'station_ids'] as DriftEventType[]) : CATCHUP_TYPES[draft.type]}
                        order={draft.catching_up_order}
                        onChange={(next) => update({ catching_up_order: next, can_skip: next.length > 0 })}
                      />
                    </div>
                  )}

                  {(COASTING_TYPES[draft.type].length > 0 || isRundownMode) && (
                    <div>
                      <p className="text-xs text-zinc-300 mb-1.5">Coasting — fill order <HelpTooltip text="Event types to fill with when the segment ends early, in preference order. Check to enable, drag to reorder." /></p>
                      <DriftOrderList
                        allTypes={isRundownMode ? (['jingles', 'station_ids'] as DriftEventType[]) : COASTING_TYPES[draft.type]}
                        order={draft.coasting_order}
                        onChange={(next) => update({ coasting_order: next, can_fill: next.length > 0 })}
                      />
                    </div>
                  )}

                  {(draft.type === 'voice_track' || draft.type === 'bulletin' || draft.type === 'news') && (
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={draft.can_reschedule} onChange={(e) => update({ can_reschedule: e.target.checked })}
                        className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500" />
                      <div>
                        <span className="text-xs font-medium text-zinc-200">Reschedule if late</span>
                        <p className="text-xs text-zinc-400">Defer the whole segment to the next available slot rather than playing it late.</p>
                      </div>
                    </label>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Transitions tab ── */}
        {tab === 'transitions' && (
          <div className="grid grid-cols-2 gap-4">
            <Field label="Start clip playlist" tooltip="Plays before segment content">
              <PlaylistDropdown value={draft.start_clip_playlist_id} onChange={(v) => update({ start_clip_playlist_id: v })} playlists={playlists} categories={['jingle', 'promo']} />
            </Field>
            <Field label="End clip playlist" tooltip="Plays after segment content">
              <PlaylistDropdown value={draft.end_clip_playlist_id} onChange={(v) => update({ end_clip_playlist_id: v })} playlists={playlists} categories={['jingle', 'promo']} />
            </Field>
            {(draft.type === 'music' || isRundownMode) && (
              <div className="col-span-2 border-t border-zinc-800 pt-4 mt-1 space-y-4">
                {/* Between-track jingles */}
                <div>
                  <p className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">Between-track jingles</p>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Enable" tooltip="Source: clock's jingle playlist — shared with sweepers">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.interstitial_jingles_enabled}
                          onChange={(e) => update({ interstitial_jingles_enabled: e.target.checked })}
                          className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-zinc-300">Insert jingles between tracks</span>
                      </label>
                    </Field>
                    {draft.interstitial_jingles_enabled && (
                      <Field label="Every N songs" hint="Insert one jingle after every N tracks">
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
                    )}
                  </div>
                </div>

                {/* Between-track station IDs */}
                <div>
                  <p className="text-xs font-semibold text-zinc-300 uppercase tracking-wider mb-3">Between-track station IDs</p>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Enable" tooltip="Source: clock's station ID playlist — shared with sweepers">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.interstitial_station_id_enabled}
                          onChange={(e) => update({ interstitial_station_id_enabled: e.target.checked })}
                          className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
                        />
                        <span className="text-sm text-zinc-300">Insert station IDs between tracks</span>
                      </label>
                    </Field>
                    {draft.interstitial_station_id_enabled && (
                      <Field label="Every N songs" hint="Insert one station ID after every N tracks">
                        <input
                          type="number"
                          min={1}
                          max={20}
                          placeholder="—"
                          value={draft.station_id_every_n_tracks ?? ''}
                          onChange={(e) => {
                            const v = parseInt(e.target.value, 10);
                            update({ station_id_every_n_tracks: !isNaN(v) && v >= 1 ? v : null });
                          }}
                          className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
                        />
                      </Field>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Sweepers & Live tab ── */}
        {tab === 'live' && (
          <div className="grid grid-cols-2 gap-4">
            {draft.type !== 'stop_set' && (
              <div className="col-span-2">
                <SegmentSweeperEditor
                  config={draft.sweeper_config ?? null}
                  sweeperRotations={sweeperRotations}
                  onChange={(c) => update({ sweeper_config: c })}
                />
              </div>
            )}

          </div>
        )}
      </div>

    </div>
  );
}

// ─── Sources editor ───────────────────────────────────────────────────────────

const IMPLICIT_LIVE_TYPES: ClockSegmentType[] = [];

type PlaylistSource = Extract<SegmentSourceEntry, { type: 'playlist' }>;

function playlistCategoriesForSegType(segType: ClockSegmentType): string[] {
  if (segType === 'music') return ['music'];
  if (segType === 'live') return ['bed'];
  if (segType === 'stop_set') return ['promo'];
  return [];
}

function MusicSourceEditor({
  sources, onChange, playlists, musicRotations, assignedShows,
}: {
  sources: SegmentSourceEntry[];
  onChange: (sources: SegmentSourceEntry[]) => void;
  playlists: PlaylistSummary[];
  musicRotations: Rotation[];
  assignedShows: { id: number; name: string }[];
}) {
  const isAssigned = assignedShows.length > 0;
  const playlistSources = sources.filter(
    (s): s is Extract<SegmentSourceEntry, { type: 'playlist' }> => s.type === 'playlist',
  );
  const musicPlaylists = playlists.filter((p) => p.type === 'music');
  const defaultRotationId = musicRotations.find((r) => r.is_default)?.id ?? musicRotations[0]?.id ?? null;

  const singleShowId = isAssigned && assignedShows.length === 1 ? assignedShows[0].id : null;
  const { data: showPlaylists = [] } = useQuery<ShowPlaylist[]>({
    queryKey: ['show-playlists', singleShowId],
    queryFn: () => fetchShowPlaylists(singleShowId!),
    enabled: singleShowId !== null,
  });

  // Sync sources to assignment state: add show_playlist when assigned, clear it when unassigned.
  // Intentionally only runs on isAssigned changes — sources/onChange omitted from deps deliberately.
  useEffect(() => {
    if (isAssigned && !sources.some((s) => s.type === 'show_playlist')) {
      onChange([{ type: 'show_playlist' }]);
    } else if (!isAssigned && sources.length > 0 && sources.every((s) => s.type === 'show_playlist')) {
      onChange([]);
    }
  }, [isAssigned]); // eslint-disable-line react-hooks/exhaustive-deps

  const addPlaylist = () => {
    const usedIds = new Set(playlistSources.map((s) => s.playlist_id));
    const first = musicPlaylists.find((p) => !usedIds.has(p.id));
    const rotationId = playlistSources[0]?.rotation_id ?? defaultRotationId ?? null;
    onChange([...sources.filter((s) => s.type !== 'show_playlist'), {
      type: 'playlist',
      playlist_id: first?.id ?? 0,
      weight: 1,
      hot_play: false,
      heavy_rotation: false,
      rotation_id: rotationId,
    }]);
  };

  const updateSource = (srcIdx: number, patch: Partial<Extract<SegmentSourceEntry, { type: 'playlist' }>>) => {
    onChange(sources.map((s, i) => (i === srcIdx ? { ...s, ...patch } as SegmentSourceEntry : s)));
  };

  const removeSource = (srcIdx: number) => {
    onChange(sources.filter((_, i) => i !== srcIdx));
  };

  // ── Show-assigned: read-only view of the show's music library ────────────────
  if (isAssigned) {
    if (assignedShows.length > 1) {
      return (
        <div className="text-sm text-zinc-400 bg-zinc-900 rounded border border-zinc-800 px-3 py-2">
          Multiple shows assigned — playlists are configured per show.
        </div>
      );
    }
    const show = assignedShows[0];
    if (showPlaylists.length === 0) {
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 bg-zinc-900 rounded px-3 py-2 border border-zinc-800">
            <span className="text-sm text-zinc-500">
              No music playlists on <span className="text-zinc-300">{show.name}</span> yet
            </span>
          </div>
          <p className="text-xs text-zinc-600">Add playlists on the show's Music tab.</p>
        </div>
      );
    }
    const sharedRotation = musicRotations.find((r) => r.id === showPlaylists[0]?.rotation_id);
    return (
      <div className="space-y-2">
        {showPlaylists.map((sp) => (
          <div key={sp.id} className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden opacity-80">
            <div className="flex items-center gap-4 px-3 py-2">
              <span className="flex-1 text-sm text-zinc-300 truncate">{sp.playlist_name}</span>
              <span className="text-xs text-zinc-500 flex-shrink-0">
                wt <span className="text-zinc-300">{sp.weight}</span>
              </span>
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-zinc-400">Music rotation</span>
          <span className="text-xs text-zinc-300">
            {sharedRotation ? sharedRotation.name : <span className="text-zinc-400">Default</span>}
          </span>
          <Lock className="w-3 h-3 text-zinc-500 ml-auto" />
        </div>
        <p className="text-xs text-zinc-400">Configured on {show.name}'s Music tab — read only here.</p>
      </div>
    );
  }

  // ── Standalone: editable segment playlists ───────────────────────────────────
  return (
    <div className="space-y-2">
      {sources.map((src, srcIdx) => {
        if (src.type !== 'playlist') return null;
        const ps = src as Extract<SegmentSourceEntry, { type: 'playlist' }>;
        const usedIds = new Set(
          sources
            .filter((s, i): s is Extract<SegmentSourceEntry, { type: 'playlist' }> => s.type === 'playlist' && i !== srcIdx)
            .map((s) => s.playlist_id),
        );
        const available = musicPlaylists.filter((p) => !usedIds.has(p.id) || p.id === ps.playlist_id);
        return (
          <div key={srcIdx} className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
            <div className="flex items-center gap-4 px-3 py-2">
              {playlistSources.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSource(srcIdx)}
                  className="p-1.5 -ml-1 text-zinc-400 hover:text-red-400 transition-colors rounded hover:bg-red-900/20 order-last"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <div className="flex-1 min-w-0 space-y-1">
                <PlaylistDropdown
                  value={ps.playlist_id || null}
                  onChange={(v) => updateSource(srcIdx, { playlist_id: v ?? 0 })}
                  playlists={available}
                  categories={['music']}
                  allowNone={false}
                  invalid={!ps.playlist_id}
                />
                {!ps.playlist_id && <p className="text-xs text-red-400">A playlist must be selected.</p>}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-xs text-zinc-500">Weight</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={ps.weight}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1) updateSource(srcIdx, { weight: v });
                  }}
                  className="w-12 px-1.5 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
                />
              </div>
            </div>
          </div>
        );
      })}
      {musicPlaylists.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No music playlists —{' '}
          <Link to="/playlists" className="text-indigo-400 hover:text-indigo-300">create one first</Link>
        </p>
      ) : musicPlaylists.length > playlistSources.length && (
        <button type="button" onClick={addPlaylist} className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          + Add playlist
        </button>
      )}
    </div>
  );
}

function SourcesEditor({
  sources, segType, onChange, playlists, musicRotations = [], assignedShows = [],
}: {
  sources: SegmentSourceEntry[];
  segType: ClockSegmentType;
  onChange: (sources: SegmentSourceEntry[]) => void;
  playlists: PlaylistSummary[];
  musicRotations?: Rotation[];
  assignedShows?: { id: number; name: string }[];
}) {
  if (segType === 'music') {
    return (
      <MusicSourceEditor
        sources={sources}
        onChange={onChange}
        playlists={playlists}
        musicRotations={musicRotations}
        assignedShows={assignedShows}
      />
    );
  }

  // Live — harbor always on, optional single beds playlist
  if (segType === 'live') {
    const bedPlaylists = playlists.filter(
      (p) => playlistMediaCategory(p.type as any, p.subcategory as any) === 'bed' && (p.total_seconds ?? 0) > 0,
    );
    const currentBedId = (sources.find((s) => s.type === 'playlist') as Extract<SegmentSourceEntry, { type: 'playlist' }> | undefined)?.playlist_id ?? null;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 py-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
          <span className="text-sm text-zinc-400">Harbor (live input)</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-400 w-10 flex-shrink-0">Beds</span>
          <select
            value={currentBedId ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) onChange([{ type: 'live' }]);
              else onChange([{ type: 'live' }, { type: 'playlist', playlist_id: Number(v), weight: 1, hot_play: false, heavy_rotation: false }]);
            }}
            className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
          >
            <option value="" className="bg-zinc-900">None</option>
            {bedPlaylists.map((p) => (
              <option key={p.id} value={p.id} className="bg-zinc-900">{p.name}</option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  // Other live types — harbor is implicit, nothing to configure
  if (IMPLICIT_LIVE_TYPES.includes(segType)) {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="text-sm text-zinc-400">Harbor (live input)</span>
      </div>
    );
  }

  // News / Bulletin — single source, either harbor or recording (mutually exclusive)
  if (segType === 'news' || segType === 'bulletin') {
    const currentType = (sources[0]?.type ?? 'live') as 'live' | 'recording';
    const bedPlaylists = playlists.filter(
      (p) => playlistMediaCategory(p.type as any, p.subcategory as any) === 'bed' && (p.total_seconds ?? 0) > 0,
    );
    const currentBedId = currentType === 'live'
      ? (sources.find((s) => s.type === 'playlist') as Extract<SegmentSourceEntry, { type: 'playlist' }> | undefined)?.playlist_id ?? null
      : null;
    return (
      <div className="space-y-3">
        <select
          value={currentType}
          onChange={(e) => onChange([makeDefaultSource(e.target.value as 'live' | 'recording')])}
          className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
        >
          <option value="live" className="bg-zinc-900">Harbor (live)</option>
          <option value="recording" className="bg-zinc-900">Recording</option>
        </select>
        {currentType === 'live' && (
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-10 flex-shrink-0">Beds</span>
            <select
              value={currentBedId ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) onChange([{ type: 'live' }]);
                else onChange([{ type: 'live' }, { type: 'playlist', playlist_id: Number(v), weight: 1, hot_play: false, heavy_rotation: false }]);
              }}
              className="flex-1 px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-indigo-500"
            >
              <option value="" className="bg-zinc-900">None</option>
              {bedPlaylists.map((p) => (
                <option key={p.id} value={p.id} className="bg-zinc-900">{p.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
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

  // Fallback multi-source list (all segment types are currently handled above)
  const validTypes = VALID_SOURCE_TYPES[segType as ClockSegmentType];
  const showWeight = false;

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
      const candidates = cats.length ? playlists.filter((p) => cats.includes(playlistMediaCategory(p.type as any, p.subcategory as any))) : playlists;
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
  const bedPlaylistCapped = (segType === 'live') &&
    sources.filter((s) => s.type === 'playlist').length >= 1;
  const cats = playlistCategoriesForSegType(segType);
  const eligiblePlaylists = cats.length ? playlists.filter((p) => cats.includes(playlistMediaCategory(p.type as any, p.subcategory as any))) : playlists;
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

function classifyStopSetSources(sources: SegmentSourceEntry[]) {
  let campaignsEnabled = false;
  let campaignsRotation: SimpleRotationType | undefined;
  let promosEnabled = false;
  let promosRotation: SimpleRotationType | undefined;

  for (const s of sources) {
    if (s.type === 'campaigns') {
      campaignsEnabled = true;
      campaignsRotation = s.rotation;
    } else if (s.type === 'promos') {
      promosEnabled = true;
      promosRotation = s.rotation;
    }
  }
  return { campaignsEnabled, campaignsRotation, promosEnabled, promosRotation };
}

function StopSetSourcesEditor({
  sources, onChange,
}: {
  sources: SegmentSourceEntry[];
  onChange: (sources: SegmentSourceEntry[]) => void;
  playlists: PlaylistSummary[];
}) {
  const state = classifyStopSetSources(sources);

  const buildSources = (next: typeof state): SegmentSourceEntry[] => {
    const out: SegmentSourceEntry[] = [];
    if (next.campaignsEnabled) out.push({ type: 'campaigns', rotation: next.campaignsRotation });
    if (next.promosEnabled)    out.push({ type: 'promos', weight: 1, rotation: next.promosRotation });
    return out;
  };

  const updateState = (patch: Partial<typeof state>) => onChange(buildSources({ ...state, ...patch }));

  return (
    <div className="space-y-3">
      <StopSetSlot
        title="Campaigns"
        enabled={state.campaignsEnabled}
        rotation={state.campaignsRotation}
        onToggle={(v) => updateState({ campaignsEnabled: v })}
        onRotationChange={(r) => updateState({ campaignsRotation: r })}
      />
      <StopSetSlot
        title="Promos"
        enabled={state.promosEnabled}
        rotation={state.promosRotation}
        onToggle={(v) => updateState({ promosEnabled: v })}
        onRotationChange={(r) => updateState({ promosRotation: r })}
      />
    </div>
  );
}

function StopSetSlot({
  title, enabled, rotation,
  onToggle, onRotationChange,
}: {
  title: string;
  enabled: boolean;
  rotation: SimpleRotationType | undefined;
  onToggle: (v: boolean) => void;
  onRotationChange: (r: SimpleRotationType | undefined) => void;
}) {
  return (
    <div className="bg-zinc-900 rounded border border-zinc-800 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <label className="flex items-center gap-2 cursor-pointer select-none flex-1">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-indigo-500 cursor-pointer"
          />
          <span className="text-xs font-medium text-zinc-300">{title}</span>
        </label>
        {enabled && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Rotation</span>
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
        )}
      </div>
    </div>
  );
}

function getSourceLabel(type: SegmentSourceEntry['type'], segType: ClockSegmentType): string {
  if (type === 'playlist' && (segType === 'live')) return 'Beds playlist';
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
    return playlistMediaCategory(pl.type as any, pl.subcategory as any) === 'spot' ? 'playlist_spot' : 'playlist_promo';
  }, [segType, source, playlists]);

  const [stopSetVariant, setStopSetVariant] = useState<'playlist_promo' | 'playlist_spot'>('playlist_promo');

  useEffect(() => {
    if (derivedVariant !== null) setStopSetVariant(derivedVariant);
  }, [derivedVariant]);

  // Playlist category filter for the dropdown
  const playlistCategories: string[] = (() => {
    if (segType === 'music') return ['music'];
    if (segType === 'live') return ['bed'];
    if (segType === 'stop_set') return stopSetVariant === 'playlist_spot' ? ['spot'] : ['promo'];
    return [];
  })();

  const typeSelectorValue = segType === 'stop_set' && isPlaylist ? stopSetVariant : source.type;

  const handleTypeChange = (val: string) => {
    if (val === 'playlist_promo') {
      setStopSetVariant('playlist_promo');
      const first = playlists.find(p => playlistMediaCategory(p.type as any, p.subcategory as any) === 'promo');
      onChange({ type: 'playlist', playlist_id: first?.id ?? 0, weight: 1, hot_play: false, heavy_rotation: false });
    } else if (val === 'playlist_spot') {
      setStopSetVariant('playlist_spot');
      const first = playlists.find(p => playlistMediaCategory(p.type as any, p.subcategory as any) === 'spot');
      onChange({ type: 'playlist', playlist_id: first?.id ?? 0, weight: 1, hot_play: false, heavy_rotation: false });
    } else if (val === 'playlist') {
      const cats = playlistCategoriesForSegType(segType);
      const candidates = cats.length
        ? playlists.filter(p => cats.includes(playlistMediaCategory(p.type as any, p.subcategory as any)))
        : playlists;
      const first = candidates[0];
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
              <span className="text-xs text-zinc-300">Per hour</span>
              <input type="number" min={0} max={20} value={config.per_hour}
                onChange={(e) => update({ per_hour: Math.max(0, Math.min(20, parseInt(e.target.value) || 0)) })}
                className="w-14 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-300">Min gap</span>
              <input type="number" min={1} value={config.min_gap_minutes}
                onChange={(e) => update({ min_gap_minutes: Math.max(1, parseInt(e.target.value) || 1) })}
                className="w-14 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white focus:outline-none focus:border-indigo-500 text-center"
              />
              <span className="text-xs text-zinc-300">min</span>
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
                    <span className="text-xs text-zinc-300">wt</span>
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

function ClockActions({ dirty, isPending, confirmDelete, slotCount, assignedShows, onSave, onDiscard, onDeleteRequest, onDeleteConfirm, onDeleteCancel, row }: {
  dirty: boolean; isPending: boolean; confirmDelete: boolean; slotCount?: number;
  assignedShows?: { id: number; name: string }[];
  row?: boolean;
  onSave: () => void; onDiscard: () => void;
  onDeleteRequest: () => void; onDeleteConfirm: () => void; onDeleteCancel: () => void;
}) {
  const blocked = (assignedShows?.length ?? 0) > 0;
  return (
    <div className={`flex ${row ? 'flex-row' : 'flex-col'} items-center gap-2`}>
      <button
        onClick={onSave}
        disabled={!dirty || isPending}
        className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-default"
      >
        {isPending ? 'Saving…' : 'Save'}
      </button>
      <button
        onClick={onDiscard}
        disabled={!dirty}
        className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-default"
      >
        Discard
      </button>
      {confirmDelete ? (
        blocked ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-red-400 leading-tight">
              Assigned to {assignedShows!.slice(0, 2).map((s) => s.name).join(', ')}
              {assignedShows!.length > 2 ? ` +${assignedShows!.length - 2} more` : ''}.
              Remove first.
            </span>
            <button onClick={onDeleteCancel} className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">OK</button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {!!slotCount && (
              <span className="text-[11px] text-amber-400 leading-tight">
                {slotCount} slot{slotCount !== 1 ? 's' : ''} orphaned.
              </span>
            )}
            <span className="text-xs text-zinc-400">Delete?</span>
            <button onClick={onDeleteConfirm} className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors">Yes</button>
            <button onClick={onDeleteCancel} className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors">Cancel</button>
          </div>
        )
      ) : (
        <button onClick={onDeleteRequest} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded-lg transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      )}
    </div>
  );
}

function Field({ label, hint, tooltip, className, children }: { label: string; hint?: string; tooltip?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1">
        {label}{tooltip && <HelpTooltip text={tooltip} />}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-400">{hint}</p>}
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

function PlaylistDropdown({ value, onChange, playlists, categories, filter, invalid, allowNone = true }: {
  value: number | null;
  onChange: (v: number | null) => void;
  playlists: PlaylistSummary[];
  categories?: string[];
  filter?: (p: PlaylistSummary) => boolean;
  invalid?: boolean;
  allowNone?: boolean;
}) {
  const byCategory = categories?.length
    ? playlists.filter(p => categories.includes(playlistMediaCategory(p.type as any, p.subcategory as any)))
    : playlists;
  const nonEmpty = byCategory.filter(p => (p.total_seconds ?? 0) > 0 || p.kind === 'dynamic');
  const filtered = filter ? nonEmpty.filter(filter) : nonEmpty;
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

// ─── DriftOrderList ───────────────────────────────────────────────────────────
// Drag-to-reorder list for catching-up / coasting event type preferences.
// Checked items are active (in order); unchecked items are available but inactive.

function DriftOrderList({
  allTypes,
  order,
  onChange,
}: {
  allTypes: DriftEventType[];
  order: DriftEventType[];
  onChange: (next: DriftEventType[]) => void;
}) {
  const activeItems = order.filter((t) => allTypes.includes(t));
  const inactiveItems = allTypes.filter((t) => !activeItems.includes(t));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = activeItems.indexOf(active.id as DriftEventType);
    const newIdx = activeItems.indexOf(over.id as DriftEventType);
    onChange([...arrayMove(activeItems, oldIdx, newIdx), ...inactiveItems.filter((t) => order.includes(t))]);
  };

  const toggle = (type: DriftEventType, checked: boolean) => {
    if (checked) {
      onChange([...activeItems, type]);
    } else {
      onChange(activeItems.filter((t) => t !== type));
    }
  };

  return (
    <div className="space-y-1">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={activeItems} strategy={verticalListSortingStrategy}>
          {activeItems.map((type, idx) => (
            <DriftOrderRow key={type} type={type} active index={idx + 1} onToggle={(c) => toggle(type, c)} />
          ))}
        </SortableContext>
      </DndContext>
      {inactiveItems.map((type) => (
        <DriftOrderRow key={type} type={type} active={false} onToggle={(c) => toggle(type, c)} />
      ))}
    </div>
  );
}

function DriftOrderRow({
  type, active, index, onToggle,
}: {
  type: DriftEventType;
  active: boolean;
  index?: number;
  onToggle: (checked: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: type,
    disabled: !active,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className={`flex items-center gap-2 px-2 py-1.5 rounded ${active ? 'bg-zinc-800/60' : 'bg-transparent'}`}
    >
      {active ? (
        <button type="button" {...attributes} {...listeners}
          className="text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing">
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      ) : (
        <div className="w-3.5 h-3.5" />
      )}
      <input
        type="checkbox"
        checked={active}
        onChange={(e) => onToggle(e.target.checked)}
        className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500"
      />
      {active && index !== undefined && (
        <span className="text-xs text-zinc-400 w-3 text-right shrink-0">{index}.</span>
      )}
      <span className={`text-xs ${active ? 'text-zinc-200' : 'text-zinc-400'}`}>
        {DRIFT_EVENT_LABELS[type]}
      </span>
    </div>
  );
}
