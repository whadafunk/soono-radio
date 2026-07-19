import { UseFormRegister, FieldErrors, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig, FADE_SHAPES } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

export function CrossfadeSection({ register, errors, control }: Props) {
  const smart = useWatch({ control, name: 'crossfade.smart' }) ?? false;

  return (
    <CollapsibleSection title="Crossfade">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Duration (seconds)
              <HelpTooltip text="How long tracks crossfade into each other within the automation queue. 0 disables crossfading. Applies only between automation tracks — live DJ handoffs are always a hard cut. 3 s is a comfortable default." />
            </label>
            <input
              type="number"
              step="0.1"
              {...register('crossfade.duration_seconds', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            />
            {errors.crossfade?.duration_seconds && (
              <p className="text-red-400 text-xs mt-1">{errors.crossfade.duration_seconds.message}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Fade Shape
              <HelpTooltip text="The volume ramp curve. Only takes effect when Smart Crossfade (below) is off — LiquidSoap's smart-crossfade transition always uses a sinusoidal fade internally, regardless of this setting." />
            </label>
            <select
              {...register('crossfade.fade_shape')}
              disabled={smart}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {FADE_SHAPES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            {smart && (
              <p className="text-xs text-zinc-500 mt-1">Ignored while Smart Crossfade is on (always sinusoidal).</p>
            )}
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('crossfade.smart')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Smart Crossfade
            <span className="block text-xs text-zinc-500 font-normal mt-1">
              LiquidSoap compares the volume level of the outgoing and incoming track and picks the transition accordingly — full crossfade when both are similarly leveled, a fade-out-only or fade-in-only when one is much louder, or no fade at all when levels are too mismatched to overlap cleanly.
            </span>
          </span>
          <HelpTooltip text="A different mechanism than the fade shape above — this decides WHICH transition to use per track pair based on loudness, not the shape of any single fade." />
        </label>
      </div>
    </CollapsibleSection>
  );
}
