import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Mic2, X, CalendarClock } from 'lucide-react';
import {
  ShowCreate, ShowCreateSchema,
  ShowColor, SHOW_COLORS,
  TemplateEntry,
} from '@radio/shared';
import { fetchShows, createShow, deleteShow, fetchTemplateEntries } from '../../api';

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

export function ShowsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showModal, setShowModal] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: shows = [], isLoading } = useQuery({ queryKey: ['shows'], queryFn: fetchShows });
  const { data: templateEntries = [] } = useQuery({
    queryKey: ['template-entries'],
    queryFn: fetchTemplateEntries,
  });

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
    mutationFn: (id: number) => deleteShow(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shows'] });
      qc.invalidateQueries({ queryKey: ['template-entries'] });
      setConfirmDeleteId(null);
      showToast('success', 'Show deleted');
    },
    onError: (err: Error) => showToast('error', err.message),
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Shows</h1>
          <p className="text-sm text-zinc-400 mt-0.5">Define show templates with hosts, schedules, and metadata</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Show
        </button>
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
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {isLoading ? (
          <div className="px-6 py-16 text-center text-zinc-400 text-sm">Loading shows…</div>
        ) : shows.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <Mic2 className="w-8 h-8 text-zinc-500 mx-auto mb-3" />
            <p className="text-zinc-400 text-sm">No shows yet — create your first show to get started.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-800 w-10"></th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-800">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-800">Host</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-zinc-400 uppercase tracking-wider border-r border-zinc-800">Next</th>
                <th className="px-4 py-3 w-28"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {shows.map((show) => {
                const cm = COLOR_META[show.color];
                const showEntries = templateEntries.filter((e) => e.show_id === show.id);
                const next = getNextOccurrence(showEntries);
                return (
                  <tr
                    key={show.id}
                    className={`transition-colors cursor-pointer group ${confirmDeleteId === show.id ? 'bg-red-900/10' : 'hover:bg-zinc-800/40'}`}
                    onClick={() => confirmDeleteId === show.id ? undefined : navigate(`/shows/${show.id}`)}
                  >
                    <td className="px-4 py-3 border-r border-zinc-800/60">
                      <div className={`w-3 h-3 rounded-full ${cm.dot} mx-auto`} />
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-zinc-200 font-medium text-sm">{show.name}</span>
                    </td>
                    <td className="px-4 py-3">
                      {show.host
                        ? <span className="text-zinc-300 text-sm">{show.host}</span>
                        : <span className="text-zinc-500 italic text-sm">—</span>
                      }
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
                    <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      {confirmDeleteId === show.id ? (
                        <div className="flex flex-col items-end gap-1.5">
                          {showEntries.length > 0 && (
                            <span className="text-[11px] text-amber-400 text-right leading-tight">
                              Scheduled in {showEntries.length} slot{showEntries.length !== 1 ? 's' : ''}. Slots will be cleared.
                            </span>
                          )}
                          <div className="flex items-center gap-1.5 justify-end">
                            <button
                              onClick={() => deleteMutation.mutate(show.id)}
                              disabled={deleteMutation.isPending}
                              className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors disabled:opacity-50"
                            >Delete</button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                            >Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => setConfirmDeleteId(show.id)}
                            className="p-1 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
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
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider bg-zinc-800 px-2 py-0.5 rounded">Show</span>
            <h2 className="text-base font-semibold text-white">New Show</h2>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form id="show-form" onSubmit={handleSubmit(onSubmit)} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1">
              Name <span className="text-red-400">*</span>
            </label>
            <input
              {...register('name')}
              placeholder="e.g. Morning Drive"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            />
            {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
          </div>

          {/* Host + Producer */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Host</label>
              <input
                {...register('host')}
                placeholder="Host name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1">Producer</label>
              <input
                {...register('producer')}
                placeholder="Producer name"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Color swatches */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">Color</label>
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
            <label className="block text-xs font-medium text-zinc-300 mb-1">Notes</label>
            <textarea
              {...register('notes')}
              rows={2}
              placeholder="Optional notes"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            form="show-form"
            type="submit"
            disabled={isSaving}
            className="px-4 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {isSaving ? 'Creating…' : 'Create & Edit'}
          </button>
        </div>
      </div>
    </div>
  );
}
