import { UseFormRegister, useWatch, Control, Controller } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { LiquidsoapConfig } from '@soono/shared';
import { fetchPlaylists } from '../../../api';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

export function SilenceDetectionSection({ register, control }: Props) {
  const threshold = useWatch({ control, name: 'silence_detection.threshold_seconds' }) ?? 5;
  const fallback = useWatch({ control, name: 'silence_detection.fallback' }) ?? 'none';

  const { data: rawPlaylists = [] } = useQuery({
    queryKey: ['playlists'],
    queryFn: fetchPlaylists,
    enabled: fallback === 'playlist',
  });
  const playlists = rawPlaylists.filter(p => (p.total_seconds ?? 0) > 0 || p.kind === 'dynamic');

  return (
    <CollapsibleSection title="Silence Detection">
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-1">
              Default threshold
              <HelpTooltip text="How long silence must persist on the harbor input before the fallback kicks in. Live segments can override this per-segment." />
            </label>
            <span className="font-mono text-xs text-zinc-400">{threshold} s</span>
          </div>
          <input
            type="range"
            min={1}
            max={60}
            step={1}
            {...register('silence_detection.threshold_seconds', { valueAsNumber: true })}
            className="w-full accent-brand-500"
          />
          <div className="flex justify-between text-xs text-zinc-600 mt-1">
            <span>1 s</span>
            <span>60 s</span>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Fallback
          </label>
          <select
            {...register('silence_detection.fallback')}
            className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-brand-500"
          >
            <option value="none" className="bg-zinc-900">None — accept silence</option>
            <option value="playlist" className="bg-zinc-900">Switch to playlist</option>
          </select>
        </div>

        {fallback === 'playlist' && (
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1.5">
              Fallback playlist
            </label>
            <Controller
              control={control}
              name="silence_detection.fallback_playlist_id"
              render={({ field }) => (
                <select
                  value={field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.value === '' ? null : Number(e.target.value))}
                  className="w-full px-3 py-1.5 bg-zinc-900 border border-zinc-700 rounded text-sm text-zinc-300 cursor-pointer focus:outline-none focus:border-brand-500"
                >
                  <option value="" className="bg-zinc-900">— select a playlist —</option>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id} className="bg-zinc-900">{p.name}</option>
                  ))}
                </select>
              )}
            />
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
