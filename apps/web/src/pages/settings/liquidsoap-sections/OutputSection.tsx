import { UseFormRegister, FieldErrors, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig, CODECS, CODEC_BITRATES, Codec } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
}

export function OutputSection({ register, errors, control }: Props) {
  const codec = (useWatch({ control, name: 'output.codec' }) ?? 'mp3') as Codec;
  const validBitrates = CODEC_BITRATES[codec] ?? CODEC_BITRATES.mp3;

  return (
    <CollapsibleSection title="Output">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Codec
              <HelpTooltip text="Output audio codec. MP3 is universally compatible. Opus has the best quality-per-byte. AAC needs the fdk-aac library in the container." />
            </label>
            <select
              {...register('output.codec')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            >
              {CODECS.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Bitrate
              <HelpTooltip text="Higher = better quality, more bandwidth. 128 kbps MP3 is the radio default; Opus sounds equivalent at half the bitrate." />
            </label>
            <select
              {...register('output.bitrate_kbps', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            >
              {validBitrates.map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Streaming Engine Host
              <HelpTooltip text="Where the Mix Engine connects to the Streaming Engine. Use host.docker.internal when both run as containers." />
            </label>
            <input
              {...register('output.icecast_host')}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              placeholder="host.docker.internal"
            />
            {errors.output?.icecast_host && (
              <p className="text-red-400 text-xs mt-1">{errors.output.icecast_host.message}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
              Streaming Engine Port
              <HelpTooltip text="The Streaming Engine port the Mix Engine publishes to. Plain HTTP — typically 8001 in this project (8000 listeners-facing reserved for SSL)." />
            </label>
            <input
              type="number"
              {...register('output.icecast_port', { valueAsNumber: true })}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-zinc-300 mb-2 flex items-center">
            Mount Path
            <HelpTooltip text="The mount path the Mix Engine publishes to on the Streaming Engine. Listeners hit this path." />
          </label>
          <input
            {...register('output.icecast_mount')}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
            placeholder="/stream"
          />
        </div>

        <div className="pt-4 border-t border-zinc-800 space-y-1 text-sm">
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">User:</span>{' '}
            <span className="font-mono text-zinc-500">source</span>
          </p>
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">Source password:</span>{' '}
            <span className="font-mono text-zinc-500">●●●●●●●● (auto-synced from Streaming Engine settings)</span>
          </p>
        </div>
      </div>
    </CollapsibleSection>
  );
}
