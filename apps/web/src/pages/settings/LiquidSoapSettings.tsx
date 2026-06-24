import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LiquidsoapConfig, LiquidsoapConfigSchema } from '@soono/shared';
import {
  fetchLiquidsoapConfig,
  updateLiquidsoapConfig,
  fetchLiquidsoapRawScript,
  saveLiquidsoapRawScript,
  restartLiquidsoap,
  fetchIcecastConfig,
} from '../../api';
import { Loader, Check, AlertCircle, Code } from 'lucide-react';
import { RawScriptEditor } from '../../components/RawScriptEditor';
import { OutputSection } from './liquidsoap-sections/OutputSection';
import { HarborSection } from './liquidsoap-sections/HarborSection';
import { CrossfadeSection } from './liquidsoap-sections/CrossfadeSection';
import { MasterBusSection } from './liquidsoap-sections/MasterBusSection';
import { DuckingSection } from './liquidsoap-sections/DuckingSection';
import { SilenceDetectionSection } from './liquidsoap-sections/SilenceDetectionSection';
import { LoggingSection } from './liquidsoap-sections/LoggingSection';

function collectErrorPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && 'message' in val) {
      paths.push(path);
    } else if (val && typeof val === 'object') {
      paths.push(...collectErrorPaths(val as Record<string, unknown>, path));
    }
  }
  return paths;
}

export function LiquidSoapSettings() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [showRawScript, setShowRawScript] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const queryClient = useQueryClient();

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['liquidsoap-config'],
    queryFn: fetchLiquidsoapConfig,
    staleTime: 60_000,
  });

  const { data: icecastConfig } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
    staleTime: 60_000,
  });

  const icecastSockets = icecastConfig?.network.listen_sockets ?? [];

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    reset,
  } = useForm<LiquidsoapConfig>({
    resolver: zodResolver(LiquidsoapConfigSchema),
    values: config,
  });

  const mutation = useMutation({
    mutationFn: async (data: LiquidsoapConfig) => {
      await updateLiquidsoapConfig(data);
      setIsRestarting(true);
      setToast({ type: 'success', message: 'Settings saved. Restarting Liquidsoap...' });
      await restartLiquidsoap();
      setIsRestarting(false);
      setToast({ type: 'success', message: '✓ Liquidsoap restarted successfully' });
      setTimeout(() => setToast(null), 5000);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['liquidsoap-config'] });
    },
    onError: (err) => {
      setIsRestarting(false);
      setToast({ type: 'error', message: `✗ Error: ${(err as Error).message}` });
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

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        <p>Failed to load Liquidsoap settings</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">Mix Engine</h1>
          <p className="text-zinc-400 mt-2">
            Liquidsoap — the mixing board. Accepts live broadcasts, plays the queue fed by the Supervisor, and sends the result to the Streaming Engine.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowRawScript(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-zinc-900 border border-zinc-800 text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <Code className="w-4 h-4" />
            Raw Script
          </button>
        </div>
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

      <form
        onSubmit={handleSubmit(
          (data) => mutation.mutate(data),
          (formErrors) => {
            const paths = collectErrorPaths(formErrors).join(', ');
            setToast({ type: 'error', message: `Validation failed — check these fields: ${paths}` });
          },
        )}
        className="space-y-8"
      >
        <OutputSection register={register} errors={errors} control={control} icecastSockets={icecastSockets} />
        <HarborSection control={control} register={register} errors={errors} />
        <CrossfadeSection register={register} errors={errors} />
        <MasterBusSection register={register} />
        <DuckingSection register={register} control={control} />
        <SilenceDetectionSection register={register} control={control} />
        <LoggingSection register={register} />

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={mutation.isPending || isRestarting}
            className="flex items-center gap-2 px-6 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending || isRestarting ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                {isRestarting ? 'Restarting...' : 'Saving...'}
              </>
            ) : (
              'Save & Restart'
            )}
          </button>
          <button
            type="button"
            onClick={() => reset()}
            disabled={mutation.isPending || isRestarting}
            className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset
          </button>
        </div>
      </form>

      <RawScriptEditor
        isOpen={showRawScript}
        title="Edit mix-engine.liq"
        fetchScript={fetchLiquidsoapRawScript}
        saveScript={async (script) => {
          await saveLiquidsoapRawScript(script);
        }}
        onClose={() => setShowRawScript(false)}
        hint="Editing the raw script bypasses the form. The next 'Save & Restart' from the form will overwrite this."
      />
    </div>
  );
}
