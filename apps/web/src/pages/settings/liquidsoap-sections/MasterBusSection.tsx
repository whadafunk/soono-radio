import { UseFormRegister } from 'react-hook-form';
import { LiquidsoapConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
}

export function MasterBusSection({ register }: Props) {
  return (
    <CollapsibleSection title="Master Bus">
      <div className="space-y-3">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('master_bus.soft_limiter')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Soft limiter at −1 dBFS
            <span className="block text-xs text-zinc-500 font-normal mt-1">
              Catches occasional transients without squashing dynamics. Off by default — turn it on if you ever see clipping in listener feedback.
            </span>
          </span>
          <HelpTooltip text="Implemented as a normalize() with a tight ceiling. It only engages above -1 dBFS, so quiet/normal material is untouched." />
        </label>
      </div>
    </CollapsibleSection>
  );
}
