import { UseFormRegister, UseFormSetValue, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig, MASTER_BUS_PRESETS, matchMasterBusPreset } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
  setValue: UseFormSetValue<LiquidsoapConfig>;
}

export function MasterBusSection({ register, control, setValue }: Props) {
  const enabled = useWatch({ control, name: 'master_bus.soft_limiter' }) ?? false;
  const threshold = useWatch({ control, name: 'master_bus.threshold_db' }) ?? -1.0;
  const ratio = useWatch({ control, name: 'master_bus.ratio' }) ?? 20.0;
  const attack = useWatch({ control, name: 'master_bus.attack_ms' }) ?? 5.0;
  const release = useWatch({ control, name: 'master_bus.release_ms' }) ?? 50.0;
  const matchedPreset = matchMasterBusPreset({ threshold_db: threshold, ratio, attack_ms: attack, release_ms: release });

  return (
    <CollapsibleSection title="Master Bus">
      <div className="space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('master_bus.soft_limiter')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Soft limiter
            <span className="block text-xs text-zinc-500 font-normal mt-1">
              A whole-bus safety net, independent of per-track loudness normalization above — catches summed/overlapping sources, live mic input, and anything that pushes past the threshold, no matter the cause. Only engages above the threshold; quiet/normal material is untouched.
            </span>
          </span>
          <HelpTooltip text="Implemented as compress() at a very high ratio (a limiter is just a compressor with a steep enough ratio). It's dynamic and reacts in real time to the live output — unlike the static per-track loudness gain, which is a fixed number decided once per file." />
        </label>

        {enabled && (
          <div className="space-y-4 pt-2 border-t border-zinc-800">
            <div>
              <label className="text-sm font-medium text-zinc-300 flex items-center mb-2">
                Strength
                <HelpTooltip text="Three increasing degrees of limiting, all deliberately kept in soft/musical compressor territory (ratio never exceeds 8:1 — a true brick-wall limiter is usually 10:1+). Pick a preset as a starting point, or fine-tune the sliders below afterward." />
              </label>
              <select
                value={matchedPreset?.key ?? 'custom'}
                onChange={(e) => {
                  const preset = MASTER_BUS_PRESETS.find((p) => p.key === e.target.value);
                  if (!preset) return;
                  setValue('master_bus.threshold_db', preset.threshold_db, { shouldDirty: true });
                  setValue('master_bus.ratio', preset.ratio, { shouldDirty: true });
                  setValue('master_bus.attack_ms', preset.attack_ms, { shouldDirty: true });
                  setValue('master_bus.release_ms', preset.release_ms, { shouldDirty: true });
                }}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {MASTER_BUS_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label} ({p.threshold_db.toFixed(1)} dBFS, {p.ratio.toFixed(0)}:1)
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Threshold
                  <HelpTooltip text="The ceiling — the limiter does nothing at all below this level. -1 dBFS is a conservative default that leaves headroom before true digital clipping." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{threshold.toFixed(1)} dBFS</span>
              </div>
              <input
                type="range"
                min={-12}
                max={0}
                step={0.5}
                {...register('master_bus.threshold_db', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Ratio
                  <HelpTooltip text="How hard it pulls the gain down once the signal crosses threshold. 20:1 behaves like a limiter (near brick-wall); lower ratios (e.g. 4:1) are gentler compression, not limiting." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{ratio.toFixed(0)}:1</span>
              </div>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                {...register('master_bus.ratio', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Attack
                  <HelpTooltip text="How fast gain reduction kicks in once the signal crosses threshold. Faster catches transients better but can sound more audible/pumpy." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{attack.toFixed(1)} ms</span>
              </div>
              <input
                type="range"
                min={1}
                max={50}
                step={0.5}
                {...register('master_bus.attack_ms', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-zinc-300 flex items-center">
                  Release
                  <HelpTooltip text="How fast gain returns to normal after the signal drops back below threshold. Longer is smoother/less audible; shorter recovers loudness faster after a transient." />
                </label>
                <span className="font-mono text-xs text-zinc-400">{release.toFixed(0)} ms</span>
              </div>
              <input
                type="range"
                min={10}
                max={500}
                step={10}
                {...register('master_bus.release_ms', { valueAsNumber: true })}
                className="w-full accent-brand-500"
              />
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
