import { UseFormRegister, FieldErrors, useWatch, Control } from 'react-hook-form';
import { LiquidsoapConfig, CODECS, CODEC_BITRATES, Codec } from '@soono/shared';
import { ListenSocket } from '@soono/shared';
import { HelpTooltip } from '../../../components/HelpTooltip';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  errors: FieldErrors<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
  icecastSockets: ListenSocket[];
}

export function OutputSection({ register, errors, control, icecastSockets }: Props) {
  const codec = (useWatch({ control, name: 'output.codec' }) ?? 'mp3') as Codec;
  const validBitrates = CODEC_BITRATES[codec] ?? CODEC_BITRATES.mp3;

  const plainSockets = icecastSockets.filter((s) => !s.ssl);

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
              Streaming Engine Port
              <HelpTooltip text="The plain-HTTP Icecast socket the Mix Engine pushes audio to. SSL sockets are excluded — LiquidSoap connects as a source over plain HTTP." />
            </label>
            {plainSockets.length > 0 ? (
              <select
                {...register('output.icecast_port', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              >
                {plainSockets.map((s) => (
                  <option key={s.port} value={s.port}>
                    Port {s.port}
                    {s.bind_address && s.bind_address !== '0.0.0.0'
                      ? ` (${s.bind_address})`
                      : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                {...register('output.icecast_port', { valueAsNumber: true })}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white focus:outline-none focus:border-brand-500"
              />
            )}
            {errors.output?.icecast_port && (
              <p className="text-red-400 text-xs mt-1">{errors.output.icecast_port.message}</p>
            )}
            {plainSockets.length === 0 && (
              <p className="text-xs text-zinc-500 mt-1">
                Define a plain-HTTP socket in Streaming Engine settings to get a dropdown here.
              </p>
            )}
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
        </div>

        <div className="pt-4 border-t border-zinc-800 space-y-1 text-sm">
          <p className="text-zinc-400">
            <span className="text-zinc-300 font-medium">Host:</span>{' '}
            <span className="font-mono text-zinc-500">icecast</span>
            <span className="text-zinc-600 text-xs ml-2">(container name on the internal network — not configurable)</span>
          </p>
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
