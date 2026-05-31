import { UseFormRegister } from 'react-hook-form';
import { IcecastConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<IcecastConfig>;
}

export function LimitsSection({ register }: Props) {
  return (
    <CollapsibleSection title="Limits">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Max Sources
            <HelpTooltip text="Maximum number of broadcasters that can stream simultaneously. Set to 1-2 for solo shows, higher for multi-host setups." />
          </label>
          <input
            {...register('limits.max_sources', { valueAsNumber: true })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Max Clients
            <HelpTooltip text="Maximum number of listeners across all mounts. Depends on your bandwidth." />
          </label>
          <input
            {...register('limits.max_clients', { valueAsNumber: true })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Queue Size (bytes)
            <HelpTooltip text="Audio buffer size. Increase if experiencing audio dropouts, decrease to reduce memory usage." />
          </label>
          <input
            {...register('limits.max_queue_size', { valueAsNumber: true })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Burst Size (bytes)
            <HelpTooltip text="Initial burst of data sent to new listeners for faster startup." />
          </label>
          <input
            {...register('limits.burst_size', { valueAsNumber: true })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          />
        </div>
      </div>
    </CollapsibleSection>
  );
}
