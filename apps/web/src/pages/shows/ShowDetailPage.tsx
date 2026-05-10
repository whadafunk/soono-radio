import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { ChevronLeft, BarChart2, Megaphone, Music2, Bell, Lock } from 'lucide-react';
import { ShowPatch, ShowPatchSchema, ShowColor, ShowType, SHOW_COLORS, SHOW_TYPES } from '@radio/shared';
import { fetchShow, updateShow, fetchClocks, fetchTemplateEntries } from '../../api';

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_HEX: Record<ShowColor, string> = {
  indigo: '#818cf8', violet: '#a78bfa', cyan:    '#22d3ee', emerald: '#34d399',
  amber:  '#fbbf24', rose:   '#fb7185', orange:  '#fb923c', teal:    '#2dd4bf',
};
const COLOR_DOT: Record<ShowColor, string> = {
  indigo: 'bg-indigo-500', violet: 'bg-violet-500', cyan:    'bg-cyan-500',    emerald: 'bg-emerald-500',
  amber:  'bg-amber-500',  rose:   'bg-rose-500',   orange:  'bg-orange-500',  teal:    'bg-teal-500',
};
const TYPE_LABEL: Record<ShowType, string> = {
  live: 'Live', automated: 'Automated', prerecorded: 'Prerecorded',
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

  const updateMutation = useMutation({
    mutationFn: (patch: ShowPatch) => updateShow(showId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      qc.invalidateQueries({ queryKey: ['shows', showId] });
      reset(undefined, { keepValues: true });
    },
  });

  const { register, handleSubmit, watch, setValue, reset, control, formState: { isDirty, errors } } = useForm<ShowPatch>({
    resolver: zodResolver(ShowPatchSchema),
  });

  useEffect(() => {
    if (show) {
      reset({
        name:             show.name,
        host:             show.host ?? '',
        producer:         show.producer ?? '',
        type:             show.type,
        default_clock_id: show.default_clock_id,
        duration_minutes: show.duration_minutes,
        color:            show.color,
        notes:            show.notes ?? '',
        active:           show.active,
      });
    }
  }, [show, reset]);

  const selectedColor    = watch('color') ?? show?.color;
  const selectedDuration = watch('duration_minutes') ?? show?.duration_minutes ?? 60;
  const selectedActive   = watch('active') ?? show?.active;

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

  return (
    <div className="pb-10">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link
            to="/shows"
            className="p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
          </Link>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: hex }} />
            <h1 className="text-lg font-semibold text-white">{show.name}</h1>
          </div>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${
            show.active
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-zinc-700/50 text-zinc-400 border-zinc-600/30'
          }`}>
            {show.active ? 'Active' : 'Inactive'}
          </span>
        </div>

        {isDirty && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => reset()}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
            >
              Discard
            </button>
            <button
              form="show-detail-form"
              type="submit"
              disabled={updateMutation.isPending}
              className="px-4 py-1.5 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex gap-6 items-start">

        {/* ── Left column: editable fields ── */}
        <form
          id="show-detail-form"
          onSubmit={handleSubmit(onSubmit)}
          className="flex-1 min-w-0 space-y-5"
        >
            {/* Name */}
            <Field label="Name" error={errors.name?.message}>
              <input
                {...register('name')}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </Field>

            {/* Host + Producer */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Host">
                <input
                  {...register('host')}
                  placeholder="—"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
              </Field>
              <Field label="Producer">
                <input
                  {...register('producer')}
                  placeholder="—"
                  className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
                />
              </Field>
            </div>

            {/* Type */}
            <Field label="Type">
              <select
                {...register('type')}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                {SHOW_TYPES.map((t) => (
                  <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                ))}
              </select>
            </Field>

            {/* Duration slider */}
            <Field label={`Duration — ${formatDuration(selectedDuration)}`}>
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

            {/* Clock */}
            <Field label="Default Clock">
              <Controller
                control={control}
                name="default_clock_id"
                render={({ field }) => (
                  <select
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">None</option>
                    {clocks.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              />
            </Field>

            {/* Color */}
            <Field label="Color">
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

            {/* Notes */}
            <Field label="Notes">
              <textarea
                {...register('notes')}
                rows={3}
                placeholder="Optional notes"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </Field>

            {/* Active toggle */}
            <div className="flex items-center justify-between py-2 border-t border-zinc-800">
              <span className="text-sm font-medium text-zinc-300">Active</span>
              <button
                type="button"
                onClick={() => setValue('active', !selectedActive, { shouldDirty: true })}
                className={`relative w-9 h-5 rounded-full transition-colors ${selectedActive ? 'bg-indigo-600' : 'bg-zinc-700'}`}
              >
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${selectedActive ? 'left-4' : 'left-0.5'}`} />
              </button>
            </div>

            {/* ── Playlists ── */}
            <section className="border-t border-zinc-800 pt-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Playlists</h2>
                <button
                  type="button"
                  disabled
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-500 border border-zinc-700 rounded-md opacity-50 cursor-not-allowed"
                >
                  <Music2 className="w-3 h-3" /> Add
                </button>
              </div>
              <div className="rounded-lg border border-zinc-800 border-dashed px-4 py-6 text-center text-zinc-500 text-sm">
                No playlists assigned
              </div>
            </section>

            {/* ── Jingles ── */}
            <section className="border-t border-zinc-800 pt-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Jingles</h2>
                <button
                  type="button"
                  disabled
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-500 border border-zinc-700 rounded-md opacity-50 cursor-not-allowed"
                >
                  <Bell className="w-3 h-3" /> Add
                </button>
              </div>
              <div className="rounded-lg border border-zinc-800 border-dashed px-4 py-6 text-center text-zinc-500 text-sm">
                No jingles assigned
              </div>
            </section>
          </form>

        {/* ── Right column: info panels ── */}
        <div className="w-64 flex-shrink-0 space-y-4">

            {/* This week */}
            <Panel title="This Week">
              {showEntries.length === 0 ? (
                <p className="text-xs text-zinc-500 py-2">Not scheduled this week</p>
              ) : (
                <ul className="space-y-1">
                  {showEntries.map((entry) => {
                    const day = weekDays[entry.day_of_week - 1];
                    return (
                      <li key={entry.id} className="flex items-center justify-between text-xs">
                        <span className="text-zinc-300 font-medium">
                          {DAY_NAMES[entry.day_of_week - 1]} {day.getDate()}
                        </span>
                        <span className="text-zinc-400 font-mono">
                          {entry.time_start}–{entry.time_end}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            {/* Campaigns — coming soon */}
            <Panel
              title="Campaigns"
              icon={<Megaphone className="w-3.5 h-3.5" />}
              locked
            >
              <p className="text-xs text-zinc-500 leading-relaxed">
                Advertising campaigns associated with this show will appear here.
              </p>
            </Panel>

            {/* Statistics — coming soon */}
            <Panel
              title="Statistics"
              icon={<BarChart2 className="w-3.5 h-3.5" />}
              locked
            >
              <p className="text-xs text-zinc-500 leading-relaxed">
                Ratings, play counts, and profitability metrics will appear here.
              </p>
            </Panel>

        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>
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
