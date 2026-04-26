import { UseFormRegister } from 'react-hook-form';
import { IcecastConfig } from '@radio/shared';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<IcecastConfig>;
}

export function LoggingSection({ register }: Props) {
  return (
    <CollapsibleSection title="Logging">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Log Level</label>
          <select
            {...register('logging.loglevel')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">
            Log Size (bytes, optional)
          </label>
          <input
            {...register('logging.logsize', { valueAsNumber: true })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
            placeholder="Leave empty for no limit"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Access Log Path</label>
          <input
            {...register('logging.access_log')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 opacity-75 cursor-not-allowed"
            disabled
          />
          <p className="text-zinc-500 text-xs mt-1">Display only</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Error Log Path</label>
          <input
            {...register('logging.error_log')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500 opacity-75 cursor-not-allowed"
            disabled
          />
          <p className="text-zinc-500 text-xs mt-1">Display only</p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
