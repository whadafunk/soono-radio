import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Megaphone, Trash2, CheckCircle2, Search, X, Music,
  Loader, Check, ChevronUp, ChevronDown, AlertTriangle, PauseCircle, ChevronsUpDown,
} from 'lucide-react';
import { PromoWithShow, PromoCreate, PromoPatch, PromoMediaWithMedia, Show } from '@radio/shared';
import {
  fetchPromos, createPromo, updatePromo, deletePromo,
  fetchPromoMedia, addPromoMedia, removePromoMedia,
  fetchShows, fetchLibrary, LibraryListResponse,
} from '../../api';

// ─── Types ────────────────────────────────────────────────────────────────────

type PromoStatus = 'active' | 'inactive' | 'expired';
type SortCol = 'name' | 'show_name' | 'starts_on' | 'min_plays_per_day' | 'status';
type SortDir = 'asc' | 'desc';

// ─── Status helpers ───────────────────────────────────────────────────────────

const TODAY = new Date().toISOString().slice(0, 10);

function getStatus(p: PromoWithShow): PromoStatus {
  if (!p.active) return 'inactive';
  if (p.ends_on < TODAY) return 'expired';
  return 'active';
}

const STATUS_ORDER: Record<PromoStatus, number> = { expired: 0, active: 1, inactive: 2 };

