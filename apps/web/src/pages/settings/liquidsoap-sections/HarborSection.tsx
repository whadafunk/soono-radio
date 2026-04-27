import { Control, UseFormRegister, Controller, FieldErrors } from 'react-hook-form';
import { LiquidsoapConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { PasswordInput } from '../../../components/PasswordInput';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  control: Control<LiquidsoapConfig>;
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
}

export function HarborSection({ control, register, errors }: Props) {
  return (
    <CollapsibleSection title="Live Input (Harbor)">
      <div className="space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('harbor.enabled')}
            className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-sm font-medium text-zinc-200">Accept live broadcasts</span>
          <HelpTooltip text="When enabled, broadcasters (e.g., BUTT) can connect directly to Liquidsoap, which takes over the stream and crossfades back to automation when they disconnect." />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Harbor Port
              <HelpTooltip text="TCP port broadcasters connect to. Default 8005. Must not collide with Icecast (8000)." />
            </label>
            <input
              type="number"
              {...register('harbor.port', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Mount Name
              <HelpTooltip text="The mount name broadcasters point at. Just the name (no leading slash) — e.g., 'live'." />
            </label>
            <input
              {...register('harbor.mount_name')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              placeholder="live"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Harbor Password
            <HelpTooltip text="Password broadcasters use to authenticate against Liquidsoap's harbor. Independent from Icecast's source password." />
          </label>
          <Controller
            name="harbor.password"
            control={control}
            render={({ field }) => (
              <PasswordInput value={field.value} onChange={field.onChange} />
            )}
          />
          {errors.harbor?.password && (
            <p className="text-red-400 text-xs mt-1">{errors.harbor.password.message}</p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
