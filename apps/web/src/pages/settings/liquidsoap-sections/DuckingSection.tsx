import { UseFormRegister, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

// Only rendered by the parent page when harbor.live_mode === 'mix' — there's
// no separate enabled toggle here, since ducking is simply what mix mode is.
export function DuckingSection({ register, control }: Props) {
  const depth = useWatch({ control, name: 'ducking.depth_db' }) ?? -9;
  const duration = useWatch({ control, name: 'ducking.duration_seconds' }) ?? 1.0;

  return (
    <CollapsibleSection title="Ducking">
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          Presence-based: triggers on whether a live source is connected to the harbor, not on how loud they're talking. When they connect, the queue (music bed) drops by the depth below; when they disconnect, it recovers to full volume.
        </p>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-zinc-300 flex items-center">
              Depth
              <HelpTooltip text="How much the queue drops while a live source is connected. -9 dB ≈ half-volume, comfortable for talk-over. -20 dB is near silence." />
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
              Speed
              <HelpTooltip text="How fast the queue fades down when the live source connects, and back up when it disconnects — one shared speed for both directions. Shorter feels snappier; longer is smoother/less noticeable." />
            </label>
            <span className="font-mono text-xs text-zinc-400">{duration.toFixed(2)} s</span>
          </div>
          <input
            type="range"
            min={0.05}
            max={5}
            step={0.05}
            {...register('ducking.duration_seconds', { valueAsNumber: true })}
            className="w-full accent-brand-500"
          />
        </div>
      </div>
    </CollapsibleSection>
  );
}
