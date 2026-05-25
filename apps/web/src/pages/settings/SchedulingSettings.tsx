import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, AlertCircle, Loader } from 'lucide-react';
import { fetchStationSettings, updateStationSettings } from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';

export function SchedulingSettings() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['station-settings'],
    queryFn: fetchStationSettings,
  });

  const mutation = useMutation({
    mutationFn: updateStationSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['station-settings'] });
      setToast({ type: 'success', message: 'Settings saved.' });
      setTimeout(() => setToast(null), 4000);
    },
    onError: (err) => {
      setToast({ type: 'error', message: `Error: ${(err as Error).message}` });
      setTimeout(() => setToast(null), 5000);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        <p>Failed to load scheduling settings.</p>
      </div>
    );
  }

  const [localPct, setLocalPct] = useState(Math.round(data.promo_margin * 100));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Scheduling</h1>
        <p className="text-zinc-400 mt-2">
          Station-wide settings that affect the spot budget and campaign scheduling.
        </p>
      </div>

      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
            toast.type === 'success'
              ? 'bg-green-900/20 border border-green-800 text-green-300'
              : 'bg-red-900/20 border border-red-800 text-red-300'
          }`}
        >
          {toast.type === 'success' ? <Check className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <p>{toast.message}</p>
        </div>
      )}

      <div className="space-y-4">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Spot Budget</p>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Promo margin
            <HelpTooltip text="Percentage of total stop-set time reserved for station promos, IDs, and non-campaign content. This is deducted from the gross inventory before campaign budgets are calculated. Typical range: 10–15%." />
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min={0}
              max={50}
              step={1}
              value={localPct}
              onChange={(e) => setLocalPct(Number(e.target.value))}
              onPointerUp={(e) => mutation.mutate({ promo_margin: Number((e.target as HTMLInputElement).value) / 100 })}
              className="w-64 accent-indigo-500"
            />
            <span className="text-white font-medium w-10">{localPct}%</span>
          </div>
          <p className="text-zinc-500 text-xs mt-1">
            {localPct}% of stop-set time is reserved — campaigns compete for the remaining {100 - localPct}%.
          </p>
        </div>
      </div>
    </div>
  );
}
