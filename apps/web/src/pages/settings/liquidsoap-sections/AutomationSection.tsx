import { UseFormRegister, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig } from '@radio/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

export function AutomationSection({ register, control }: Props) {
  const mode = useWatch({ control, name: 'automation.mode' });

  return (
    <CollapsibleSection title="Automation">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Source Mode
            <HelpTooltip text="What plays when no live broadcaster is connected. 'Silence' is the V1 default. 'Playlist' will become useful in Phase 3 once the audio library lands." />
          </label>
          <select
            {...register('automation.mode')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
          >
            <option value="silence">Silence</option>
            <option value="playlist">Playlist (directory)</option>
          </select>
        </div>

        {mode === 'playlist' && (
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Playlist Directory
              <HelpTooltip text="Container path Liquidsoap watches for audio files. Files dropped in here are played in order on reload." />
            </label>
            <input
              {...register('automation.playlist_dir')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-indigo-500"
              placeholder="/audio/automation"
            />
            <p className="text-xs text-zinc-500 mt-2">
              Maps to <code className="font-mono text-zinc-400">liquidsoap/audio/</code> on the host. Reload mode is{' '}
              <code className="font-mono text-zinc-400">watch</code> — drops are picked up automatically.
            </p>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
