import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader, Plus, Trash2, X } from 'lucide-react';
import {
  Contract,
  ContractCreate,
  ContractCreateSchema,
  ContractPatch,
  Customer,
} from '@radio/shared';
import {
  fetchContracts,
  fetchCustomers,
  createContract,
  updateContract,
  deleteContract,
  fetchContractPacing,
} from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';

export function ContractsList() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: contracts = [], isLoading, error } = useQuery({
    queryKey: ['contracts'],
    queryFn: () => fetchContracts(),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
  });

  const createMutation = useMutation({
    mutationFn: createContract,
    onSuccess: () => {
      setIsCreating(false);
      setToast({ type: 'success', message: 'Contract created' });
      setTimeout(() => setToast(null), 3000);
    },
    onError: (err) => {
      setToast({ type: 'error', message: (err as Error).message });
      setTimeout(() => setToast(null), 3000);
    },
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center h-96">
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );

  if (error)
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        Failed to load contracts
      </div>
    );

  const selected = contracts.find((c) => c.id === selectedId);
  const getCustomer = (id: number) => customers.find((c) => c.id === id);

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          <p>{toast.message}</p>
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-zinc-400">
          {contracts.length} contract{contracts.length !== 1 ? 's' : ''}
        </p>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Contract
        </button>
      </div>

      {isCreating && (
        <ContractForm
          customers={customers}
          onSubmit={(data) => createMutation.mutate(data)}
          onCancel={() => setIsCreating(false)}
          isLoading={createMutation.isPending}
        />
      )}

      <table className="w-full bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <thead className="bg-zinc-800">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Customer
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Contract Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Period
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Plays/Month
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((contract) => (
            <tr
              key={contract.id}
              onClick={() => setSelectedId(contract.id)}
              className="border-t border-zinc-800 hover:bg-zinc-800/50 cursor-pointer transition-colors"
            >
              <td className="px-4 py-3 text-white">{contract.customer_name}</td>
              <td className="px-4 py-3 text-white">{contract.name}</td>
              <td className="px-4 py-3 text-zinc-400 text-sm">
                {contract.starts_on} → {contract.ends_on}
              </td>
              <td className="px-4 py-3 text-white font-mono">{contract.plays_per_month}</td>
              <td className="px-4 py-3">
                <span
                  className={`text-xs px-2 py-1 rounded ${
                    contract.active
                      ? 'bg-green-900/30 text-green-300'
                      : 'bg-zinc-800 text-zinc-400'
                  }`}
                >
                  {contract.active ? 'Active' : 'Inactive'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {selected && (
        <ContractDetailDrawer
          contract={selected}
          customer={getCustomer(selected.customer_id)}
          onClose={() => setSelectedId(null)}
          onSave={(patch) =>
            updateContract(selected.id, patch).then(() => {
              setToast({ type: 'success', message: 'Contract updated' });
              setTimeout(() => setToast(null), 3000);
            })
          }
          onDelete={() =>
            deleteContract(selected.id).then(() => {
              setSelectedId(null);
              setToast({ type: 'success', message: 'Contract deleted' });
              setTimeout(() => setToast(null), 3000);
            })
          }
        />
      )}
    </div>
  );
}

function ContractForm({
  customers,
  onSubmit,
  onCancel,
  isLoading,
}: {
  customers: Customer[];
  onSubmit: (data: ContractCreate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const { register, handleSubmit, formState } = useForm<ContractCreate>({
    resolver: zodResolver(ContractCreateSchema),
    defaultValues: {
      separation_minutes: 90,
      advertiser_separation_min: 30,
      priority: 'standard',
    },
  });

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4"
    >
      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">
          Customer <span className="text-red-400">*</span>
        </label>
        <select
          {...register('customer_id', { valueAsNumber: true })}
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        >
          <option value="">Select a customer...</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {formState.errors.customer_id && (
          <p className="text-red-400 text-xs mt-1">{formState.errors.customer_id.message}</p>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">
          Contract Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          {...register('name')}
          placeholder="Summer Campaign 2026"
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        />
        {formState.errors.name && (
          <p className="text-red-400 text-xs mt-1">{formState.errors.name.message}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Starts On <span className="text-red-400">*</span>
          </label>
          <input
            type="date"
            {...register('starts_on')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Ends On <span className="text-red-400">*</span>
          </label>
          <input
            type="date"
            {...register('ends_on')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2">
          Plays Per Month <span className="text-red-400">*</span>
        </label>
        <input
          type="number"
          {...register('plays_per_month', { valueAsNumber: true })}
          min={1}
          className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={isLoading}
          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {isLoading ? <Loader className="w-4 h-4 animate-spin inline" /> : 'Create'}
        </button>
      </div>
    </form>
  );
}

function ContractDetailDrawer({
  contract,
  customer,
  onClose,
  onSave,
  onDelete,
}: {
  contract: Contract & { customer_name: string };
  customer?: Customer;
  onClose: () => void;
  onSave: (patch: ContractPatch) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { data: pacing } = useQuery({
    queryKey: ['contract-pacing', contract.id],
    queryFn: () => fetchContractPacing(contract.id),
  });

  const [draft, setDraft] = useState<ContractPatch>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(draft);
      setDraft({});
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this contract? This cannot be undone.')) return;
    setIsDeleting(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="w-full max-w-xl h-full bg-zinc-900 border-l border-zinc-800 flex flex-col overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-zinc-800">
          <div>
            <h2 className="text-xl font-bold text-white">{contract.name}</h2>
            <p className="text-sm text-zinc-400">{customer?.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-6 space-y-6 overflow-y-auto">
          {/* Pacing */}
          {pacing && (
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
              <h3 className="text-sm font-semibold text-zinc-300">Pacing This Month</h3>
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">
                  {pacing.plays_this_month} of {pacing.target} plays
                </span>
                <span
                  className={`font-semibold ${
                    pacing.on_track ? 'text-green-400' : 'text-amber-400'
                  }`}
                >
                  {pacing.pct}%
                </span>
              </div>
              <div className="w-full bg-zinc-700 rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all ${
                    pacing.on_track ? 'bg-green-500' : 'bg-amber-500'
                  }`}
                  style={{ width: `${Math.min(pacing.pct, 100)}%` }}
                />
              </div>
              <p
                className={`text-xs ${
                  pacing.on_track ? 'text-green-400' : 'text-amber-400'
                }`}
              >
                {pacing.on_track ? '✓ On track' : '⚠ Behind schedule'}
              </p>
            </div>
          )}

          {/* Contract Details */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              Details
            </h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">Starts</label>
                <input
                  type="date"
                  value={draft.starts_on ?? contract.starts_on}
                  onChange={(e) => setDraft({ ...draft, starts_on: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">Ends</label>
                <input
                  type="date"
                  value={draft.ends_on ?? contract.ends_on}
                  onChange={(e) => setDraft({ ...draft, ends_on: e.target.value })}
                  className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">
                Plays Per Month
              </label>
              <input
                type="number"
                value={draft.plays_per_month ?? contract.plays_per_month}
                onChange={(e) =>
                  setDraft({ ...draft, plays_per_month: parseInt(e.target.value) })
                }
                min={1}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">Priority</label>
              <select
                value={draft.priority ?? contract.priority}
                onChange={(e) => setDraft({ ...draft, priority: e.target.value as any })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="hard">Hard (must complete)</option>
                <option value="standard">Standard (normal)</option>
                <option value="soft">Soft (best effort)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-2">Notes</label>
              <textarea
                value={draft.notes ?? contract.notes ?? ''}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
                rows={3}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={draft.active !== undefined ? draft.active : contract.active}
                  onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
                  className="rounded"
                />
                Active
              </label>
            </div>
          </div>

          {/* Advanced Options (collapsed for now) */}
          <details className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-3">
            <summary className="cursor-pointer text-sm font-medium text-zinc-300">
              Advanced Options
            </summary>
            <div className="mt-3 space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">
                  Time Window (Start)
                </label>
                <input
                  type="time"
                  value={draft.time_window_start ?? contract.time_window_start ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, time_window_start: e.target.value || null })
                  }
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">
                  Time Window (End)
                </label>
                <input
                  type="time"
                  value={draft.time_window_end ?? contract.time_window_end ?? ''}
                  onChange={(e) =>
                    setDraft({ ...draft, time_window_end: e.target.value || null })
                  }
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-2">
                  Separation (minutes)
                </label>
                <input
                  type="number"
                  value={draft.separation_minutes ?? contract.separation_minutes}
                  onChange={(e) =>
                    setDraft({ ...draft, separation_minutes: parseInt(e.target.value) })
                  }
                  min={0}
                  className="w-full px-3 py-2 bg-zinc-700 border border-zinc-600 rounded text-white text-sm focus:outline-none focus:border-indigo-500"
                />
                <p className="text-xs text-zinc-500 mt-1">Min time between same ad plays</p>
              </div>
            </div>
          </details>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 p-6 space-y-3">
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving || Object.keys(draft).length === 0}
              className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? <Loader className="w-4 h-4 animate-spin inline" /> : 'Save'}
            </button>
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
          <button
            onClick={handleDelete}
            disabled={isDeleting}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-red-900/20 hover:bg-red-900/30 text-red-300 rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 className="w-4 h-4" />
            Delete Contract
          </button>
        </div>
      </div>
    </div>
  );
}
