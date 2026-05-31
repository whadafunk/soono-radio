import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Pencil, X, ChevronUp, ChevronDown } from 'lucide-react';
import {
  MusicCampaign,
  MusicCampaignCreate,
  MusicCampaignCreateSchema,
  MusicCampaignWithCustomer,
} from '@soono/shared';
import {
  fetchMusicCampaigns,
  createMusicCampaign,
  updateMusicCampaign,
  deleteMusicCampaign,
  fetchMusicCampaignPacing,
  fetchCustomers,
  fetchPlaylists,
} from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';
import { BTN_PRIMARY_SM, BTN_SECONDARY_SM, BTN_DESTRUCTIVE_SM, INPUT, LABEL, MODAL_OVERLAY, MODAL_BOX } from '../../ui';

type SortCol = 'name' | 'customer' | 'playlist' | 'starts_on' | 'plays_per_day';

export function MusicCampaignsPage({
  showSaveStatus,
  focusedCustomerId,
}: {
  showSaveStatus: (type: 'success' | 'error' | 'warning', message: string) => void;
  focusedCustomerId: number | null;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<MusicCampaignWithCustomer | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['music-campaigns'],
    queryFn: () => fetchMusicCampaigns(),
  });
  const { data: customers = [] } = useQuery({ queryKey: ['customers'], queryFn: fetchCustomers });
  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  const musicPlaylists = useMemo(() => playlists.filter((p) => p.type === 'music' && p.subcategory === 'heavy_rotation'), [playlists]);

  const filtered = useMemo(
    () => focusedCustomerId ? campaigns.filter((c) => c.customer_id === focusedCustomerId) : campaigns,
    [campaigns, focusedCustomerId],
  );

  const visible = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let v = 0;
      if (sortCol === 'name')         v = a.name.localeCompare(b.name);
      if (sortCol === 'customer')     v = (a.customer_name ?? '').localeCompare(b.customer_name ?? '');
      if (sortCol === 'playlist')     v = (a.playlist_name ?? '').localeCompare(b.playlist_name ?? '');
      if (sortCol === 'starts_on')    v = a.starts_on.localeCompare(b.starts_on);
      if (sortCol === 'plays_per_day') v = a.plays_per_day - b.plays_per_day;
      return sortDir === 'asc' ? v : -v;
    });
  }, [filtered, sortCol, sortDir]);

  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  useEffect(() => {
    setConfirmingDelete(false);
    if (deleteTimer.current) clearTimeout(deleteTimer.current);
  }, [selectedIds, focusedId]);

  const canEdit = selectedIds.size === 1;
  const effectiveDeleteIds: number[] =
    selectedIds.size > 0
      ? [...selectedIds]
      : focusedId !== null ? [focusedId] : [];
  const canDelete = effectiveDeleteIds.length > 0;
  const allSelected = visible.length > 0 && visible.every((c) => selectedIds.has(c.id));

  const toggleCheckbox = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(visible.map((c) => c.id)));

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => deleteMusicCampaign(id))),
    onSuccess: (_, ids) => {
      qc.invalidateQueries({ queryKey: ['music-campaigns'] });
      setSelectedIds(new Set());
      setFocusedId(null);
      showSaveStatus('error', ids.length === 1 ? 'Music campaign deleted' : `${ids.length} music campaigns deleted`);
    },
    onError: (err: Error) => showSaveStatus('error', err.message),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      updateMusicCampaign(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['music-campaigns'] }),
  });

  const handleDeleteClick = () => {
    if (confirmingDelete) {
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
      setConfirmingDelete(false);
      deleteMutation.mutate(effectiveDeleteIds);
    } else {
      setConfirmingDelete(true);
      deleteTimer.current = setTimeout(() => setConfirmingDelete(false), 4000);
    }
  };

  const SortTh = ({ col, children }: { col: SortCol; children: React.ReactNode }) => {
    const active = sortCol === col;
    const Icon = active && sortDir === 'desc' ? ChevronDown : ChevronUp;
    return (
      <th
        className={`px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider border-r border-zinc-700 cursor-pointer select-none transition-colors ${
          active ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        onClick={() => handleSort(col)}
      >
        <span className="flex items-center gap-1">
          {children}
          <Icon className={`w-4 h-4 flex-shrink-0 ${active ? 'text-brand-400' : 'text-zinc-400'}`} />
        </span>
      </th>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* View header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800 bg-zinc-800/30 flex-shrink-0">
        <h2 className="text-sm font-semibold text-white flex-shrink-0">
          Music Campaigns ({filtered.length})
        </h2>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setCreating(true)} className={BTN_PRIMARY_SM}>
            <Plus className="w-3.5 h-3.5" />
            New Music Campaign
          </button>
          <button
            onClick={() => { if (canEdit) setEditing(visible.find((c) => selectedIds.has(c.id))!); }}
            disabled={!canEdit}
            className={BTN_SECONDARY_SM}
          >
            <Pencil className="w-3.5 h-3.5" />
            Edit
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={!canDelete || deleteMutation.isPending}
            title={!canDelete ? 'Select campaigns to delete' : undefined}
            className={`${BTN_DESTRUCTIVE_SM} ${confirmingDelete ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-zinc-900 animate-pulse' : ''}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {confirmingDelete ? 'Click again to delete' : `Delete${effectiveDeleteIds.length > 0 ? ` (${effectiveDeleteIds.length})` : ''}`}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <p className="text-sm text-zinc-500 px-5 py-4">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-zinc-500 italic px-5 py-4">
            {focusedCustomerId
              ? 'This customer has no music campaigns.'
              : 'No music campaigns yet. Create one to start promoting contracted songs.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-800/60 sticky top-0">
              <tr className="border-b border-zinc-700">
                <th className="px-4 py-2 w-10 border-r border-zinc-700">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
                  />
                </th>
                <SortTh col="name">Campaign</SortTh>
                <SortTh col="customer">Customer</SortTh>
                <SortTh col="playlist">Playlist</SortTh>
                <SortTh col="starts_on">Dates</SortTh>
                <SortTh col="plays_per_day">Plays/day</SortTh>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400 border-r border-zinc-700">Today</th>
                <th className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wider text-zinc-400">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {visible.map((c) => (
                <CampaignRow
                  key={c.id}
                  campaign={c}
                  isSelected={selectedIds.has(c.id)}
                  isFocused={focusedId === c.id}
                  onToggle={(e) => toggleCheckbox(c.id, e)}
                  onRowClick={() => setFocusedId((prev) => prev === c.id ? null : c.id)}
                  onEdit={() => setEditing(c)}
                  onToggleActive={(active) => toggleActive.mutate({ id: c.id, active })}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(creating || editing) && (
        <CampaignFormModal
          campaign={editing}
          customers={customers}
          playlists={musicPlaylists}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSuccess={(msg) => { showSaveStatus('success', msg); setCreating(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────────

function CampaignRow({
  campaign,
  isSelected,
  isFocused,
  onToggle,
  onRowClick,
  onEdit,
  onToggleActive,
}: {
  campaign: MusicCampaignWithCustomer;
  isSelected: boolean;
  isFocused: boolean;
  onToggle: (e: React.MouseEvent) => void;
  onRowClick: () => void;
  onEdit: () => void;
  onToggleActive: (active: boolean) => void;
}) {
  const { data: pacing } = useQuery({
    queryKey: ['music-campaign-pacing', campaign.id],
    queryFn: () => fetchMusicCampaignPacing(campaign.id),
    refetchInterval: 30_000,
  });

  return (
    <tr
      onClick={onRowClick}
      onDoubleClick={onEdit}
      title="Double-click to edit"
      className={`cursor-pointer transition-colors ${isSelected || isFocused ? 'bg-brand-600/10' : 'hover:bg-zinc-800/40'}`}
    >
      <td className="px-4 py-3 border-r border-zinc-800/60" onClick={onToggle}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {}}
          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
        />
      </td>
      <td className="px-4 py-3 text-zinc-200 font-medium text-sm">{campaign.name}</td>
      <td className="px-4 py-3 text-zinc-400 text-sm">{campaign.customer_name}</td>
      <td className="px-4 py-3 text-zinc-400 text-sm">{campaign.playlist_name}</td>
      <td className="px-4 py-3 text-zinc-400 text-xs">{campaign.starts_on} → {campaign.ends_on}</td>
      <td className="px-4 py-3 text-zinc-200 text-sm">{campaign.plays_per_day}</td>
      <td className="px-4 py-3 text-sm">
        {pacing ? (
          <span className={pacing.on_track ? 'text-emerald-400' : pacing.pct < 80 ? 'text-amber-400' : 'text-rose-400'}>
            {pacing.plays_today}/{pacing.target}
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={campaign.active}
          onChange={(e) => onToggleActive(e.target.checked)}
          className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-600 focus:ring-brand-500 focus:ring-offset-0 cursor-pointer"
        />
      </td>
    </tr>
  );
}

// ─── Create / Edit modal ──────────────────────────────────────────────────────

function CampaignFormModal({
  campaign,
  customers,
  playlists,
  onClose,
  onSuccess,
}: {
  campaign: MusicCampaign | null;
  customers: { id: number; name: string }[];
  playlists: { id: number; name: string }[];
  onClose: () => void;
  onSuccess: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!campaign;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MusicCampaignCreate>({
    resolver: zodResolver(MusicCampaignCreateSchema),
    defaultValues: campaign
      ? {
          customer_id: campaign.customer_id,
          name: campaign.name,
          playlist_id: campaign.playlist_id,
          starts_on: campaign.starts_on,
          ends_on: campaign.ends_on,
          plays_per_day: campaign.plays_per_day,
          notes: campaign.notes ?? undefined,
        }
      : { plays_per_day: 3 } as Partial<MusicCampaignCreate> as MusicCampaignCreate,
  });

  const submit = useMutation({
    mutationFn: (data: MusicCampaignCreate) =>
      isEdit ? updateMusicCampaign(campaign!.id, data) : createMusicCampaign(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['music-campaigns'] });
      onSuccess(isEdit ? 'Music campaign updated' : 'Music campaign created');
    },
  });

  return (
    <div className={`${MODAL_OVERLAY} p-4`} onClick={onClose}>
      <div className={`${MODAL_BOX} max-w-md max-h-[90vh]`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider bg-zinc-800 px-2 py-0.5 rounded">Music</span>
            <h2 className="text-base font-semibold text-white">
              {isEdit ? 'Edit Music Campaign' : 'New Music Campaign'}
            </h2>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form id="music-campaign-form" onSubmit={handleSubmit((d) => submit.mutate(d))} className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <label className={LABEL}>Name <span className="text-red-400">*</span></label>
            <input type="text" {...register('name')} placeholder="e.g. Summer Hit Promo" className={INPUT} />
            {errors.name && <p className="text-xs text-red-400 mt-1">{errors.name.message}</p>}
          </div>

          <div>
            <label className={LABEL}>Customer <span className="text-red-400">*</span></label>
            <select {...register('customer_id', { valueAsNumber: true })} className={INPUT}>
              <option value="">Select a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {errors.customer_id && <p className="text-xs text-red-400 mt-1">Required</p>}
          </div>

          <div>
            <label className={LABEL}>
              Contracted playlist <span className="text-red-400">*</span>
              <HelpTooltip text="The set of songs covered by this contract. Picker draws from this playlist when the campaign is behind its daily target." />
            </label>
            <select {...register('playlist_id', { valueAsNumber: true })} className={INPUT}>
              <option value="">Select a music playlist…</option>
              {playlists.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {errors.playlist_id && <p className="text-xs text-red-400 mt-1">Required</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Starts on</label>
              <input type="date" {...register('starts_on')} className={INPUT} />
            </div>
            <div>
              <label className={LABEL}>Ends on</label>
              <input type="date" {...register('ends_on')} className={INPUT} />
            </div>
          </div>

          <div>
            <label className={LABEL}>
              Plays per day (target)
              <HelpTooltip text="How many times a song from the contracted playlist should play each day. The picker prioritizes these songs when the campaign is behind pace." />
            </label>
            <input type="number" min={1} {...register('plays_per_day', { valueAsNumber: true })} className={INPUT} />
            {errors.plays_per_day && <p className="text-xs text-red-400 mt-1">{errors.plays_per_day.message}</p>}
          </div>

          <div>
            <label className={LABEL}>Notes</label>
            <textarea {...register('notes')} rows={2} placeholder="Optional" className={`${INPUT} resize-none`} />
          </div>

          {submit.error && <p className="text-xs text-red-400">{(submit.error as Error).message}</p>}
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800 flex-shrink-0">
          <button type="button" onClick={onClose} className={BTN_SECONDARY_SM}>Cancel</button>
          <button form="music-campaign-form" type="submit" disabled={isSubmitting || submit.isPending} className={BTN_PRIMARY_SM}>
            {isEdit ? (submit.isPending ? 'Saving…' : 'Save') : (submit.isPending ? 'Creating…' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  );
}
