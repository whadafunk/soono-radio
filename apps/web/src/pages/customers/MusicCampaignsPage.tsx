import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Pencil, X, Music } from 'lucide-react';
import {
  MusicCampaign,
  MusicCampaignCreate,
  MusicCampaignCreateSchema,
  MusicCampaignWithCustomer,
} from '@radio/shared';
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

export function MusicCampaignsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<MusicCampaignWithCustomer | null>(null);
  const [creating, setCreating] = useState(false);
  const [filterCustomer, setFilterCustomer] = useState<number | 'all'>('all');

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['music-campaigns'],
    queryFn: () => fetchMusicCampaigns(),
  });
  const { data: customers = [] } = useQuery({ queryKey: ['customers'], queryFn: fetchCustomers });
  const { data: playlists = [] } = useQuery({ queryKey: ['playlists'], queryFn: fetchPlaylists });
  // Heavy-rotation campaigns promote songs, so restrict the playlist picker to music playlists.
  const musicPlaylists = useMemo(() => playlists.filter((p) => p.type === 'music'), [playlists]);

  const visible = useMemo(
    () =>
      filterCustomer === 'all'
        ? campaigns
        : campaigns.filter((c) => c.customer_id === filterCustomer),
    [campaigns, filterCustomer],
  );

  const deleteMutation = useMutation({
    mutationFn: deleteMusicCampaign,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['music-campaigns'] }),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      updateMusicCampaign(id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['music-campaigns'] }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Music className="w-5 h-5 text-zinc-400" />
          <h2 className="text-lg font-medium text-white">Music Campaigns</h2>
          <HelpTooltip text="Promotes contracted songs at a per-day play target during music segments whose rotation has heavy_rotation enabled. Independent from spot (advertising) campaigns." />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={filterCustomer}
            onChange={(e) =>
              setFilterCustomer(e.target.value === 'all' ? 'all' : Number(e.target.value))
            }
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="all">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm transition"
          >
            <Plus className="w-4 h-4" />
            New Music Campaign
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-zinc-500 italic">
          {filterCustomer === 'all'
            ? 'No music campaigns yet. Create one to start promoting contracted songs.'
            : 'This customer has no music campaigns.'}
        </p>
      ) : (
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/50 text-xs uppercase tracking-wider text-zinc-400">
              <tr>
                <th className="px-3 py-2 text-left">Campaign</th>
                <th className="px-3 py-2 text-left">Customer</th>
                <th className="px-3 py-2 text-left">Playlist</th>
                <th className="px-3 py-2 text-left">Dates</th>
                <th className="px-3 py-2 text-right">Plays/day</th>
                <th className="px-3 py-2 text-center">Today</th>
                <th className="px-3 py-2 text-center">Active</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {visible.map((c) => (
                <CampaignRow
                  key={c.id}
                  campaign={c}
                  onEdit={() => setEditing(c)}
                  onDelete={() => {
                    if (confirm(`Delete music campaign "${c.name}"?`)) {
                      deleteMutation.mutate(c.id);
                    }
                  }}
                  onToggleActive={(active) => toggleActive.mutate({ id: c.id, active })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <CampaignFormModal
          campaign={editing}
          customers={customers}
          playlists={musicPlaylists}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────────

function CampaignRow({
  campaign,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  campaign: MusicCampaignWithCustomer;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (active: boolean) => void;
}) {
  const { data: pacing } = useQuery({
    queryKey: ['music-campaign-pacing', campaign.id],
    queryFn: () => fetchMusicCampaignPacing(campaign.id),
    refetchInterval: 30_000,
  });

  return (
    <tr className="hover:bg-zinc-900/30">
      <td className="px-3 py-2 text-zinc-200">{campaign.name}</td>
      <td className="px-3 py-2 text-zinc-400">{campaign.customer_name}</td>
      <td className="px-3 py-2 text-zinc-400">{campaign.playlist_name}</td>
      <td className="px-3 py-2 text-zinc-400 text-xs">
        {campaign.starts_on} → {campaign.ends_on}
      </td>
      <td className="px-3 py-2 text-right text-zinc-200">{campaign.plays_per_day}</td>
      <td className="px-3 py-2 text-center">
        {pacing ? (
          <span
            className={
              pacing.on_track
                ? 'text-emerald-400'
                : pacing.pct < 80
                  ? 'text-amber-400'
                  : 'text-rose-400'
            }
          >
            {pacing.plays_today}/{pacing.target}
          </span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        <input
          type="checkbox"
          checked={campaign.active}
          onChange={(e) => onToggleActive(e.target.checked)}
          className="accent-indigo-500"
        />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="p-1 text-zinc-500 hover:text-indigo-400 transition"
            aria-label="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-1 text-zinc-500 hover:text-rose-400 transition"
            aria-label="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
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
}: {
  campaign: MusicCampaign | null;
  customers: { id: number; name: string }[];
  playlists: { id: number; name: string }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!campaign;

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
      isEdit
        ? updateMusicCampaign(campaign!.id, data)
        : createMusicCampaign(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['music-campaigns'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium text-white">
            {isEdit ? 'Edit music campaign' : 'New music campaign'}
          </h3>
          <button type="button" onClick={onClose} className="text-zinc-500 hover:text-zinc-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form
          onSubmit={handleSubmit((d) => submit.mutate(d))}
          className="space-y-3"
        >
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              type="text"
              {...register('name')}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="e.g. Summer Hit Promo"
            />
            {errors.name && (
              <p className="text-xs text-rose-400 mt-1">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Customer</label>
            <select
              {...register('customer_id', { valueAsNumber: true })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">Select a customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {errors.customer_id && (
              <p className="text-xs text-rose-400 mt-1">Required</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">
              Contracted playlist
              <HelpTooltip text="The set of songs covered by this contract. Picker draws from this playlist when the campaign is behind its daily target." />
            </label>
            <select
              {...register('playlist_id', { valueAsNumber: true })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            >
              <option value="">Select a music playlist…</option>
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {errors.playlist_id && (
              <p className="text-xs text-rose-400 mt-1">Required</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Starts on</label>
              <input
                type="date"
                {...register('starts_on')}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Ends on</label>
              <input
                type="date"
                {...register('ends_on')}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Plays per day (target)</label>
            <input
              type="number"
              min={1}
              {...register('plays_per_day', { valueAsNumber: true })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
            {errors.plays_per_day && (
              <p className="text-xs text-rose-400 mt-1">{errors.plays_per_day.message}</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Notes</label>
            <textarea
              {...register('notes')}
              rows={2}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              placeholder="Optional"
            />
          </div>

          {submit.error && (
            <p className="text-xs text-rose-400">{(submit.error as Error).message}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || submit.isPending}
              className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded transition disabled:opacity-40"
            >
              {isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
