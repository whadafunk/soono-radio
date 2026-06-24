import { UseFormRegister } from 'react-hook-form';
import { IcecastConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<IcecastConfig>;
}

export function LoggingSection({ register }: Props) {
  return (
    <CollapsibleSection title="Logging">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Log Level
            <HelpTooltip text="Controls how much Icecast writes to its log files. Info is recommended for production — Debug is verbose and will fill disk quickly." />
          </label>
          <select
            {...register('logging.loglevel')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Log Size (bytes, optional)
            <HelpTooltip text="Maximum size of each log file in bytes before Icecast rotates it. Leave empty for no limit. Example: 10485760 = 10 MB." />
          </label>
          <input
            {...register('logging.logsize', {
              setValueAs: (v) => {
                if (v === '' || v == null) return undefined;
                const n = Number(v);
                return isNaN(n) ? undefined : n;
              },
            })}
            type="number"
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            placeholder="Leave empty for no limit"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Access Log Path
            <HelpTooltip text="Where Icecast writes one line per listener connection. Path is fixed by the container — use docker logs or mount the log directory to read it." />
          </label>
          <input
            {...register('logging.access_log')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500 opacity-75 cursor-not-allowed"
            disabled
          />
          <p className="text-zinc-500 text-xs mt-1">Display only</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Error Log Path
            <HelpTooltip text="Where Icecast writes warnings and errors. Check here first if the stream goes down or clients can't connect." />
          </label>
          <input
            {...register('logging.error_log')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500 opacity-75 cursor-not-allowed"
            disabled
          />
          <p className="text-zinc-500 text-xs mt-1">Display only</p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
