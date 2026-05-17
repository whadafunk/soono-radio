import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Mic2, X, CalendarClock, ChevronUp, ChevronDown } from 'lucide-react';
import {
  ShowCreate, ShowCreateSchema,
  ShowColor, SHOW_COLORS,
  TemplateEntry,
} from '@radio/shared';
import { fetchShows, createShow, deleteShow, fetchTemplateEntries, fetchClocks } from '../../api';
import { BTN_PRIMARY, BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM, CARD, MODAL_OVERLAY, MODAL_BOX, INPUT, LABEL } from '../../ui';

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_META: Record<ShowColor, { dot: string; label: string }> = {
  indigo:  { dot: 'bg-indigo-500',  label: 'Indigo'  },
  violet:  { dot: 'bg-violet-500',  label: 'Violet'  },
  cyan:    { dot: 'bg-cyan-500',    label: 'Cyan'    },
  emerald: { dot: 'bg-emerald-500', label: 'Emerald' },
  amber:   { dot: 'bg-amber-500',   label: 'Amber'   },
  rose:    { dot: 'bg-rose-500',    label: 'Rose'    },
  orange:  { dot: 'bg-orange-500',  label: 'Orange'  },
  teal:    { dot: 'bg-teal-500',    label: 'Teal'    },
};

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getNextOccurrence(entries: TemplateEntry[]): string | null {
  if (entries.length === 0) return null;
  const now = new Date();
  const todayDow = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon…7=Sun
  const todayTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // Sort entries by day then time, look for the first one that hasn't passed yet
  const sorted = [...entries].sort(
    (a, b) => a.day_of_week - b.day_of_week || a.time_start.localeCompare(b.time_start),
  );

  const upcoming = sorted.find((e) => {
    if (e.day_of_week > todayDow) return true;
    if (e.day_of_week === todayDow && e.time_start > todayTime) return true;
    return false;
  });

  const hit = upcoming ?? sorted[0]; // wrap around to next week's first slot
  if (!hit) return null;
  return `${DAY_SHORT[hit.day_of_week - 1]} ${hit.time_start}`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type SortCol = 'name' | 'host' | 'clock' | 'duration' | 'next';

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function ShowsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const { data: shows = [], isLoading } = useQuery({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: templateEntries = [] } = useQuery({
    queryKey: ['template-entries'],
    queryFn: fetchTemplateEntries,
  });
  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });

  const createMutation = useMutation({
    mutationFn: (data: ShowCreate) => createShow(data),
    onSuccess: (newShow) => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      setShowModal(false);
      navigate(`/shows/${newShow.id}`);
    },
    onError: (err: Error) => showToast('error', err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => deleteShow(id))),
    onSuccess: (_, ids) => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      qc.invalidateQueries({ queryKey: ['template-entries'] });
      setSelectedIds(new Set());
      showToast('success', ids.length === 1 ? 'Show deleted' : `${ids.length} shows deleted`);
    },
    onError: (err: Error) => showToast('error', err.message),
  });

  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const clockById = useMemo(() => new Map(clocks.map((c) => [c.id, c.name])), [clocks]);

  const rows = useMemo(() => {
    const enriched = shows.map((show) => {
      const showEntries = templateEntries.filter((e) => e.show_id === show.id);
      const next = getNextOccurrence(showEntries);
      const clockName = show.default_clock_id != null ? (clockById.get(show.default_clock_id) ?? null) : null;
      return { show, showEntries, next, clockName };
    });

    const cmp = (a: typeof enriched[0], b: typeof enriched[0]): number => {
      let v = 0;
      if (sortCol === 'name')     v = a.show.name.localeCompare(b.show.name);
      if (sortCol === 'host')     v = (a.show.host ?? '').localeCompare(b.show.host ?? '');
      if (sortCol === 'clock')    v = (a.clockName ?? '').localeCompare(b.clockName ?? '');
      if (sortCol === 'duration') v = a.show.duration_minutes - b.show.duration_minutes;
      if (sortCol === 'next') {
        const toKey = (r: typeof enriched[0]) => r.next ?? 'ZZZ';
        v = toKey(a).localeCompare(toKey(b));
      }
      return sortDir === 'asc' ? v : -v;
    };
    return [...enriched].sort(cmp);
  }, [shows, templateEntries, clockById, sortCol, sortDir]);

  const allSelected = rows.length > 0 && rows.every((r) => selectedIds.has(r.show.id));
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(rows.map((r) => r.show.id)));

  const SortTh = ({ col, children }: { col: SortCol; children: React.ReactNode }) => {
    const active = sortCol === col;
    const Icon = active && sortDir === 'desc' ? ChevronDown : ChevronUp;
    return (
      <th
        className={`px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider border-r border-zinc-700 cursor-pointer select-none transition-colors ${
          active ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        onClick={() => handleSort(col)}
      >
        <span className="flex items-center gap-1">
          {children}
          <Icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-indigo-400' : 'text-zinc-400'}`} />
        </span>
      </th>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Shows</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const n = selectedIds.size;
              if (!window.confirm(`Delete ${n} show${n > 1 ? 's' : ''}? This cannot be undone.`)) return;
              deleteMutation.mutate([...selectedIds]);
            }}
            disabled={selectedIds.size === 0 || deleteMutation.isPending}
            title={selectedIds.size === 0 ? 'Select one or more shows to delete' : undefined}
            className={BTN_DESTRUCTIVE_SM}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
          <div className="w-px h-5 bg-zinc-700 mx-1" />
          <button onClick={() => setShowModal(true)} className={BTN_PRIMARY_SM}>
            <Plus className="w-3.5 h-3.5" />
            New Show
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg text-sm font-medium shadow-lg z-50 ${
          toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      {/* Table */}
      <div className={`${CARD} overflow-hidden`}>
        {isLoading ? (
          <div className="px-6 py-16 text-center text-zinc-400 text-sm">Loading shows…</div>
        ) : shows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Mic2 className="w-8 h-8 text-zinc-500 mx-auto mb-3" />
            <p className="text-zinc-400 text-sm">No shows yet — create your first show to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-zinc-800/60">
              <tr className="border-b border-zinc-700">
                <th className="px-4 py-3 w-12 border-r border-zinc-700">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <SortTh col="name">Name</SortTh>
                <SortTh col="host">Host</SortTh>
                <SortTh col="clock">Clock</SortTh>
                <SortTh col="duration">Duration</SortTh>
                <SortTh col="next">Next</SortTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {rows.map(({ show, next, clockName }) => {
                const cm = COLOR_META[show.color];
                const isSelected = selectedIds.has(show.id);
                return (
                  <tr
                    key={show.id}
                    className={`transition-colors cursor-pointer ${
                      isSelected ? 'bg-indigo-600/10' : 'hover:bg-zinc-800/40'
                    }`}
                    onClick={() => navigate(`/shows/${show.id}`)}
                  >
                    <td className="px-4 py-3 border-r border-zinc-800/60" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {}}
                        onClick={(e) => toggleSelect(show.id, e)}
                        className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-0 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${cm.dot} flex-shrink-0`} />
                        <span className="text-zinc-200 font-medium text-sm">{show.name}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {show.host
                        ? <span className="text-zinc-300 text-sm">{show.host}</span>
                        : <span className="text-zinc-500 italic text-sm">—</span>
                      }
                    </td>
                    <td className="px-4 py-3">
                      {clockName
                        ? <span className="text-zinc-300 text-sm">{clockName}</span>
                        : <span className="text-zinc-500 italic text-sm">—</span>
                      }
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-zinc-300 text-sm">{formatDuration(show.duration_minutes)}</span>
                    </td>
                    <td className="px-4 py-3">
                      {next ? (
                        <span className="flex items-center gap-1.5 text-xs text-zinc-300">
                          <CalendarClock className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                          {next}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-500 italic">Unscheduled</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* New show modal */}
      {showModal && (
        <ShowModal
          onClose={() => setShowModal(false)}
          onSave={(data) => createMutation.mutate(data)}
          isSaving={createMutation.isPending}
        />
      )}
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function ShowModal({
  onClose, onSave, isSaving,
}: {
  onClose: () => void;
  onSave: (data: ShowCreate) => void;
  isSaving: boolean;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<ShowCreate>({
    resolver: zodResolver(ShowCreateSchema),
    defaultValues: { color: 'indigo' },
  });

  const selectedColor = watch('color');

  const onSubmit = (formData: ShowCreate) => {
    onSave({
      ...formData,
      host:     formData.host?.trim()     || null,
      producer: formData.producer?.trim() || null,
      notes:    formData.notes?.trim()    || null,
    });
  };

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div
        className={`${MODAL_BOX} max-w-lg max-h-[90vh]`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider bg-zinc-800 px-2 py-0.5 rounded">Show</span>
            <h2 className="text-base font-semibold text-white">New Show</h2>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form id="show-form" onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className={LABEL}>
              Name <span className="text-red-400">*</span>
            </label>
            <input
              {...register('name')}
              placeholder="e.g. Morning Drive"
              className={INPUT}
            />
            {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
          </div>

          {/* Host + Producer */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Host</label>
              <input {...register('host')} placeholder="Host name" className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Producer</label>
              <input {...register('producer')} placeholder="Producer name" className={INPUT} />
            </div>
          </div>

          {/* Color swatches */}
          <div>
            <label className={LABEL}>Color</label>
            <div className="flex gap-2 flex-wrap">
              {SHOW_COLORS.map((color) => {
                const cm = COLOR_META[color];
                const isSelected = selectedColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    title={cm.label}
                    onClick={() => setValue('color', color)}
                    className={`w-7 h-7 rounded-full ${cm.dot} transition-all ${
                      isSelected
                        ? 'ring-2 ring-offset-2 ring-offset-zinc-900 ring-white scale-110'
                        : 'opacity-60 hover:opacity-100'
                    }`}
                  />
                );
              })}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className={LABEL}>Notes</label>
            <textarea
              {...register('notes')}
              rows={2}
              placeholder="Optional notes"
              className={`${INPUT} resize-none`}
            />
          </div>

        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800 flex-shrink-0">
          <button type="button" onClick={onClose} className={BTN_SECONDARY_SM}>
            Cancel
          </button>
          <button form="show-form" type="submit" disabled={isSaving} className={BTN_PRIMARY}>
            {isSaving ? 'Creating…' : 'Create & Edit'}
          </button>
        </div>
      </div>
    </div>
  );
}
