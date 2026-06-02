import { UseFormRegister } from 'react-hook-form';
import { LiquidsoapConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
}

export function LoggingSection({ register }: Props) {
  return (
    <CollapsibleSection title="Logging">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center gap-1">
            Log Level
            <HelpTooltip text="Controls verbosity. Important (3) is recommended for production — Info (4) adds track and request detail, Debug (5) is very verbose." />
          </label>
          <select
            {...register('logging.level', { valueAsNumber: true })}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
          >
            <option value={1}>1 — Critical</option>
            <option value={2}>2 — Severe</option>
            <option value={3}>3 — Important (recommended)</option>
            <option value={4}>4 — Info</option>
            <option value={5}>5 — Debug</option>
          </select>
        </div>
        <div className="flex items-center justify-between py-2">
          <div className="flex items-center gap-1">
            <span className="text-sm font-medium text-zinc-300">Log to file</span>
            <HelpTooltip text="Writes logs to logs/liquidsoap/liquidsoap.log on the host. Stdout logging is always on regardless of this setting." />
          </div>
          <input
            type="checkbox"
            {...register('logging.file_enabled')}
            className="w-4 h-4 rounded border-zinc-600 bg-zinc-800 text-brand-500 focus:ring-brand-500 focus:ring-offset-zinc-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2">Log file path</label>
          <input
            value="/var/log/liquidsoap/liquidsoap.log → logs/liquidsoap/liquidsoap.log on host"
            readOnly
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 text-sm opacity-75 cursor-not-allowed"
          />
          <p className="text-zinc-500 text-xs mt-1">Display only — path is fixed by the container</p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