const STATUS_BADGE: Record<PromoStatus, { label: string; cls: string; icon: React.ReactNode }> = {
  active: {
    label: 'Active',
    cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-800/50',
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  expired: {
    label: 'Expired',
    cls: 'bg-amber-900/40 text-amber-300 border-amber-800/50',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  inactive: {
    label: 'Inactive',
    cls: 'bg-zinc-800 text-zinc-500 border-zinc-700',
    icon: <PauseCircle className="w-3 h-3" />,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function formatDuration(seconds: number | null | undefined) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ─── Media picker ─────────────────────────────────────────────────────────────

function MediaPickerModal({
  attached,
  onAdd,
  onRemove,
  onClose,
  isPending,
}: {
  attached: PromoMediaWithMedia[];
  onAdd: (mediaId: number) => void;
  onRemove: (attachmentId: number) => void;
  onClose: () => void;
  isPending: boolean;
}) {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // simple debounce
  const handleQ = (v: string) => {
    setQ(v);
    setTimeout(() => setDebouncedQ(v), 250);
  };

  const { data, isLoading } = useQuery<LibraryListResponse>({
    queryKey: ['promo-lib-picker', debouncedQ],
    queryFn: () => fetchLibrary({ q: debouncedQ || undefined, category: 'promo', sort: 'created_at', order: 'desc', limit: 50, offset: 0 }),
  });

  const attachedByMediaId = new Map(attached.map((a) => [a.media_id, a.id]));
  const items = data?.items ?? [];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="w-full max-w-xl bg-zinc-900 border border-zinc-700 rounded-xl flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 p-4 border-b border-zinc-800">
          <Search className="w-4 h-4 text-zinc-500 flex-shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => handleQ(e.target.value)}
            placeholder="Search promo clips…"
            className="flex-1 bg-transparent text-white placeholder-zinc-500 text-sm focus:outline-none"
          />
          {isLoading && <Loader className="w-4 h-4 animate-spin text-zinc-500" />}
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white transition-colors"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/60">
          {items.length === 0 && !isLoading && (
            <p className="text-zinc-500 text-sm p-6 text-center">No promo clips found in library.</p>
          )}
          {items.map((item) => {
            const attachmentId = attachedByMediaId.get(item.id);
            const added = attachmentId !== undefined;
            return (
              <button
                key={item.id}
                type="button"
                disabled={isPending}
                onClick={() => (added ? onRemove(attachmentId) : onAdd(item.id))}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:opacity-50 ${added ? 'bg-indigo-600/10 hover:bg-indigo-600/20' : 'hover:bg-zinc-800/60'}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200 truncate">
                    {item.title ?? <span className="italic text-zinc-500">{item.original_filename}</span>}
                  </p>
                  {item.artist && <p className="text-xs text-zinc-500 truncate">{item.artist}</p>}
                </div>
                <span className="text-xs text-zinc-500 font-mono w-10 text-right flex-shrink-0">{formatDuration(item.duration_seconds)}</span>
                <span className={`flex items-center gap-1 text-xs w-16 justify-end flex-shrink-0 ${added ? 'text-indigo-400' : 'text-zinc-600'}`}>
                  {added ? <><Check className="w-3.5 h-3.5" /> Added</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 text-xs text-zinc-500">
          Showing promo-category clips from library. Click to add or remove.
        </div>
      </div>
    </div>
  );
}

// ─── Media section (inside modal) ────────────────────────────────────────────

function PromoMediaSection({ promoId }: { promoId: number }) {
  const qc = useQueryClient();
  const [showPicker, setShowPicker] = useState(false);

  const { data: clips = [], isLoading } = useQuery<PromoMediaWithMedia[]>({
    queryKey: ['promo-media', promoId],
    queryFn: () => fetchPromoMedia(promoId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['promo-media', promoId] });
  const addMutation = useMutation({ mutationFn: (mediaId: number) => addPromoMedia(promoId, mediaId), onSuccess: invalidate });
  const removeMutation = useMutation({ mutationFn: (id: number) => removePromoMedia(id), onSuccess: invalidate });
  const isPending = addMutation.isPending || removeMutation.isPending;

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-medium text-zinc-200">Media Clips</span>
            <p className="text-xs text-zinc-500 mt-0.5">Promo-category clips from library that will be aired</p>
          </div>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            disabled={isPending}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-lg transition-colors disabled:opacity-50"
          >
            <Plus className="w-3 h-3" /> Add clip
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-4"><Loader className="w-4 h-4 animate-spin text-zinc-500" /></div>
        ) : clips.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2 pl-1">No clips attached yet.</p>
        ) : (
          clips.map((clip) => (
            <div key={clip.id} className="flex items-center gap-3 px-3 py-2 bg-zinc-800/50 border border-zinc-700/50 rounded-lg">
              <Music className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-zinc-200 truncate">
                  {clip.title ?? <span className="italic text-zinc-500">{clip.original_filename ?? 'Untitled'}</span>}
                </p>
                {clip.artist && <p className="text-xs text-zinc-500 truncate">{clip.artist}</p>}
              </div>
              <span className="text-xs text-zinc-500 font-mono w-10 text-right flex-shrink-0">{formatDuration(clip.duration_seconds)}</span>
              <button
                type="button"
                onClick={() => removeMutation.mutate(clip.id)}
                disabled={isPending}
                className="p-1 text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>

      {showPicker && (
        <MediaPickerModal
          attached={clips}
          onAdd={(id) => addMutation.mutate(id)}
          onRemove={(id) => removeMutation.mutate(id)}
          onClose={() => setShowPicker(false)}
          isPending={isPending}
        />
      )}
    </>
  );
}

// ─── Promo modal ──────────────────────────────────────────────────────────────

function PromoModal({
  promo,
  shows,
  onClose,
}: {
  promo: PromoWithShow | null;
  shows: Show[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = promo === null;

  const [name, setName] = useState(promo?.name ?? '');
  const [showId, setShowId] = useState(promo?.show_id?.toString() ?? '');
  const [noAirDuringShow, setNoAirDuringShow] = useState(promo?.no_air_during_show ?? false);
  const [startsOn, setStartsOn] = useState(promo?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(promo?.ends_on ?? '');
  const [minPlays, setMinPlays] = useState(promo?.min_plays_per_day?.toString() ?? '1');
  const [maxPlays, setMaxPlays] = useState(promo?.max_plays_per_day?.toString() ?? '3');
  const [notes, setNotes] = useState(promo?.notes ?? '');
  const [active, setActive] = useState(promo?.active ?? true);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [error, setError] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['promos'] });

  const createMutation = useMutation({
    mutationFn: (data: PromoCreate) => createPromo(data),
    onSuccess: () => { invalidate(); onClose(); },
    onError: () => setError('Failed to create promo.'),
  });

  const updateMutation = useMutation({
    mutationFn: (data: PromoPatch) => updatePromo(promo!.id, data),
    onSuccess: () => { invalidate(); onClose(); },
    onError: () => setError('Failed to save promo.'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deletePromo(promo!.id),
    onSuccess: () => { invalidate(); onClose(); },
  });

  const isPending = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const min = parseInt(minPlays, 10);
    const max = parseInt(maxPlays, 10);
    if (!name.trim()) return setError('Name is required.');
    if (!startsOn || !endsOn) return setError('Both dates are required.');
    if (startsOn > endsOn) return setError('Start date must be before end date.');
    if (!min || !max || min < 1 || max < 1) return setError('Plays must be at least 1.');
    if (min > max) return setError('Min plays cannot exceed max plays.');

    const payload = {
      name: name.trim(),
      show_id: showId ? parseInt(showId, 10) : null,
      starts_on: startsOn,
      ends_on: endsOn,
      min_plays_per_day: min,
      max_plays_per_day: max,
      no_air_during_show: showId ? noAirDuringShow : false,
      notes: notes.trim() || null,
      active,
    };

    if (isNew) createMutation.mutate(payload);
    else updateMutation.mutate(payload);
  }

  const input = 'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500';
  const label = 'block text-sm font-medium text-zinc-200 mb-1';
  const hint = 'mt-1 text-xs text-zinc-500';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg bg-zinc-900 border border-zinc-800 rounded-xl flex flex-col max-h-[92vh] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-100">{isNew ? 'New Promo' : 'Edit Promo'}</h2>
          <button onClick={onClose} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={submit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="px-3 py-2 bg-red-900/30 border border-red-800/50 rounded-lg text-red-300 text-sm">{error}</div>
          )}

          {/* Name */}
          <div>
            <label className={label}>Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Morning Drive — June push"
              className={input}
            />
            <p className={hint}>Short internal label for this campaign</p>
          </div>

          {/* Show */}
          <div>
            <label className={label}>Show</label>
            <select value={showId} onChange={(e) => { setShowId(e.target.value); if (!e.target.value) setNoAirDuringShow(false); }} className={input}>
              <option value="">— No show —</option>
              {shows.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <p className={hint}>The show this promo promotes. Leave blank for general station promos.</p>

            {/* Conditional: do not air during show */}
            {showId && (
              <label className="flex items-start gap-2.5 mt-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={noAirDuringShow}
                  onChange={(e) => setNoAirDuringShow(e.target.checked)}
                  className="mt-0.5 rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-zinc-900 cursor-pointer"
                />
                <div>
                  <span className="text-sm text-zinc-200 group-hover:text-white transition-colors">Do not air during the show</span>
                  <p className="text-xs text-zinc-500 mt-0.5">Skip this promo while the selected show is broadcasting</p>
                </div>
              </label>
            )}
          </div>

          {/* Date range */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Starts on</label>
              <input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} className={input} />
            </div>
            <div>
              <label className={label}>Ends on</label>
              <input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} className={input} />
            </div>
          </div>
          <p className={`-mt-3 ${hint}`}>Date range during which this promo is eligible to air</p>

          {/* Plays per day */}
          <div>
            <label className={label}>Plays per day</label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <input
                  type="number"
                  min={1}
                  value={minPlays}
                  onChange={(e) => setMinPlays(e.target.value)}
                  className={input}
                  placeholder="min"
                />
              </div>
              <span className="text-zinc-500 text-sm font-medium">to</span>
              <div className="flex-1">
                <input
                  type="number"
                  min={1}
                  value={maxPlays}
                  onChange={(e) => setMaxPlays(e.target.value)}
                  className={input}
                  placeholder="max"
                />
              </div>
            </div>
            <p className={hint}>Scheduler targets at least min plays, caps at max. Equal values lock the count.</p>
          </div>

          {/* Notes */}
          <div>
            <label className={label}>Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional internal notes…"
              className={`${input} resize-none`}
            />
            <p className={hint}>Not used by the scheduler — for operator reference only</p>
          </div>

          {/* Active toggle — edit only */}
          {!isNew && (
            <div className="flex items-center justify-between pt-1 border-t border-zinc-800">
              <div>
                <span className="text-sm font-medium text-zinc-200">Active</span>
                <p className="text-xs text-zinc-500 mt-0.5">Inactive promos are skipped entirely by the scheduler</p>
              </div>
              <button
                type="button"
                onClick={() => setActive((v) => !v)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${active ? 'bg-indigo-600' : 'bg-zinc-700'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${active ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
              </button>
            </div>
          )}

          {/* Media section — edit only */}
          {!isNew && (
            <div className="pt-1 border-t border-zinc-800">
              <PromoMediaSection promoId={promo!.id} />
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex items-center px-6 py-4 border-t border-zinc-800 flex-shrink-0 gap-3">
          {!isNew && (
            deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">Delete this promo?</span>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate()}
                  disabled={isPending}
                  className="px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded-lg disabled:opacity-50 transition-colors"
                >
                  Yes, delete
                </button>
                <button type="button" onClick={() => setDeleteConfirm(false)} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirm(true)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            )
          )}
          <div className="flex gap-2 ml-auto">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              onClick={submit}
              disabled={isPending}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sort header cell ─────────────────────────────────────────────────────────

function SortTh({
  col, label, sortCol, sortDir, onSort,
}: {
  col: SortCol;
  label: string;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (col: SortCol) => void;
}) {
  const active = sortCol === col;
  return (
    <th
      onClick={() => onSort(col)}
      className="px-4 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider cursor-pointer select-none hover:text-zinc-300 transition-colors whitespace-nowrap"
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-indigo-400" /> : <ChevronDown className="w-3 h-3 text-indigo-400" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-30" />
        )}
      </span>
    </th>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PromoPage() {
  const qc = useQueryClient();

  const [selected, setSelected] = useState<PromoWithShow | null | undefined>(undefined);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  const { data: promoList = [], isLoading } = useQuery<PromoWithShow[]>({
    queryKey: ['promos'],
    queryFn: fetchPromos,
  });

  const { data: showList = [] } = useQuery<Show[]>({
    queryKey: ['shows'],
    queryFn: fetchShows,
  });

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  }

  const sorted = useMemo(() => {
    const list = [...promoList];
    list.sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortCol === 'show_name') cmp = (a.show_name ?? '').localeCompare(b.show_name ?? '');
      else if (sortCol === 'starts_on') cmp = a.starts_on.localeCompare(b.starts_on);
      else if (sortCol === 'min_plays_per_day') cmp = a.min_plays_per_day - b.min_plays_per_day;
      else if (sortCol === 'status') cmp = STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)];
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [promoList, sortCol, sortDir]);

  const allChecked = sorted.length > 0 && sorted.every((p) => checkedIds.has(p.id));
  const someChecked = checkedIds.size > 0;

  function toggleAll() {
    if (allChecked) setCheckedIds(new Set());
    else setCheckedIds(new Set(sorted.map((p) => p.id)));
  }

  function toggleOne(id: number) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function bulkSetActive(active: boolean) {
    setBulkPending(true);
    await Promise.all([...checkedIds].map((id) => updatePromo(id, { active })));
    qc.invalidateQueries({ queryKey: ['promos'] });
    setCheckedIds(new Set());
    setBulkPending(false);
  }

  async function bulkDelete() {
    setBulkPending(true);
    await Promise.all([...checkedIds].map((id) => deletePromo(id)));
    qc.invalidateQueries({ queryKey: ['promos'] });
    setCheckedIds(new Set());
    setBulkDeleteConfirm(false);
    setBulkPending(false);
  }

  const expiredCount = promoList.filter((p) => getStatus(p) === 'expired').length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Promo</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Station show promotion campaigns</p>
        </div>
        <button
          onClick={() => setSelected(null)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" /> New Promo
        </button>
      </div>

      {/* Expired warning banner */}
      {expiredCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-amber-900/20 border border-amber-800/40 rounded-xl text-amber-300 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            {expiredCount} promo{expiredCount !== 1 ? 's are' : ' is'} past their end date but still marked active — consider deactivating or extending them.
          </span>
        </div>
      )}

      {/* Bulk action bar — always visible */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-800 border border-zinc-700 rounded-xl">
        <span className={`text-sm font-medium transition-colors ${someChecked ? 'text-zinc-300' : 'text-zinc-600'}`}>
          {someChecked ? `${checkedIds.size} selected` : 'None selected'}
        </span>
        <div className="h-4 w-px bg-zinc-700" />
        <button
          onClick={() => bulkSetActive(true)}
          disabled={!someChecked || bulkPending}
          className="px-3 py-1.5 text-xs bg-emerald-900/40 hover:bg-emerald-900/70 border border-emerald-800/50 text-emerald-300 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Activate
        </button>
        <button
          onClick={() => bulkSetActive(false)}
          disabled={!someChecked || bulkPending}
          className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 text-zinc-300 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Deactivate
        </button>
        {bulkDeleteConfirm ? (
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-red-400">Delete {checkedIds.size} promo{checkedIds.size !== 1 ? 's' : ''}?</span>
            <button
              onClick={bulkDelete}
              disabled={bulkPending}
              className="px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 text-white rounded-lg disabled:opacity-50 transition-colors"
            >
              {bulkPending ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button onClick={() => setBulkDeleteConfirm(false)} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors">
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setBulkDeleteConfirm(true)}
            disabled={!someChecked || bulkPending}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs bg-zinc-700 hover:bg-red-900/40 border border-zinc-600 hover:border-red-800/50 text-zinc-400 hover:text-red-400 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader className="w-5 h-5 animate-spin text-zinc-500" />
          </div>
        ) : promoList.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-zinc-500">
            <Megaphone className="w-8 h-8 opacity-30" />
            <p className="text-sm">No promos yet.</p>
            <button
              onClick={() => setSelected(null)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> Create first promo
            </button>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/80">
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={toggleAll}
                    className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-zinc-900 cursor-pointer"
                  />
                </th>
                <SortTh col="name" label="Name" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortTh col="show_name" label="Show" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortTh col="starts_on" label="Period" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortTh col="min_plays_per_day" label="Plays/day" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
                <SortTh col="status" label="Status" sortCol={sortCol} sortDir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const status = getStatus(p);
                const badge = STATUS_BADGE[status];
                const isExpired = status === 'expired';
                return (
                  <tr
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className={`border-b border-zinc-800 hover:bg-zinc-800/40 cursor-pointer transition-colors ${isExpired ? 'bg-amber-900/5' : ''}`}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={checkedIds.has(p.id)}
                        onChange={() => toggleOne(p.id)}
                        className="rounded border-zinc-600 bg-zinc-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-zinc-900 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium ${isExpired ? 'text-amber-200' : 'text-zinc-100'}`}>{p.name}</span>
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400">
                      {p.show_name ?? <span className="italic text-zinc-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 font-mono whitespace-nowrap">
                      {formatDate(p.starts_on)} – {formatDate(p.ends_on)}
                    </td>
                    <td className="px-4 py-3 text-sm text-zinc-400 whitespace-nowrap">
                      {p.min_plays_per_day === p.max_plays_per_day
                        ? `${p.min_plays_per_day}×`
                        : `${p.min_plays_per_day}–${p.max_plays_per_day}×`}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs border rounded-full ${badge.cls}`}>
                        {badge.icon} {badge.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal */}
      {selected !== undefined && (
        <PromoModal promo={selected} shows={showList} onClose={() => { setSelected(undefined); setCheckedIds(new Set()); }} />
      )}
    </div>
  );
}
