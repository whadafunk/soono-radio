import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Database, Loader, ScrollText } from 'lucide-react';
import {
  fetchDbStats,
  fetchLogSettings,
  runDbSweep,
  updateLogSettings,
  updateMaintenanceSettings,
} from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

type Toast = { type: 'success' | 'error'; message: string } | null;

function ToastLine({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
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
  );
}

function LogsSection({ onToast }: { onToast: (t: Toast) => void }) {
  const queryClient = useQueryClient();
  const [maxSize, setMaxSize] = useState(25);
  const [keep, setKeep] = useState(3);

  const { data } = useQuery({ queryKey: ['log-settings'], queryFn: fetchLogSettings });

  useEffect(() => {
    if (data) {
      setMaxSize(data.max_file_size_mb);
      setKeep(data.rotated_files_kept);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: updateLogSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['log-settings'] });
      onToast({ type: 'success', message: 'Log settings saved — applies immediately, no restart needed.' });
    },
    onError: (err) => onToast({ type: 'error', message: `Error: ${(err as Error).message}` }),
  });

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
        <ScrollText className="w-3.5 h-3.5" /> Log rotation
      </p>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
          Maximum file size
          <HelpTooltip text="When a log file reaches this size it rotates: the file becomes .1, existing archives shift up, and a fresh file starts. Applies to every source — API-written logs rotate on the write that crosses the cap; LiquidSoap and Icecast logs are checked hourly." />
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={500}
            value={maxSize}
            onChange={(e) => setMaxSize(Number(e.target.value))}
            className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
          />
          <span className="text-zinc-300 text-sm">MB</span>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
          Rotated files kept
          <HelpTooltip text="How many rotated archives (.1, .2, …) to keep per log file before the oldest is deleted. Total disk footprint per source ≈ (this + 1) × maximum file size." />
        </label>
        <input
          type="number"
          min={1}
          max={9}
          value={keep}
          onChange={(e) => setKeep(Number(e.target.value))}
          className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
        />
        <p className="text-zinc-400 text-xs mt-1">Worst-case disk usage per source: ~{(keep + 1) * maxSize} MB.</p>
      </div>

      <button
        className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ max_file_size_mb: maxSize, rotated_files_kept: keep })}
      >
        {mutation.isPending ? 'Saving…' : 'Save log settings'}
      </button>
    </div>
  );
}

function DatabaseSection({ onToast }: { onToast: (t: Toast) => void }) {
  const queryClient = useQueryClient();
  const [retentionDays, setRetentionDays] = useState(90);

  const { data: stats, isLoading } = useQuery({ queryKey: ['db-stats'], queryFn: fetchDbStats });

  useEffect(() => {
    if (stats) setRetentionDays(stats.settings.plans_retention_days);
  }, [stats]);

  const saveMutation = useMutation({
    mutationFn: updateMaintenanceSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['db-stats'] });
      onToast({ type: 'success', message: 'Retention saved — the nightly sweep uses it from its next run.' });
    },
    onError: (err) => onToast({ type: 'error', message: `Error: ${(err as Error).message}` }),
  });

  const sweepMutation = useMutation({
    mutationFn: runDbSweep,
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['db-stats'] });
      const total = r.plans_retired + r.plans_deleted + r.plan_items_deleted + r.stop_set_estimates_deleted + r.live_events_deleted;
      onToast({
        type: 'success',
        message:
          total === 0
            ? 'Sweep ran — nothing is past retention.'
            : `Sweep retired ${r.plans_retired} stale plans; deleted ${r.plans_deleted} plans, ${r.plan_items_deleted} items, ${r.stop_set_estimates_deleted} estimates, ${r.live_events_deleted} live events${r.vacuumed ? ' — space reclaimed (VACUUM)' : ''}.`,
      });
    },
    onError: (err) => onToast({ type: 'error', message: `Error: ${(err as Error).message}` }),
  });

  if (isLoading || !stats) {
    return (
      <div className="flex items-center gap-2 text-zinc-400 text-sm">
        <Loader className="w-4 h-4 animate-spin" /> Loading database stats…
      </div>
    );
  }

  const rows: Array<[string, number, string]> = [
    ['plans', stats.counts.plans, 'swept past retention (terminal only)'],
    ['plan_items', stats.counts.plan_items, 'swept with their plans'],
    ['stop_set_estimates', stats.counts.stop_set_estimates, 'swept with their plans'],
    ['live_events', stats.counts.live_events, 'swept past retention'],
    ['play_history', stats.counts.play_history, 'never deleted — feeds reports & rotation'],
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
        <Database className="w-3.5 h-3.5" /> Database retention
      </p>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <p className="text-sm text-zinc-300 mb-3">
          Database file: <span className="font-mono text-zinc-100">{formatBytes(stats.file_size_bytes)}</span>
        </p>
        <div className="space-y-1.5">
          {rows.map(([name, n, note]) => (
            <div key={name} className="flex items-center gap-3 text-xs">
              <span className="w-40 font-mono text-zinc-300">{name}</span>
              <span className="w-20 text-right font-mono text-zinc-100">{n.toLocaleString()}</span>
              <span className={note.startsWith('never') ? 'text-green-400/80' : 'text-zinc-400'}>{note}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
          Keep operational records for
          <HelpTooltip text="Terminal plans (completed/Invalid) with their items and estimates, plus live events, are deleted once older than this. Hard floor regardless of this value: nothing newer than the start of the PREVIOUS calendar month is ever deleted, so the current reporting period is always safe. play_history is never touched." />
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={35}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            className="w-28 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
          />
          <span className="text-zinc-300 text-sm">days</span>
        </div>
        <p className="text-zinc-400 text-xs mt-1">
          The sweep runs nightly. Whatever this is set to, records newer than the start of last month are never
          deleted, and play history is never deleted at all.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50"
          disabled={saveMutation.isPending}
          onClick={() => saveMutation.mutate({ plans_retention_days: retentionDays })}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save retention'}
        </button>
        <button
          className="px-4 py-2 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-zinc-200 text-sm font-medium disabled:opacity-50"
          disabled={sweepMutation.isPending}
          onClick={() => sweepMutation.mutate()}
        >
          {sweepMutation.isPending ? 'Sweeping…' : 'Run cleanup now'}
        </button>
      </div>

      {stats.last_sweep && (
        <p className="text-xs text-zinc-400">
          Last sweep {new Date(stats.last_sweep.at_ms).toLocaleString()} — retired {stats.last_sweep.plans_retired} stale, deleted{' '}
          {stats.last_sweep.plans_deleted} plans, {stats.last_sweep.plan_items_deleted} items,{' '}
          {stats.last_sweep.stop_set_estimates_deleted} estimates, {stats.last_sweep.live_events_deleted} live
          events{stats.last_sweep.vacuumed ? ' · vacuumed' : ''}.
        </p>
      )}
    </div>
  );
}

export function MaintenanceSettings() {
  const [toast, setToast] = useState<Toast>(null);
  const showToast = (t: Toast) => {
    setToast(t);
    setTimeout(() => setToast(null), 5000);
  };

  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Maintenance</h1>
        <p className="text-zinc-400 mt-2">
          Automatic housekeeping — log rotation and database retention. Both run on their own; this page
          configures them and offers manual actions.
        </p>
      </div>

      <ToastLine toast={toast} />

      <LogsSection onToast={showToast} />
      <div className="border-t border-zinc-800" />
      <DatabaseSection onToast={showToast} />
    </div>
  );
}
