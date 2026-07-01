import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader, Check, AlertCircle, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { IntegrationsConfig, IntegrationsConfigSchema } from '@soono/shared';
import { fetchIntegrationsConfig, updateIntegrationsConfig } from '../../api';

function ThresholdSlider({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-zinc-300">{label}</label>
        <span className="text-sm font-mono text-brand-300">{pct}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={pct}
        onChange={(e) => onChange(parseInt(e.target.value, 10) / 100)}
        className="w-full accent-brand-500"
      />
      <p className="mt-1.5 text-xs text-zinc-500">{hint}</p>
    </div>
  );
}

export function IntegrationsSettings() {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [draft, setDraft] = useState<IntegrationsConfig | null>(null);

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['integrations-config'],
    queryFn: fetchIntegrationsConfig,
  });

  useEffect(() => {
    if (config !== undefined && draft === null) setDraft(config);
  }, [config]);

  const mutation = useMutation({
    mutationFn: (data: IntegrationsConfig) => updateIntegrationsConfig(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations-config'] });
      showToast('success', 'Settings saved');
    },
    onError: (err) => showToast('error', (err as Error).message),
  });

  function showToast(type: 'success' | 'error', message: string) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const parsed = IntegrationsConfigSchema.safeParse(draft);
    if (parsed.success) {
      mutation.mutate(parsed.data);
    } else {
      showToast('error', parsed.error.errors[0]?.message ?? 'Invalid settings');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader className="w-8 h-8 animate-spin text-brand-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        <p>Failed to load Integrations settings</p>
      </div>
    );
  }

  const currentKey = (draft ?? config)?.acoustid_api_key ?? '';

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Integrations</h1>
        <p className="text-zinc-400 mt-2">Third-party API keys and external service configuration.</p>
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

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* AcoustID */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">AcoustID</h2>
              <p className="text-sm text-zinc-400 mt-1">
                Acoustic fingerprinting for automatic track identification in the Library.
              </p>
            </div>
            <a
              href="https://acoustid.biz/new-application"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 transition-colors flex-shrink-0 mt-1"
            >
              Get a free key
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={currentKey}
                onChange={(e) => setDraft((d) => ({ ...(d ?? config!), acoustid_api_key: e.target.value }))}
                placeholder="Paste your AcoustID client key…"
                className="w-full pr-10 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-brand-500 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {!currentKey && (
              <p className="mt-2 text-xs text-amber-400">
                No key set — "Lookup ID" in the Library will return an error until this is configured.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-6 pt-2">
            <ThresholdSlider
              label="Min confidence"
              hint="Minimum match score to auto-apply. Lower = more matches applied, higher = fewer but safer."
              value={(draft ?? config!).acoustid_min_score}
              onChange={(v) => setDraft((d) => ({ ...(d ?? config!), acoustid_min_score: v }))}
            />
            <ThresholdSlider
              label="Min score gap"
              hint="How far ahead the top match must be over the second. Prevents auto-apply when two candidates are close."
              value={(draft ?? config!).acoustid_min_gap}
              onChange={(v) => setDraft((d) => ({ ...(d ?? config!), acoustid_min_gap: v }))}
            />
          </div>
        </div>

        {/* Audio analysis */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-white">Audio Analysis</h2>
            <p className="text-sm text-zinc-400 mt-1">
              BPM/key/mood analysis runs automatically for imported music tracks.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-300">Max concurrent analyses</label>
              <span className="text-sm font-mono text-brand-300">
                {(draft ?? config!).max_concurrent_analysis}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={8}
              step={1}
              value={(draft ?? config!).max_concurrent_analysis}
              onChange={(e) =>
                setDraft((d) => ({ ...(d ?? config!), max_concurrent_analysis: parseInt(e.target.value, 10) }))
              }
              className="w-full accent-brand-500"
            />
            <p className="mt-1.5 text-xs text-zinc-400">
              How many tracks can be analysed at once during a batch import. Each analysis can use several
              hundred MB of RAM — raise this only if the host has memory to spare. Default of 1 is safest.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {mutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
