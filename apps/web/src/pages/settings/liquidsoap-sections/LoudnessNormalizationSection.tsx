import { UseFormRegister, UseFormSetValue, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig, LUFS_PRESETS } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
  setValue: UseFormSetValue<LiquidsoapConfig>;
}

export function LoudnessNormalizationSection({ register, control, setValue }: Props) {
  const enabled = useWatch({ control, name: 'loudness_normalization.enabled' }) ?? false;
  const targetLufs = useWatch({ control, name: 'loudness_normalization.target_lufs' }) ?? -23;
  const isPreset = LUFS_PRESETS.some((p) => p.value === targetLufs);

  return (
    <CollapsibleSection title="Loudness Normalization">
      <div className="space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('loudness_normalization.enabled')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Apply per-track loudness gain
            <span className="block text-xs text-zinc-500 font-normal mt-1">
              Each track is turned up or down by a fixed amount (computed at ingest from its measured LUFS) so quiet and loud tracks feel similarly loud back-to-back. This is a static per-track gain, not dynamic compression — pair it with the Master Bus limiter below to catch anything it pushes over the ceiling.
            </span>
          </span>
          <HelpTooltip text="Requires tracks to have been analyzed at ingest (Library shows measured LUFS per track). Unanalyzed content plays at its original level." />
        </label>

        {enabled && (
          <div className="space-y-3 pt-2 border-t border-zinc-800">
            <div>
              <label className="text-sm font-medium text-zinc-300 flex items-center mb-2">
                Target Loudness
                <HelpTooltip text="Changing this recomputes the stored gain for every already-analyzed track in the library (no re-analysis needed — just the arithmetic against the target). New uploads are analyzed against whatever target is active at ingest time." />
              </label>
              <select
                value={isPreset ? String(targetLufs) : 'custom'}
                onChange={(e) => {
                  if (e.target.value !== 'custom') {
                    setValue('loudness_normalization.target_lufs', Number(e.target.value), { shouldDirty: true });
                  }
                }}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-brand-500 mb-2"
              >
                {LUFS_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step={0.5}
                  {...register('loudness_normalization.target_lufs', { valueAsNumber: true })}
                  className="w-32 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 font-mono focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <span className="text-xs text-zinc-500">LUFS {isPreset ? '' : '(custom)'}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
