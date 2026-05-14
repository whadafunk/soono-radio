import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Check, X, Trash2, Repeat } from 'lucide-react';
import { Rotation, RotationType, ROTATION_TYPES } from '@radio/shared';
import { fetchRotations, createRotation, updateRotation, deleteRotation } from '../../api';

const TYPE_META: Record<RotationType, { label: string; short: string; bg: string; border: string; text: string; desc: string }> = {
  random_separation: {
    label: 'Random Separation', short: 'Random Sep.',
    bg: 'bg-indigo-500/15', border: 'border-indigo-500/40', text: 'text-indigo-300',
    desc: 'Picks tracks at random while enforcing a minimum gap before a track or artist can repeat.',
  },
  least_recently_played: {
    label: 'Least Recently Played', short: 'LRP',
    bg: 'bg-teal-500/15', border: 'border-teal-500/40', text: 'text-teal-300',
    desc: 'Always picks the track that was played furthest in the past.',
  },
  round_robin: {
    label: 'Round Robin', short: 'Round Robin',
    bg: 'bg-amber-500/15', border: 'border-amber-500/40', text: 'text-amber-300',
    desc: 'Cycles through the playlist in a fixed order, wrapping around at the end.',
  },
  weighted: {
    label: 'Weighted', short: 'Weighted',
    bg: 'bg-violet-500/15', border: 'border-violet-500/40', text: 'text-violet-300',
    desc: 'Picks tracks at random with probability proportional to their weight in the playlist.',
  },
};

const DEFAULT_PARAMS: Record<RotationType, Record<string, unknown>> = {
  random_separation:     { separation_minutes: 60, artist_separation_minutes: 0 },
  least_recently_played: {},
  round_robin:           { order_by: 'added_date' },
  weighted:              {},
};

type RotationDraft = { id: number; name: string; type: RotationType; params: Record<string, unknown> };

