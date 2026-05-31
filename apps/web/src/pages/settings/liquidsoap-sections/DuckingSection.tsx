import { UseFormRegister, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

export function DuckingSection({ register, control }: Props) {
  const enabled = useWatch({ control, name: 'ducking.enabled' }) ?? false;
  const depth = useWatch({ control, name: 'ducking.depth_db' }) ?? -9;
  const attack = useWatch({ control, name: 'ducking.attack_ms' }) ?? 100;
  const release = useWatch({ control, name: 'ducking.release_ms' }) ?? 1000;

  return (
    <CollapsibleSection title="Ducking">
      <div className="space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('ducking.enabled')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Duck the queue under the live source
            <span className="block text-xs text-zinc-500 font-normal mt-1">
              When the DJ is live, the queue (music bed) drops by the depth below. Lets the DJ talk over a music bed without the music drowning their voice.
            </span>
          </span>
          <HelpTooltip text="The trigger source is hardcoded to the harbor (live broadcaster). The ducked source is whatever is in the queue when the DJ is on air." />
        </label>

        {enabled && (
          <div className="space-y-4 pt-2 border-t border-zinc-800">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Depth
                  <HelpTooltip text="How much the queue drops while the DJ is live. -9 dB ≈ half-volume, comfortable for talk-over. -20 dB is near silence." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{depth.toFixed(1)} dB</span>
              </div>
              <input
                type="range"
                min={-30}
                max={0}
                step={0.5}
                {...register('ducking.depth_db', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Attack
                  <HelpTooltip text="How fast the bed drops when the DJ starts talking. Shorter = more responsive but can feel jumpy. 100 ms is a natural default." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{attack} ms</span>
              </div>
              <input
                type="range"
                min={10}
                max={500}
                step={10}
                {...register('ducking.attack_ms', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Release
                  <HelpTooltip text="How fast the bed comes back up after the DJ pauses. Longer = smoother. 1000 ms (1 s) is a typical broadcast value." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{release} ms</span>
              </div>
              <input
                type="range"
                min={100}
                max={3000}
                step={50}
                {...register('ducking.release_ms', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
