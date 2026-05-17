import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, BarChart2, Megaphone, Music2, Bell, Lock,
  Trash2, Plus, Upload, X, Loader2,
} from 'lucide-react';
import {
  ShowPatch, ShowPatchSchema, ShowColor, SHOW_COLORS,
  EXTENSION_POLICIES, ExtensionPolicy,
  ShowPlaylist, Rotation, SupervisorConfig,
} from '@radio/shared';
import { Media } from '@radio/shared';
import {
  fetchShow, updateShow, deleteShow, fetchClocks, fetchTemplateEntries,
  fetchShowPlaylists, addShowPlaylist, updateShowPlaylist, removeShowPlaylist,
  fetchPlaylists, fetchLibrary, fetchLibraryItem, fetchIngestJob,
  uploadLibraryFiles, fetchRotations, fetchShowCampaigns, fetchSupervisorConfig,
} from '../../api';
import type { PlaylistSummary, ShowCampaign } from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';
import { BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM, INPUT, SELECT } from '../../ui';

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_HEX: Record<ShowColor, string> = {
  indigo: '#818cf8', violet: '#a78bfa', cyan:    '#22d3ee', emerald: '#34d399',
  amber:  '#fbbf24', rose:   '#fb7185', orange:  '#fb923c', teal:    '#2dd4bf',
};
const COLOR_DOT: Record<ShowColor, string> = {
  indigo: 'bg-indigo-500', violet: 'bg-violet-500', cyan:    'bg-cyan-500',    emerald: 'bg-emerald-500',
  amber:  'bg-amber-500',  rose:   'bg-rose-500',   orange:  'bg-orange-500',  teal:    'bg-teal-500',
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DURATION_STEP = 15;
const DURATION_MIN  = 30;
const DURATION_MAX  = 720;

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ShowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const showId = Number(id);

  const { data: show, isLoading } = useQuery({
    queryKey: ['shows', showId],
    queryFn: () => fetchShow(showId),
    enabled: !isNaN(showId),
  });
  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });
  const { data: templateEntries = [] } = useQuery({ queryKey: ['template-entries'], queryFn: fetchTemplateEntries });
  const { data: showMusicPlaylists = [] } = useQuery<ShowPlaylist[]>({
    queryKey: ['show-playlists', showId],
    queryFn: () => fetchShowPlaylists(showId),
    enabled: !isNaN(showId),
  });
  const { data: allPlaylists = [] } = useQuery<PlaylistSummary[]>({
    queryKey: ['playlists'],
    queryFn: fetchPlaylists,
  });

  const { data: showCampaigns = [] } = useQuery<ShowCampaign[]>({
    queryKey: ['show-campaigns', showId],
    queryFn: () => fetchShowCampaigns(showId),
    enabled: !isNaN(showId),
  });

  const { data: supervisorConfig } = useQuery<SupervisorConfig>({
    queryKey: ['supervisor-config'],
    queryFn: fetchSupervisorConfig,
  });

  const [activeTab, setActiveTab] = useState<'configuration' | 'media-content'>('configuration');

  const updateMutation = useMutation({
    mutationFn: (patch: ShowPatch) => updateShow(showId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      qc.invalidateQueries({ queryKey: ['shows', showId] });
      reset(undefined, { keepValues: true });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteShow(showId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      navigate('/shows');
    },
  });

  const { register, handleSubmit, watch, setValue, reset, control, formState: { isDirty, errors } } = useForm<ShowPatch>({
    resolver: zodResolver(ShowPatchSchema),
  });

  useEffect(() => {
    if (show) {
      reset({
        name:               show.name,
        host:               show.host ?? '',
        producer:           show.producer ?? '',
        default_clock_id:   show.default_clock_id,
        jingle_playlist_id: show.jingle_playlist_id,
        bed_playlist_id:    show.bed_playlist_id,
        intro_media_id:     show.intro_media_id,
        outro_media_id:     show.outro_media_id,
        duration_minutes:   show.duration_minutes,
        extension_policy:   show.extension_policy,
        color:              show.color,
        notes:              show.notes ?? '',
      });
    }
  }, [show, reset]);

  const selectedColor    = watch('color') ?? show?.color;
  const selectedDuration = watch('duration_minutes') ?? show?.duration_minutes ?? 60;

  const onSubmit = (data: ShowPatch) => {
    updateMutation.mutate({
      ...data,
      host:     data.host?.trim()     || null,
      producer: data.producer?.trim() || null,
      notes:    data.notes?.trim()    || null,
    });
  };

  const showEntries = templateEntries
    .filter((e) => e.show_id === showId)
    .sort((a, b) => a.day_of_week - b.day_of_week || a.time_start.localeCompare(b.time_start));

  const weekStart = getWeekStart(new Date());
  const weekDays  = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  // Compute next upcoming entry
  const now = new Date();
  const todayDow  = now.getDay() === 0 ? 7 : now.getDay();
  const todayTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nextEntryId = showEntries.find((e) => {
    if (e.day_of_week > todayDow) return true;
    if (e.day_of_week === todayDow && e.time_start > todayTime) return true;
    return false;
  })?.id ?? showEntries[0]?.id;

  if (isLoading) {
    return <div className="p-8 text-zinc-500 text-sm">Loading…</div>;
  }
  if (!show) {
    return (
      <div className="p-8 text-center">
        <p className="text-zinc-400 mb-4">Show not found.</p>
        <Link to="/shows" className="text-indigo-400 hover:text-indigo-300 text-sm">← Back to Shows</Link>
      </div>
    );
  }

  const hex = COLOR_HEX[selectedColor ?? show.color];

  const jinglePlaylists = allPlaylists.filter((p) => p.type === 'jingle');
  const bedPlaylists    = allPlaylists.filter((p) => p.type === 'bed');
  const musicPlaylists  = allPlaylists.filter((p) => p.type === 'music');
  const usedPlaylistIds = new Set(showMusicPlaylists.map((sp) => sp.playlist_id));

  return (
    <div className="pb-10 flex gap-6 items-start">

      {/* ── Left column ── */}
      <div className="flex-1 min-w-0 space-y-4">

        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/shows" className="text-zinc-400 hover:text-white transition-colors">
              <ChevronLeft className="w-5 h-5" />
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: hex }} />
              <h1 className="text-lg font-semibold text-white">{show.name}</h1>
              <span className="text-zinc-600 select-none">·</span>
              <span className="text-sm text-zinc-500">Show Details</span>
            </div>
            {showEntries.length > 0 ? (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                Scheduled
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full font-medium border bg-zinc-700/50 text-zinc-400 border-zinc-600/30">
                Unscheduled
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Delete "${show.name}"? This cannot be undone.`)) return;
                deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
              className={BTN_DESTRUCTIVE_SM}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
            <div className="w-px h-5 bg-zinc-700 mx-1" />
            <button
              type="button"
              onClick={() => reset()}
              disabled={!isDirty}
              className={BTN_SECONDARY_SM}
            >
              Discard
            </button>
            <button
              form="show-detail-form"
              type="submit"
              disabled={!isDirty || updateMutation.isPending}
              className={BTN_PRIMARY_SM}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>

        {/* ── Form card with tabs ── */}
        <form
          id="show-detail-form"
          onSubmit={handleSubmit(onSubmit)}
          className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden"
        >
          {/* Tab bar */}
          <div className="flex border-b border-zinc-800 px-6 pt-1">
            {(['configuration', 'media-content'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`mr-6 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === tab
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {tab === 'configuration' ? 'Configuration' : 'Media Content'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="p-6 space-y-5">
            {activeTab === 'configuration' ? (
              <>
                <Field label={<span className="flex items-center gap-1">Name <HelpTooltip text="The show's display name, used in the schedule, supervisor logs, and reports." /></span>} error={errors.name?.message}>
                  <input {...register('name')} className={INPUT} />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label={<span className="flex items-center gap-1">Host <HelpTooltip text="The on-air presenter. Appears in schedule views and exported metadata." /></span>}>
                    <input {...register('host')} placeholder="—" className={INPUT} />
                  </Field>
                  <Field label={<span className="flex items-center gap-1">Producer <HelpTooltip text="The behind-the-scenes producer. Informational only — not used by the scheduler." /></span>}>
                    <input {...register('producer')} placeholder="—" className={INPUT} />
                  </Field>
                </div>

                <Field label={<span className="flex items-center gap-1">Color <HelpTooltip text="Visual label used to identify this show in the schedule calendar." /></span>}>
                  <div className="flex gap-2 flex-wrap">
                    {SHOW_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setValue('color', color, { shouldDirty: true })}
                        className={`w-7 h-7 rounded-full ${COLOR_DOT[color]} transition-all ${
                          selectedColor === color
                            ? 'ring-2 ring-offset-2 ring-offset-zinc-950 ring-white scale-110'
                            : 'opacity-50 hover:opacity-90'
                        }`}
                      />
                    ))}
                  </div>
                </Field>

                <Field label={<span className="flex items-center gap-1">Notes <HelpTooltip text="Internal notes about the show. Not broadcast or shown to listeners." /></span>}>
                  <textarea
                    {...register('notes')}
                    rows={3}
                    placeholder="Optional notes"
                    className={`${INPUT} resize-none`}
                  />
                </Field>

                <section className="border-t border-zinc-800 pt-5 space-y-5">
                  <Field label={<span className="flex items-center gap-1">{`Duration — ${formatDuration(selectedDuration)}`} <HelpTooltip text="How long the show runs. The supervisor uses this to determine how many clock hours to schedule." /></span>}>
                    <Controller
                      control={control}
                      name="duration_minutes"
                      render={({ field }) => (
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-zinc-500 w-8 text-right">{formatDuration(DURATION_MIN)}</span>
                          <input
                            type="range"
                            min={DURATION_MIN}
                            max={DURATION_MAX}
                            step={DURATION_STEP}
                            value={field.value ?? show.duration_minutes}
                            onChange={(e) => field.onChange(Number(e.target.value))}
                            className="flex-1 accent-indigo-500"
                          />
                          <span className="text-xs text-zinc-500 w-8">{formatDuration(DURATION_MAX)}</span>
                        </div>
                      )}
                    />
                  </Field>

                  <Field label={<span className="flex items-center gap-1">Assigned Clock <HelpTooltip text="The default clock template for this show. Controls which segments play — music, jingles, spots, sweepers — unless a per-slot override is set on the schedule." /></span>}>
                    <Controller
                      control={control}
                      name="default_clock_id"
                      render={({ field }) => (
                        <select
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))}
                          className={SELECT}
                        >
                          <option value="">None</option>
                          {clocks.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}
                    />
                  </Field>

                  <Field
                    label={
                      <span className="flex items-center gap-1">
                        Extension policy
                        <HelpTooltip text={<>What to play when no clock covers part of the show's scheduled time — e.g. a DJ runs over. <span className="font-semibold text-white">Repeat last clock</span> tiles the last assigned clock again; <span className="font-semibold text-white">Fall through</span> keeps playing content sources without clock structure.</>} />
                      </span>
                    }
                  >
                    <Controller
                      control={control}
                      name="extension_policy"
                      render={({ field }) => (
                        <select
                          value={field.value ?? ''}
                          onChange={(e) => field.onChange(e.target.value === '' ? null : e.target.value as ExtensionPolicy)}
                          className={SELECT}
                        >
                          <option value="">
                            Station default — {supervisorConfig?.extension_policy === 'fall_through' ? 'Fall through' : 'Repeat last clock'}
                          </option>
                          {EXTENSION_POLICIES.map((p) => (
                            <option key={p} value={p} className="bg-zinc-900">
                              {p === 'repeat_last_clock' ? 'Repeat last clock' : 'Fall through'}
                            </option>
                          ))}
                        </select>
                      )}
                    />
                  </Field>
                </section>
              </>
            ) : (
              <>
                <section className="space-y-4">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Intro &amp; Outro</h2>
                  <Controller
                    control={control}
                    name="intro_media_id"
                    render={({ field }) => (
                      <MediaPickerField
                        label={<span className="flex items-center gap-1">Intro clip <HelpTooltip text="Audio played at the very start of the show, before the first scheduled segment begins." /></span>}
                        value={field.value ?? null}
                        onChange={(v) => { field.onChange(v); setValue('intro_media_id', v, { shouldDirty: true }); }}
                      />
                    )}
                  />
                  <Controller
                    control={control}
                    name="outro_media_id"
                    render={({ field }) => (
                      <MediaPickerField
                        label={<span className="flex items-center gap-1">Outro clip <HelpTooltip text="Audio played at the very end of the show, after the last scheduled segment finishes." /></span>}
                        value={field.value ?? null}
                        onChange={(v) => { field.onChange(v); setValue('outro_media_id', v, { shouldDirty: true }); }}
                      />
                    )}
                  />
                </section>

                <section className="border-t border-zinc-800 pt-5">
                  <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">Show Jingles <HelpTooltip text="Jingle playlist specific to this show. These play at jingle positions defined in the assigned clock, overriding the station's default jingle playlist." /></h2>
                  <Controller
                    control={control}
                    name="jingle_playlist_id"
                    render={({ field }) => (
                      <PlaylistSelect
                        playlists={jinglePlaylists}
                        value={field.value ?? null}
                        onChange={(v) => { field.onChange(v); setValue('jingle_playlist_id', v, { shouldDirty: true }); }}
                        placeholder="No jingle playlist assigned"
                      />
                    )}
                  />
                </section>

                <section className="border-t border-zinc-800 pt-5">
                  <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">Show Beds <HelpTooltip text="Music bed playlist for this show. Beds play as background audio under DJ talk segments when bed playback is enabled in the clock." /></h2>
                  <Controller
                    control={control}
                    name="bed_playlist_id"
                    render={({ field }) => (
                      <PlaylistSelect
                        playlists={bedPlaylists}
                        value={field.value ?? null}
                        onChange={(v) => { field.onChange(v); setValue('bed_playlist_id', v, { shouldDirty: true }); }}
                        placeholder="No bed playlist assigned"
                      />
                    )}
                  />
                </section>

                <MusicPlaylistsSection
                  showId={showId}
                  showMusicPlaylists={showMusicPlaylists}
                  availablePlaylists={musicPlaylists}
                  usedPlaylistIds={usedPlaylistIds}
                />
              </>
            )}
          </div>
        </form>
      </div>

      {/* ── Right column: info panels ── */}
      <div className="w-64 flex-shrink-0 space-y-4">

        <Panel title="This Week">
          {showEntries.length === 0 ? (
            <p className="text-xs text-zinc-500 py-2">Not scheduled this week</p>
          ) : (
            <ul className="space-y-1">
              {showEntries.map((entry) => {
                const day = weekDays[entry.day_of_week - 1];
                const isNext = entry.id === nextEntryId;
                return (
                  <li
                    key={entry.id}
                    className={`flex items-center justify-between text-xs rounded px-1.5 py-0.5 -mx-1.5 ${
                      isNext ? 'bg-indigo-500/10 text-indigo-300' : ''
                    }`}
                  >
                    <span className={`font-medium ${isNext ? 'text-indigo-200' : 'text-zinc-300'}`}>
                      {DAY_NAMES[entry.day_of_week - 1]} {day.getDate()}
                      {isNext && <span className="ml-1 text-indigo-400 text-[10px]">next</span>}
                    </span>
                    <span className={`font-mono ${isNext ? 'text-indigo-300' : 'text-zinc-400'}`}>
                      {entry.time_start}–{entry.time_end}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Campaigns" icon={<Megaphone className="w-3.5 h-3.5" />}>
          {showCampaigns.length === 0 ? (
            <p className="text-xs text-zinc-500 py-1">No campaigns linked to this show.</p>
          ) : (
            <ul className="space-y-2">
              {showCampaigns.map((c) => (
                <li key={c.id} className="text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className={`font-medium truncate ${c.active ? 'text-zinc-200' : 'text-zinc-500 line-through'}`}>{c.name}</span>
                    {c.plays_per_show != null && (
                      <span className="flex-shrink-0 text-indigo-400 font-mono">{c.plays_per_show}×</span>
                    )}
                  </div>
                  <span className="text-zinc-500">{c.customer_name}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Statistics" icon={<BarChart2 className="w-3.5 h-3.5" />} locked>
          <p className="text-xs text-zinc-500 leading-relaxed">
            Ratings, play counts, and profitability metrics will appear here.
          </p>
        </Panel>

      </div>
    </div>
  );
}

// ─── Music Playlists Section ──────────────────────────────────────────────────

function MusicPlaylistsSection({
  showId, showMusicPlaylists, availablePlaylists, usedPlaylistIds,
}: {
  showId: number;
  showMusicPlaylists: ShowPlaylist[];
  availablePlaylists: PlaylistSummary[];
  usedPlaylistIds: Set<number>;
}) {
  const qc = useQueryClient();
  const [addingId, setAddingId] = useState<number | ''>('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const { data: rotations = [] } = useQuery<Rotation[]>({
    queryKey: ['rotations'],
    queryFn: fetchRotations,
  });

  const addMutation = useMutation({
    mutationFn: (playlistId: number) =>
      addShowPlaylist(showId, { playlist_id: playlistId, weight: 1 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['show-playlists', showId] });
      setAddingId('');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (spid: number) => removeShowPlaylist(showId, spid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['show-playlists', showId] }),
  });

  const weightMutation = useMutation({
    mutationFn: ({ spid, weight }: { spid: number; weight: number }) =>
      updateShowPlaylist(showId, spid, { weight }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['show-playlists', showId] }),
  });

  const rotationMutation = useMutation({
    mutationFn: ({ spid, rotation_id }: { spid: number; rotation_id: number | null }) =>
      updateShowPlaylist(showId, spid, { rotation_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['show-playlists', showId] }),
  });

  const tierMutation = useMutation({
    mutationFn: ({ spid, rotation_tier }: { spid: number; rotation_tier: string | null }) =>
      updateShowPlaylist(showId, spid, { rotation_tier }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['show-playlists', showId] }),
  });

  const fallbackTierMutation = useMutation({
    mutationFn: ({ spid, fallback_tier }: { spid: number; fallback_tier: string | null }) =>
      updateShowPlaylist(showId, spid, { fallback_tier }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['show-playlists', showId] }),
  });

  const unassigned = availablePlaylists.filter((p) => !usedPlaylistIds.has(p.id));

  // Unique tier names already in use on this show — drives the fallback_tier datalist
  // so operators pick an existing tier rather than mistyping one that doesn't exist.
  const tiersInUse = Array.from(
    new Set(
      showMusicPlaylists
        .map((sp) => sp.rotation_tier)
        .filter((t): t is string => !!t && t.trim() !== ''),
    ),
  ).sort();

  return (
    <section className="border-t border-zinc-800 pt-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">Show Music <HelpTooltip text="Music playlists assigned to this show. Weight controls relative pick probability — a playlist with weight 2 is picked twice as often as one with weight 1." /></h2>
      </div>

      {showMusicPlaylists.length === 0 && unassigned.length === 0 && (
        <p className="text-xs text-zinc-500 italic mb-3">No music playlists in library yet.</p>
      )}

      {showMusicPlaylists.length > 0 && (
        <ul className="space-y-1.5 mb-3">
          {showMusicPlaylists.map((sp) => {
            const expanded = expandedIds.has(sp.id);
            return (
              <li key={sp.id} className="bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                {/* Summary row — click to expand */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-zinc-800 rounded-lg transition-colors"
                  onClick={() => toggleExpanded(sp.id)}
                >
                  <ChevronRight className={`w-3.5 h-3.5 text-zinc-500 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                  <span className="flex-1 text-sm text-zinc-200 truncate">{sp.playlist_name}</span>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <span className="flex items-center gap-0.5 text-xs text-zinc-500">wt <HelpTooltip text="Relative pick weight. A playlist with weight 2 is chosen twice as often as one with weight 1." /></span>
                    <input
                      type="number"
                      min={1}
                      max={99}
                      defaultValue={sp.weight}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (v >= 1 && v !== sp.weight) weightMutation.mutate({ spid: sp.id, weight: v });
                      }}
                      className="w-12 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-white text-center focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeMutation.mutate(sp.id); }}
                    className="p-0.5 text-zinc-600 hover:text-red-400 transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Expanded: rotation / tier controls */}
                {expanded && (
                  <div className="px-3 pb-3 pt-1 space-y-2 border-t border-zinc-700/50">
                    {rotations.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-0.5 text-xs text-zinc-500 w-16 shrink-0">Rotation <HelpTooltip text={<>Override the rotation rules applied when picking from this playlist. Leave as <span className="font-semibold text-white">Default</span> to use the station's global rotation settings.</>} /></span>
                        <select
                          value={sp.rotation_id ?? ''}
                          onChange={(e) => {
                            const v = e.target.value === '' ? null : Number(e.target.value);
                            rotationMutation.mutate({ spid: sp.id, rotation_id: v });
                          }}
                          className="flex-1 bg-zinc-800 border border-zinc-700/60 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
                        >
                          <option value="">Default</option>
                          {rotations.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 w-16 shrink-0">Tier</span>
                      <input
                        type="text"
                        defaultValue={sp.rotation_tier ?? ''}
                        placeholder="e.g. hot"
                        list="show-tiers-in-use"
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          const cur = sp.rotation_tier ?? '';
                          if (next === cur) return;
                          tierMutation.mutate({ spid: sp.id, rotation_tier: next === '' ? null : next });
                        }}
                        className="w-24 bg-zinc-800 border border-zinc-700/60 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
                      />
                      <span className="text-xs text-zinc-500">fallback</span>
                      <input
                        type="text"
                        defaultValue={sp.fallback_tier ?? ''}
                        placeholder="(none)"
                        list="show-tiers-in-use"
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          const cur = sp.fallback_tier ?? '';
                          if (next === cur) return;
                          fallbackTierMutation.mutate({ spid: sp.id, fallback_tier: next === '' ? null : next });
                        }}
                        className="w-24 bg-zinc-800 border border-zinc-700/60 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-indigo-500"
                      />
                      <HelpTooltip text="When this playlist's pool is exhausted (all tracks in separation or empty), the picker tries the tier you name here. Leave blank for no fallback. Tier names are free-form labels — keep them consistent across the show." />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
          <datalist id="show-tiers-in-use">
            {tiersInUse.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </ul>
      )}

      {unassigned.length > 0 && (
        <div className="flex items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value === '' ? '' : Number(e.target.value))}
            className={`flex-1 ${SELECT}`}
          >
            <option value="">Add a music playlist…</option>
            {unassigned.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={addingId === '' || addMutation.isPending}
            onClick={() => { if (addingId !== '') addMutation.mutate(Number(addingId)); }}
            className={BTN_PRIMARY_SM}
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      )}
    </section>
  );
}

// ─── Playlist Select (single, for jingles/beds) ───────────────────────────────

function PlaylistSelect({
  playlists, value, onChange, placeholder,
}: {
  playlists: PlaylistSummary[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder: string;
}) {
  if (playlists.length === 0) {
    return <p className="text-xs text-zinc-500 italic">{placeholder} — no matching playlists in library.</p>;
  }
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      className={SELECT}
    >
      <option value="">None</option>
      {playlists.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}

// ─── Media Picker Field (intro/outro) ─────────────────────────────────────────

function MediaPickerField({
  label, value, onChange,
}: {
  label: React.ReactNode;
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [uploadState, setUploadState] = useState<'idle' | 'uploading' | 'processing'>('idle');
  const [pollingJobId, setPollingJobId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: currentMedia } = useQuery<Media>({
    queryKey: ['media', value],
    queryFn: () => fetchLibraryItem(value!),
    enabled: value != null,
  });

  const { data: searchResults } = useQuery({
    queryKey: ['media-picker', query],
    queryFn: () => fetchLibrary({ q: query || undefined, category: 'jingle,intro,outro,promo', limit: 40 }),
    enabled: isOpen,
  });

  const { data: ingestJob } = useQuery({
    queryKey: ['ingest-job', pollingJobId],
    queryFn: () => fetchIngestJob(pollingJobId!),
    enabled: !!pollingJobId,
    refetchInterval: pollingJobId ? 2000 : false,
  });

  useEffect(() => {
    if (!ingestJob) return;
    if (ingestJob.status === 'completed' && ingestJob.media_id) {
      onChange(ingestJob.media_id);
      setPollingJobId(null);
      setUploadState('idle');
      setIsOpen(false);
    } else if (ingestJob.status === 'failed') {
      setPollingJobId(null);
      setUploadState('idle');
    }
  }, [ingestJob, onChange]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploadState('uploading');
    try {
      const { jobs } = await uploadLibraryFiles([file], 'jingle');
      setUploadState('processing');
      setPollingJobId(jobs[0].job_id);
    } catch {
      setUploadState('idle');
    }
  };

  const mediaLabel = currentMedia
    ? [currentMedia.title, currentMedia.artist].filter(Boolean).join(' — ') || currentMedia.original_filename
    : null;

  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>

      <div className="flex items-center gap-2">
        {/* Current selection display */}
        <div className="flex-1 flex items-center gap-2 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 min-w-0">
          {uploadState !== 'idle' ? (
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              {uploadState === 'uploading' ? 'Uploading…' : 'Processing…'}
            </span>
          ) : mediaLabel ? (
            <>
              <span className="text-sm text-zinc-200 truncate flex-1">{mediaLabel}</span>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="p-0.5 text-zinc-500 hover:text-zinc-300 flex-shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <span className="text-sm text-zinc-500 italic">None</span>
          )}
        </div>

        {/* Select button */}
        <button
          type="button"
          onClick={() => { setIsOpen((o) => !o); setQuery(''); }}
          className="px-2.5 py-2 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 rounded-lg transition-colors"
        >
          {isOpen ? 'Close' : 'Select'}
        </button>

        {/* Upload button */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploadState !== 'idle'}
          className="p-2 text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg transition-colors disabled:opacity-40"
          title="Upload a clip"
        >
          <Upload className="w-3.5 h-3.5" />
        </button>
        <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleFileChange} />
      </div>

      {/* Search dropdown */}
      {isOpen && (
        <div className="mt-1.5 border border-zinc-700 rounded-lg bg-zinc-900 overflow-hidden shadow-xl">
          <div className="p-2 border-b border-zinc-800">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search jingles, intros, promos…"
              className="w-full bg-zinc-800 rounded px-2.5 py-1.5 text-sm text-white placeholder-zinc-500 focus:outline-none"
            />
          </div>
          <ul className="max-h-48 overflow-y-auto divide-y divide-zinc-800/50">
            {(searchResults?.items ?? []).length === 0 ? (
              <li className="px-3 py-4 text-xs text-zinc-500 text-center">No results</li>
            ) : (
              searchResults?.items.map((item) => {
                const label = [item.title, item.artist].filter(Boolean).join(' — ') || item.original_filename;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => { onChange(item.id); setIsOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-zinc-800 transition-colors ${
                        item.id === value ? 'text-indigo-300 bg-indigo-500/10' : 'text-zinc-200'
                      }`}
                    >
                      <span className="truncate block">{label}</span>
                      <span className="text-xs text-zinc-500">{item.category}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, error, children }: { label: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center text-xs font-medium text-zinc-300 mb-1">{label}</label>
      {children}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}

function Panel({
  title, icon, locked = false, children,
}: {
  title: string;
  icon?: React.ReactNode;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-xl p-4 ${locked ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 mb-3">
        {icon && <span className="text-zinc-500">{icon}</span>}
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 flex-1">{title}</h2>
        {locked && <Lock className="w-3 h-3 text-zinc-600" />}
      </div>
      {children}
    </div>
  );
}