export function RotationsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<RotationDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const { data: rotations = [] } = useQuery({ queryKey: ['rotations'], queryFn: fetchRotations });

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('No draft');
      return updateRotation(draft.id, { name: draft.name, params: draft.params });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setDirty(false);
      showToast('success', 'Rotation saved');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const createMutation = useMutation({
    mutationFn: (name: string) =>
      createRotation({ name, type: 'random_separation', params: DEFAULT_PARAMS.random_separation }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setCreatingNew(false);
      setNewName('');
      selectRotation(created);
      showToast('success', 'Rotation created');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteRotation,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rotations'] });
      setSelectedId(null);
      setDraft(null);
      setDirty(false);
      setConfirmDelete(false);
      showToast('success', 'Rotation deleted');
    },
    onError: (e) => showToast('error', (e as Error).message),
  });

  const selectRotation = (r: Rotation) => {
    setSelectedId(r.id);
    setDraft({ id: r.id, name: r.name, type: r.type, params: JSON.parse(JSON.stringify(r.params)) });
    setDirty(false);
    setConfirmDelete(false);
  };

  const updateDraft = (updater: (d: RotationDraft) => RotationDraft) => {
    setDraft((prev) => (prev ? updater(prev) : prev));
    setDirty(true);
  };

  const handleDiscard = () => {
    const original = rotations.find((r) => r.id === selectedId);
    if (original) {
      setDraft({ id: original.id, name: original.name, type: original.type, params: JSON.parse(JSON.stringify(original.params)) });
      setDirty(false);
    }
  };

  const handleTypeChange = (newType: RotationType) => {
    updateDraft((d) => ({ ...d, type: newType, params: { ...DEFAULT_PARAMS[newType] } }));
  };

  const updateParam = (key: string, value: unknown) => {
    updateDraft((d) => ({ ...d, params: { ...d.params, [key]: value } }));
  };

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-white">Rotations</h1>
          <p className="text-zinc-400 mt-1 text-sm">Define how tracks are selected from playlists.</p>
        </div>
      </div>

      {toast && (
        <div className={`flex-shrink-0 px-4 py-2.5 rounded-lg text-sm ${
          toast.type === 'success'
            ? 'bg-green-900/20 border border-green-800 text-green-300'
            : 'bg-red-900/20 border border-red-800 text-red-300'
        }`}>
          {toast.message}
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: list */}
        <div className="w-56 flex-shrink-0 flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Rotations</span>
            <button
              onClick={() => setCreatingNew(true)}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-700 rounded transition-colors"
              title="New rotation"
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
                  if (e.key === 'Enter' && newName.trim()) createMutation.mutate(newName.trim());
                  if (e.key === 'Escape') { setCreatingNew(false); setNewName(''); }
                }}
                placeholder="Rotation name…"
                className="flex-1 min-w-0 px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
                className="p-1 text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => { setCreatingNew(false); setNewName(''); }}
                className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="flex-1 overflow-auto">
            {rotations.length === 0 && !creatingNew && (
              <p className="px-4 py-6 text-xs text-zinc-400 text-center">No rotations yet.<br />Create one to get started.</p>
            )}
            {rotations.map((r) => {
              const meta = TYPE_META[r.type];
              const isSelected = r.id === selectedId;
              return (
                <button
                  key={r.id}
                  onClick={() => selectRotation(r)}
                  className={`w-full text-left px-4 py-3 border-b border-zinc-800/60 transition-colors ${
                    isSelected ? 'bg-indigo-600/20 border-l-2 border-l-indigo-500' : 'hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Repeat className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-white truncate">{r.name}</span>
                  </div>
                  <div className="mt-1.5 ml-5">
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${meta.bg} ${meta.border} ${meta.text}`}>
                      {meta.short}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: editor */}
        {draft ? (
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Header */}
            <div className="flex-shrink-0 flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-5 py-4">
              <input
                value={draft.name}
                onChange={(e) => updateDraft((d) => ({ ...d, name: e.target.value }))}
                className="flex-1 min-w-0 text-lg font-semibold text-white bg-transparent border-b border-transparent hover:border-zinc-700 focus:border-indigo-500 focus:outline-none transition-colors pb-0.5"
              />
              <div className="flex items-center gap-2 flex-shrink-0">
                {dirty && (
                  <>
                    <button
                      onClick={handleDiscard}
                      className="px-3 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
                    >
                      Discard
                    </button>
                    <button
                      onClick={() => saveMutation.mutate()}
                      disabled={saveMutation.isPending}
                      className="px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {saveMutation.isPending ? 'Saving…' : 'Save'}
                    </button>
                  </>
                )}
                {!dirty && !confirmDelete && (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors"
                    title="Delete rotation"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                {confirmDelete && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-400">Delete?</span>
                    <button
                      onClick={() => deleteMutation.mutate(draft.id)}
                      disabled={deleteMutation.isPending}
                      className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-white rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Type + Params */}
            <div className="flex-1 min-h-0 bg-zinc-900 border border-zinc-800 rounded-lg p-5 space-y-6 overflow-auto">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Algorithm
                </label>
                <div className="flex flex-wrap gap-2">
                  {ROTATION_TYPES.map((type) => {
                    const meta = TYPE_META[type];
                    const isActive = draft.type === type;
                    return (
                      <button
                        key={type}
                        onClick={() => handleTypeChange(type)}
                        className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                          isActive
                            ? `${meta.bg} ${meta.border} ${meta.text} font-medium`
                            : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
                        }`}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-zinc-500">{TYPE_META[draft.type].desc}</p>
              </div>

              <ParamsForm type={draft.type} params={draft.params} onChange={updateParam} />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-zinc-900 border border-zinc-800 rounded-lg">
            <p className="text-zinc-400 text-sm">Select a rotation to edit it</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ParamsForm({
  type, params, onChange,
}: {
  type: RotationType;
  params: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  if (type === 'random_separation') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-sm text-zinc-300 mb-1.5">Track separation</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={480}
                value={(params.separation_minutes as number) ?? 60}
                onChange={(e) => onChange('separation_minutes', Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-20 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <span className="text-xs text-zinc-400">min between same track</span>
            </div>
          </div>
          <div>
            <label className="block text-sm text-zinc-300 mb-1.5">Artist separation</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={240}
                value={(params.artist_separation_minutes as number) ?? 0}
                onChange={(e) => onChange('artist_separation_minutes', Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-20 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
              />
              <span className="text-xs text-zinc-400">min between same artist (0 = off)</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'least_recently_played') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div>
          <label className="block text-sm text-zinc-300 mb-1.5">
            Pool size <span className="text-zinc-500">(optional)</span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              placeholder="All"
              value={(params.pool_size as number | undefined) ?? ''}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                onChange('pool_size', isNaN(v) ? undefined : Math.max(1, v));
              }}
              className="w-20 px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500 placeholder:text-zinc-600"
            />
            <span className="text-xs text-zinc-400">tracks to consider (blank = entire playlist)</span>
          </div>
        </div>
      </div>
    );
  }

  if (type === 'round_robin') {
    return (
      <div>
        <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Parameters
        </label>
        <div>
          <label className="block text-sm text-zinc-300 mb-1.5">Order by</label>
          <select
            value={(params.order_by as string) ?? 'added_date'}
            onChange={(e) => onChange('order_by', e.target.value)}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-white focus:outline-none focus:border-indigo-500"
          >
            <option value="added_date">Date added</option>
            <option value="title">Title (A–Z)</option>
            <option value="artist">Artist (A–Z)</option>
            <option value="manual">Manual order</option>
          </select>
        </div>
      </div>
    );
  }

  // weighted — no params
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
        Parameters
      </label>
      <p className="text-sm text-zinc-500">
        Weighted rotation has no extra parameters. Track probability is controlled by the weight
        column in the playlist.
      </p>
    </div>
  );
}
