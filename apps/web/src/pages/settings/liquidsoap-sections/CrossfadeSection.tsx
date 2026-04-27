import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { LiquidsoapConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
}

export function CrossfadeSection({ register, errors }: Props) {
  return (
    <CollapsibleSection title="Crossfade">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Duration (seconds)
            <HelpTooltip text="How long Liquidsoap crossfades between sources (live ↔ automation). 0 disables crossfading. 3 s is a comfortable default." />
          </label>
          <input
            type="number"
            step="0.1"
            {...register('crossfade.duration_seconds', { valueAsNumber: true })}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          />
          {errors.crossfade?.duration_seconds && (
            <p className="text-red-400 text-xs mt-1">{errors.crossfade.duration_seconds.message}</p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
