import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Loader } from 'lucide-react';
import { fetchLogSettings, updateLogSettings } from '../../api';
import { HelpTooltip } from '../../components/HelpTooltip';

export function LogsSettings() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [maxSize, setMaxSize] = useState(25);
  const [keep, setKeep] = useState(3);

  const { data, isLoading, error } = useQuery({
    queryKey: ['log-settings'],
    queryFn: fetchLogSettings,
  });

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
      setToast({ type: 'success', message: 'Log settings saved — applies immediately, no restart needed.' });
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
        <p>Failed to load log settings.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Logs</h1>
        <p className="text-zinc-400 mt-2">
          Size caps for every log file. API-written logs (api.log, supervisor.log) rotate the moment a
          write crosses the cap; LiquidSoap and Icecast logs are checked hourly and archived when over it.
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
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Rotation</p>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Maximum file size
            <HelpTooltip text="When a log file reaches this size it rotates: the file becomes .1, existing archives shift up, and a fresh file starts. Applies to every source." />
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
          <p className="text-zinc-400 text-xs mt-1">
            Worst-case disk usage per source: ~{(keep + 1) * maxSize} MB.
          </p>
        </div>

        <button
          className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium disabled:opacity-50"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ max_file_size_mb: maxSize, rotated_files_kept: keep })}
        >
          {mutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
