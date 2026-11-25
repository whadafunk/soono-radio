import { useState } from 'react';
import { UseFormRegister, UseFormSetValue, useWatch, Control } from 'react-hook-form';
import {
  LiquidsoapConfig,
  RECORDING_BITRATES,
  RECORDING_SAMPLE_RATES,
  RECORDING_SEGMENT_MINUTES,
  isValidRecordingQuality,
} from '@soono/shared';
import { CollapsibleSection } from '../../../components/CollapsibleSection';

interface Props {
  register: UseFormRegister<LiquidsoapConfig>;
  control: Control<LiquidsoapConfig>;
  setValue: UseFormSetValue<LiquidsoapConfig>;
}

const SAMPLE_RATE_LABELS: Record<number, string> = { 22050: '22.05 kHz', 32000: '32 kHz', 44100: '44.1 kHz' };

// Recording quality and file length (docs/reports-recordings-design.md).
// These live in the Mix Engine's own config because the recording runs inside
// it; retention is set on Reports → Recordings.
export function RecordingSection({ register, control, setValue }: Props) {
  const enabled = useWatch({ control, name: 'recording.enabled' }) ?? true;
  const bitrate = useWatch({ control, name: 'recording.bitrate_kbps' }) ?? 64;
  const samplerate = useWatch({ control, name: 'recording.samplerate_hz' }) ?? 22050;
  const channels = useWatch({ control, name: 'recording.channels' }) ?? 'mono';
  const segment = useWatch({ control, name: 'recording.segment_minutes' }) ?? 60;
  const [note, setNote] = useState<string | null>(null);

  const allowedBitrates = RECORDING_BITRATES.filter((b) => isValidRecordingQuality(b, samplerate));

  // MP3 cannot encode every bitrate at every sample rate: when the sample
  // rate changes, move the bitrate to the nearest one it allows — and say so.
  const changeSampleRate = (next: number) => {
    setValue('recording.samplerate_hz', next, { shouldDirty: true });
    if (isValidRecordingQuality(bitrate, next)) { setNote(null); return; }
    const allowed = RECORDING_BITRATES.filter((b) => isValidRecordingQuality(b, next));
    const nearest = allowed.reduce((best, b) => (Math.abs(b - bitrate) < Math.abs(best - bitrate) ? b : best), allowed[0]);
    setValue('recording.bitrate_kbps', nearest, { shouldDirty: true });
    setNote(`${bitrate} kbps is not possible at ${SAMPLE_RATE_LABELS[next]}; bitrate changed to ${nearest} kbps.`);
  };

  const selectClass = 'w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-brand-500';
  const labelClass = 'block text-sm font-medium text-zinc-300 mb-2';

  return (
    <CollapsibleSection title="Recording">
      <div className="space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            {...register('recording.enabled')}
            className="w-4 h-4 mt-0.5 rounded border-zinc-700 bg-zinc-800 text-brand-600 focus:ring-brand-500"
          />
          <span className="text-sm font-medium text-zinc-200">
            Record the broadcast
            <span className="block text-xs text-zinc-400 font-normal mt-1">
              Writes the station's final output — live shows included — to MP3 files, as proof of what was broadcast. Find them under Reports → Recordings.
            </span>
          </span>
        </label>

        {enabled && (
          <div className="grid gap-4 sm:grid-cols-2 pt-2 border-t border-zinc-800">
            <div>
              <label htmlFor="recording-samplerate" className={labelClass}>Sample rate</label>
              <select id="recording-samplerate" value={samplerate} onChange={(e) => changeSampleRate(Number(e.target.value))} className={selectClass}>
                {RECORDING_SAMPLE_RATES.map((s) => <option key={s} value={s}>{SAMPLE_RATE_LABELS[s]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="recording-bitrate" className={labelClass}>Bitrate</label>
              <select
                id="recording-bitrate"
                value={bitrate}
                onChange={(e) => { setValue('recording.bitrate_kbps', Number(e.target.value), { shouldDirty: true }); setNote(null); }}
                className={selectClass}
              >
                {allowedBitrates.map((b) => <option key={b} value={b}>{b} kbps</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="recording-channels" className={labelClass}>Channels</label>
              <select
                id="recording-channels"
                value={channels}
                onChange={(e) => setValue('recording.channels', e.target.value === 'stereo' ? 'stereo' : 'mono', { shouldDirty: true })}
                className={selectClass}
              >
                <option value="mono">Mono</option>
                <option value="stereo">Stereo</option>
              </select>
            </div>
            <div>
              <label htmlFor="recording-segment" className={labelClass}>File length</label>
              <select
                id="recording-segment"
                value={segment}
                onChange={(e) => {
                  const minutes = Number(e.target.value);
                  setValue('recording.segment_minutes', minutes === 15 ? 15 : minutes === 30 ? 30 : 60, { shouldDirty: true });
                }}
                className={selectClass}
              >
                {RECORDING_SEGMENT_MINUTES.map((m) => <option key={m} value={m}>{m} minutes</option>)}
              </select>
            </div>
          </div>
        )}

        {note && <p className="text-xs text-amber-300">{note}</p>}
        <p className="text-xs text-zinc-400">
          Recording runs inside the Mix Engine. Changes here take effect when the Mix Engine restarts — a few seconds off air. About {Math.round(bitrate * 0.45)} MB per hour at this quality.
        </p>
      </div>
    </CollapsibleSection>
  );
}
