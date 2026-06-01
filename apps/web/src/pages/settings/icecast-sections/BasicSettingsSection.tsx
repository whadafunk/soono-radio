import { UseFormRegister, FieldErrors } from 'react-hook-form';
import { IcecastConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<IcecastConfig>;
  errors: FieldErrors<IcecastConfig>;
}

export function BasicSettingsSection({ register, errors }: Props) {
  return (
    <CollapsibleSection title="Basic Settings">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Hostname <span className="text-red-400 ml-0.5">*</span>
            <HelpTooltip text="The domain or IP address where listeners connect. Used for YP directory and stream information." />
          </label>
          <input
            {...register('server.hostname')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            placeholder="radio.example.com"
          />
          {errors.server?.hostname && (
            <p className="text-red-400 text-xs mt-1">{errors.server.hostname.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Location
            <HelpTooltip text="Geographic location of your server. Published in stream metadata and YP directory." />
          </label>
          <input
            {...register('server.location')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            placeholder="New York, USA"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Admin Email <span className="text-red-400 ml-0.5">*</span>
            <HelpTooltip text="Contact email for server notifications and administrative purposes." />
          </label>
          <input
            {...register('server.admin')}
            type="email"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          />
          {errors.server?.admin && (
            <p className="text-red-400 text-xs mt-1">{errors.server.admin.message}</p>
          )}
        </div>
      </div>
    </CollapsibleSection>
  );
}
