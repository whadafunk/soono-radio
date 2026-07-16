import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, AlertCircle, Loader } from 'lucide-react';
import { fetchStationSettings, updateStationSettings, fetchClocks } from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';

export function SchedulingSettings() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [localPct, setLocalPct] = useState(10);
  const [localCap, setLocalCap] = useState(300);
  const [localRealityCheckInterval, setLocalRealityCheckInterval] = useState(3);
  const [localFullAuthority, setLocalFullAuthority] = useState(100);

  const { data, isLoading, error } = useQuery({
    queryKey: ['station-settings'],
    queryFn: fetchStationSettings,
  });
  const { data: clocks = [] } = useQuery({ queryKey: ['clocks'], queryFn: fetchClocks });

  useEffect(() => {
    if (data) setLocalPct(Math.round(data.promo_margin * 100));
  }, [data]);

  useEffect(() => {
    if (data) setLocalCap(data.drift_recovery_cap_seconds);
  }, [data]);

  useEffect(() => {
    if (data) setLocalRealityCheckInterval(data.reality_check_interval_seconds);
  }, [data]);

  useEffect(() => {
    if (data) setLocalFullAuthority(data.drift_full_authority_threshold_s);
  }, [data]);

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
        <Loader className="w-8 h-8 animate-spin text-brand-500" />
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
              className="w-64 accent-brand-500"
            />
            <span className="text-white font-medium w-10">{localPct}%</span>
          </div>
          <p className="text-zinc-500 text-xs mt-1">
            {localPct}% of stop-set time is reserved — campaigns compete for the remaining {100 - localPct}%.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Fallback</p>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Default clock
            <HelpTooltip text="Plays whenever no calendar entry, template clock, or template covers the current moment — the last-resort fallback so the station never resolves to silence. Required for reliable playback." />
          </label>
          <select
            value={data.default_clock_id ?? ''}
            onChange={(e) =>
              mutation.mutate({
                default_clock_id: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="w-64 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
          >
            <option value="">None selected</option>
            {clocks.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {data.default_clock_id == null && (
            <p className="flex items-center gap-1.5 text-amber-400 text-xs mt-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              No default clock configured — the station can go silent if a moment falls outside every scheduled entry.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Drift correction</p>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Recovery cap per transition
            <HelpTooltip text="How much drift a single segment's target is allowed to correct for in one transition. Whatever this leaves uncorrected persists and gets another chance at the next transition. Doesn't apply to stop-sets, which never drift-correct." />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={30}
              max={1800}
              step={10}
              value={localCap}
              onChange={(e) => setLocalCap(Number(e.target.value))}
              onBlur={() => {
                if (!Number.isFinite(localCap)) { setLocalCap(data.drift_recovery_cap_seconds); return; }
                const clamped = Math.max(30, Math.min(1800, localCap));
                setLocalCap(clamped);
                if (clamped !== data.drift_recovery_cap_seconds) mutation.mutate({ drift_recovery_cap_seconds: clamped });
              }}
              className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <span className="text-zinc-400 text-sm">seconds</span>
          </div>
          <p className="text-zinc-500 text-xs mt-1">
            Default 300s (5 minutes). Raising this lets the supervisor absorb larger drift in a single plan, at the cost of a more noticeably shortened or extended segment when it does.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Full-authority threshold
            <HelpTooltip text="Below this predicted drift, the next plan's length stays within a comfortable 60–140% of the segment's nominal length. Above it, landing the boundary on time takes priority: the next plan may shrink or grow as much as the recovery cap allows, so the drift is gone within one transition." />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={30}
              max={600}
              step={10}
              value={localFullAuthority}
              onChange={(e) => setLocalFullAuthority(Number(e.target.value))}
              onBlur={() => {
                if (!Number.isFinite(localFullAuthority)) { setLocalFullAuthority(data.drift_full_authority_threshold_s); return; }
                const clamped = Math.max(30, Math.min(600, localFullAuthority));
                setLocalFullAuthority(clamped);
                if (clamped !== data.drift_full_authority_threshold_s) mutation.mutate({ drift_full_authority_threshold_s: clamped });
              }}
              className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <span className="text-zinc-400 text-sm">seconds</span>
          </div>
          <p className="text-zinc-500 text-xs mt-1">
            Default 100s. Any predicted drift beyond this is corrected to near zero by the very next plan instead of being spread gently across several.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Reality check</p>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Check interval
            <HelpTooltip text="How often the supervisor compares LiquidSoap's actual playback state against what it expects, to catch a silent failure (LiquidSoap falling to silence, a lost message) before the listener notices. The check itself is nearly free, so lower is generally safer — this isn't a resource tradeoff." />
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={10}
              step={1}
              value={localRealityCheckInterval}
              onChange={(e) => setLocalRealityCheckInterval(Number(e.target.value))}
              onBlur={() => {
                if (!Number.isFinite(localRealityCheckInterval)) { setLocalRealityCheckInterval(data.reality_check_interval_seconds); return; }
                const clamped = Math.max(1, Math.min(10, localRealityCheckInterval));
                setLocalRealityCheckInterval(clamped);
                if (clamped !== data.reality_check_interval_seconds) mutation.mutate({ reality_check_interval_seconds: clamped });
              }}
              className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
            />
            <span className="text-zinc-400 text-sm">seconds</span>
          </div>
          <p className="text-zinc-500 text-xs mt-1">
            Default 3s. Normal operation doesn't depend on this check at all — it's a safety net, so shorter intervals catch problems faster with no real downside.
          </p>
        </div>
      </div>
    </div>
  );
}
