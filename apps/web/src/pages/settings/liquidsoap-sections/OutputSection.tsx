import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { LiquidsoapConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
}

export function OutputSection({ register, errors }: Props) {
  return (
    <CollapsibleSection title="Icecast Output">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Icecast Host
              <HelpTooltip text="Where Liquidsoap connects to Icecast. Use host.docker.internal when both run as containers." />
            </label>
            <input
              {...register('output.icecast_host')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              placeholder="host.docker.internal"
            />
            {errors.output?.icecast_host && (
              <p className="text-red-400 text-xs mt-1">{errors.output.icecast_host.message}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Icecast Port
              <HelpTooltip text="The Icecast HTTP port. Defaults to 8000." />
            </label>
            <input
              type="number"
              {...register('output.icecast_port', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Mount Path
            <HelpTooltip text="The Icecast mount Liquidsoap publishes to. Listeners hit this path." />
          </label>
          <input
            {...register('output.icecast_mount')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            placeholder="/stream"
          />
        </div>

        <div className="pt-4 border-t border-zinc-800 space-y-2 text-sm">
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">Codec:</span>{' '}
            <span className="font-mono text-zinc-500">MP3 128 kbps · 44.1 kHz · stereo (fixed for V1)</span>
          </p>
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">User:</span>{' '}
            <span className="font-mono text-zinc-500">source</span>
          </p>
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">Source password:</span>{' '}
            <span className="font-mono text-zinc-500">●●●●●●●● (auto-synced from Icecast settings)</span>
          </p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
