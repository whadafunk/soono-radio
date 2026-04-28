import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { LiquidsoapConfig, CROSSFADE_TYPES } from '@radio/shared';
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
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Duration (seconds)
              <HelpTooltip text="How long the Mix Engine crossfades between sources (live ↔ queue). 0 disables crossfading. 3 s is a comfortable default." />
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
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Type
              <HelpTooltip text="Linear: equal-power volume ramp. Smart: Liquidsoap analyses both tracks and picks fade lengths automatically. Logarithmic: log-curve fade — more natural to the ear on long crossfades." />
            </label>
            <select
              {...register('crossfade.type')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            >
              {CROSSFADE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
