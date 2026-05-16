import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm, UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader, Check, AlertCircle } from 'lucide-react';
import {
  SupervisorConfig, SupervisorConfigSchema,
  FINISH_POLICIES, JOIN_POLICIES,
  FinishPolicy, JoinPolicy,
} from '@radio/shared';
import {
  fetchSupervisorConfig,
  updateSupervisorConfig,
  restartSupervisor,
} from '../../api';
import { CollapsibleSection } from '../../components/CollapsibleSection';
import { HelpTooltip } from '../../components/HelpTooltip';

export function SupervisorSettings() {
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['supervisor-config'],
    queryFn: fetchSupervisorConfig,
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    control,
  } = useForm<SupervisorConfig>({
    resolver: zodResolver(SupervisorConfigSchema),
    values: config,
  });

  const mutation = useMutation({
    mutationFn: async (data: SupervisorConfig) => {
      await updateSupervisorConfig(data);
      setIsRestarting(true);
      setToast({ type: 'success', message: 'Settings saved. Restarting Supervisor...' });
      await restartSupervisor();
      setIsRestarting(false);
      setToast({ type: 'success', message: '✓ Supervisor restarted with new settings' });
      setTimeout(() => setToast(null), 5000);
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
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 text-red-300">
        <p>Failed to load Supervisor settings</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-bold text-white">Supervisor</h1>
        <p className="text-zinc-400 mt-2">
          The brain behind the queue. Picks the next track, watches what's airing, writes play history.
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

      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-8">
        <CollapsibleSection title="Polling">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Scheduler tick interval (ms)
                <HelpTooltip text="How often the Supervisor checks the Mix Engine queue and pushes the next track when it runs short. Lower = faster reaction to an empty queue, higher CPU/telnet traffic. 5000 ms is the default; 1000 is fine on a healthy system." />
              </label>
              <input
                type="number"
                min={500}
                max={60000}
                step={500}
                {...register('scheduler_tick_ms', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
              {errors.scheduler_tick_ms && (
                <p className="text-red-400 text-xs mt-1">{errors.scheduler_tick_ms.message}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Metadata poll interval (ms)
                <HelpTooltip text="How often the Supervisor polls the Mix Engine for the currently-airing track. Lower = more responsive Now Playing UI, higher telnet traffic. 1000–2000 ms is a good range; 5000 is conservative." />
              </label>
              <input
                type="number"
                min={500}
                max={60000}
                step={500}
                {...register('metadata_poll_ms', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
              {errors.metadata_poll_ms && (
                <p className="text-red-400 text-xs mt-1">{errors.metadata_poll_ms.message}</p>
              )}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Queue Management">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Queue depth threshold
                <HelpTooltip text="The Supervisor pushes a new track whenever the Mix Engine queue is below this depth. 1 means 'always keep one track lined up'; 3 means 'always lined up 3 ahead'. Higher = more buffer against Supervisor outages, less precise when scheduling lands." />
              </label>
              <input
                type="number"
                min={1}
                max={20}
                {...register('queue_depth_threshold', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
              {errors.queue_depth_threshold && (
                <p className="text-red-400 text-xs mt-1">{errors.queue_depth_threshold.message}</p>
              )}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Picker">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
                Separation (minutes)
                <HelpTooltip text="Minimum minutes between consecutive plays of the same track. Stops the random picker from repeating a song listeners just heard. Tiny libraries (under 50 tracks) want 15–30 minutes; large libraries (1000+) want 90+ minutes. 0 disables — pure random with possible repeats." />
              </label>
              <input
                type="number"
                min={0}
                max={720}
                {...register('separation_minutes', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              />
              {errors.separation_minutes && (
                <p className="text-red-400 text-xs mt-1">{errors.separation_minutes.message}</p>
              )}
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Handover defaults">
          <p className="text-xs text-zinc-500 mb-4">
            Station-wide defaults for clock handover behaviour. Individual clocks can override these.
          </p>
          <div className="space-y-4">
            <HandoverPolicyRow
              label="Finish policy"
              hint="What to do when a hard-start segment is incoming."
              fieldName="finish_policy"
              options={FINISH_POLICIES}
              labels={{ hard_cut: 'Hard cut', finish_segment: 'Finish segment' } as Record<FinishPolicy, string>}
              register={register}
            />
            <HandoverPolicyRow
              label="Join policy"
              hint="How to enter a clock when the slot starts mid-way through its design length."
              fieldName="join_policy"
              options={JOIN_POLICIES}
              labels={{ join_top: 'Join at top', join_mid: 'Join mid' } as Record<JoinPolicy, string>}
              register={register}
            />
          </div>
        </CollapsibleSection>

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={mutation.isPending || isRestarting}
            className="flex items-center gap-2 px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
    </div>
  );
}

function HandoverPolicyRow<T extends string>({
  label, hint, fieldName, options, labels, register,
}: {
  label: string;
  hint: string;
  fieldName: string;
  options: readonly T[];
  labels: Record<T, string>;
  register: UseFormRegister<SupervisorConfig>;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center gap-1">
        {label}
        <HelpTooltip text={hint} />
      </label>
      <select
        {...register(fieldName as keyof SupervisorConfig)}
        className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-zinc-900">{labels[o]}</option>
        ))}
      </select>
    </div>
  );
}
