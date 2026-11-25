import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Lock, Play, Settings, Square, Trash2 } from 'lucide-react';
import {
  RecordingHoldCreateSchema,
  localYmd,
  type BroadcastRecordingStatus,
  type RecordingDayItem,
  type RecordingDeleteResult,
  type RecordingRangePreview,
} from '@soono/shared';
import {
  apiErrorMessage,
  createRecordingHold,
  deleteRecordingDay,
  deleteRecordingFile,
  fetchRecordingDay,
  fetchRecordingStatus,
  previewRecordingRange,
  purgeRecordingsBefore,
  recordingFileUrl,
  recordingRangeUrl,
  removeRecordingHold,
} from '../../api';
import { RecordingSettingsPanel } from './RecordingSettingsPanel';

// Reports → Recordings. Dates and times here are typed and shown in the
// browser's timezone, which is the station's (the app is only used from
// Romania — docs/station-timezone-design.md). The API works in station time.

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const formatDateTime = (ms: number) =>
  new Date(ms).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024 ** 2))} MB`;
}

// "YYYY-MM-DD" + "HH:MM" in the browser's zone → ms.
const toMs = (date: string, time: string) => new Date(`${date}T${time}:00`).getTime();

const NOT_RECORDING_REASON: Record<BroadcastRecordingStatus['reason'], string> = {
  ok: '',
  disabled: 'recording is switched off in the Mix Engine settings',
  off_air: 'the station is off air',
  mix_engine_down: 'the Mix Engine is not running',
  not_recording: 'no recording file has been written for over a minute',
};

function describeDeleteResult(r: RecordingDeleteResult): string {
  const parts = [`${r.deleted} deleted`];
  if (r.skipped_held > 0) parts.push(`${r.skipped_held} skipped (held)`);
  if (r.skipped_active > 0) parts.push(`${r.skipped_active} skipped (recording now)`);
  return parts.join(' · ');
}

// Two-step inline confirmation — never a browser pop-up.
function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, disabled, icon }: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
        className="inline-flex items-center gap-1 px-2 py-1 text-sm text-zinc-400 hover:text-red-300 disabled:opacity-40"
        title={label}
      >
        {icon}{label}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <button type="button" onClick={() => { setAsking(false); onConfirm(); }} className="px-2 py-1 rounded bg-red-900/60 text-red-200 hover:bg-red-800">
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setAsking(false)} className="px-2 py-1 text-zinc-300 hover:text-white">
        Cancel
      </button>
    </span>
  );
}

function StatusLine({ status }: { status: BroadcastRecordingStatus }) {
  const recording = status.reason === 'ok';
  const daysKept = status.oldest_start_ms == null ? 0 : Math.floor((Date.now() - status.oldest_start_ms) / 86_400_000);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-300">
        <span className={recording ? 'text-emerald-400 font-medium' : 'text-amber-300 font-medium'}>
          ● {recording ? 'Recording' : `Not recording — ${NOT_RECORDING_REASON[status.reason]}`}
        </span>
        <span>{formatBytes(status.used_bytes)} used</span>
        <span>{daysKept} {daysKept === 1 ? 'day' : 'days'} kept</span>
        <span>{status.free_bytes == null ? 'recordings folder not found' : `${formatBytes(status.free_bytes)} free`}</span>
      </div>
      {status.settings_damaged && (
        <p className="text-sm text-amber-300">
          The retention settings file is damaged, so automatic deletion is paused and nothing is being deleted. Open Settings and save to repair it.
        </p>
      )}
      {status.last_sweep?.floor_unmet && (
        <p className="text-sm text-amber-300">
          Disk space is below the floor and nothing more can be deleted: what remains is held or younger than the protected age.
        </p>
      )}
    </div>
  );
}

const GAP_TEXT: Record<Extract<RecordingDayItem, { kind: 'gap' }>['label'], string> = {
  off_air: '— Off air —',
  interruption: 'Interruption',
  no_recording: 'No recording',
};

export function RecordingsTab() {
  const queryClient = useQueryClient();
  const today = localYmd();
  const [date, setDate] = useState(today);
  const [playing, setPlaying] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  const { data: status } = useQuery({ queryKey: ['recording-status'], queryFn: fetchRecordingStatus, refetchInterval: 15_000 });
  const { data: day, isLoading, error } = useQuery({
    queryKey: ['recording-day', date],
    queryFn: () => fetchRecordingDay(date),
    refetchInterval: date === today ? 30_000 : false,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['recording-day'] });
    queryClient.invalidateQueries({ queryKey: ['recording-status'] });
  };
  const report = (r: RecordingDeleteResult) => { setMessage({ type: 'info', text: describeDeleteResult(r) }); refresh(); };
  const fail = (err: unknown) => setMessage({ type: 'error', text: apiErrorMessage(err) });

  const deleteFile = useMutation({ mutationFn: (f: { day: string; name: string }) => deleteRecordingFile(f.day, f.name), onSuccess: report, onError: fail });
  const deleteDay = useMutation({ mutationFn: deleteRecordingDay, onSuccess: report, onError: fail });
  const purge = useMutation({ mutationFn: purgeRecordingsBefore, onSuccess: report, onError: fail });
  const removeHold = useMutation({ mutationFn: removeRecordingHold, onSuccess: refresh, onError: fail });

  // ── Download a range ───────────────────────────────────────────────────────
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [rangeGaps, setRangeGaps] = useState<{ fromMs: number; toMs: number; preview: RecordingRangePreview } | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);

  const startRangeDownload = async () => {
    setRangeError(null);
    setRangeGaps(null);
    if (!rangeFrom || !rangeTo) { setRangeError('Choose a start and an end time.'); return; }
    const fromMs = toMs(date, rangeFrom);
    const toMsValue = toMs(date, rangeTo);
    setRangeBusy(true);
    try {
      const preview = await previewRecordingRange(fromMs, toMsValue);
      // A file that may be handed to an authority must never hide missing
      // minutes: show them and let the operator decide.
      if (preview.gaps.length > 0) setRangeGaps({ fromMs, toMs: toMsValue, preview });
      else window.location.assign(recordingRangeUrl(fromMs, toMsValue));
    } catch (err) {
      setRangeError(apiErrorMessage(err));
    } finally {
      setRangeBusy(false);
    }
  };

  // ── Holds ──────────────────────────────────────────────────────────────────
  const [holdFrom, setHoldFrom] = useState('');
  const [holdTo, setHoldTo] = useState('');
  const [holdNote, setHoldNote] = useState('');
  const [holdError, setHoldError] = useState<string | null>(null);
  const createHold = useMutation({
    mutationFn: createRecordingHold,
    onSuccess: () => { setHoldFrom(''); setHoldTo(''); setHoldNote(''); setHoldError(null); refresh(); },
    onError: (err) => setHoldError(apiErrorMessage(err)),
  });
  const submitHold = () => {
    if (!holdFrom || !holdTo) { setHoldError('Choose when the kept period starts and ends.'); return; }
    const parsed = RecordingHoldCreateSchema.safeParse({
      from_ms: new Date(holdFrom).getTime(),
      to_ms: new Date(holdTo).getTime(),
      note: holdNote,
    });
    if (!parsed.success) { setHoldError(parsed.error.issues[0]?.message ?? 'Check the kept period.'); return; }
    setHoldError(null);
    createHold.mutate(parsed.data);
  };

  const [purgeBefore, setPurgeBefore] = useState('');
  const holdNoteFor = (startMs: number, endMs: number) =>
    day?.holds.find((h) => h.from_ms < endMs && h.to_ms > startMs)?.note ?? '';

  const inputClass = 'bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200';
  const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm disabled:opacity-40';

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        {status ? <StatusLine status={status} /> : <span className="text-sm text-zinc-400">Checking recording status…</span>}
        <button type="button" onClick={() => setShowSettings((v) => !v)} className={buttonClass}>
          <Settings className="w-4 h-4" /> Settings
        </button>
      </div>

      {showSettings && <RecordingSettingsPanel />}

      <div className="flex flex-wrap items-end gap-6">
        <label className="text-sm text-zinc-300">
          <span className="block mb-1">Date</span>
          <input type="date" value={date} max={today} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setPlaying(null); setRangeGaps(null); } }} className={inputClass} />
        </label>
        <div className="text-sm text-zinc-300">
          <span className="block mb-1">Download a time range as one file</span>
          <div className="flex items-center gap-2">
            <input type="time" aria-label="Range start" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} className={inputClass} />
            <span className="text-zinc-400">–</span>
            <input type="time" aria-label="Range end" value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} className={inputClass} />
            <button type="button" onClick={startRangeDownload} disabled={rangeBusy} className={buttonClass}>
              <Download className="w-4 h-4" /> {rangeBusy ? 'Checking…' : 'Download range'}
            </button>
          </div>
          {rangeError && <p className="text-red-400 text-xs mt-1">{rangeError}</p>}
        </div>
      </div>

      {rangeGaps && (
        <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-3 text-sm text-amber-200 space-y-2">
          <p className="font-medium">This range is not fully recorded. Missing:</p>
          <ul className="list-disc list-inside">
            {rangeGaps.preview.gaps.map((g) => (
              <li key={g.start_ms}>{formatTime(g.start_ms)}–{formatTime(g.end_ms)} missing</li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <button type="button" className={buttonClass} onClick={() => { window.location.assign(recordingRangeUrl(rangeGaps.fromMs, rangeGaps.toMs)); setRangeGaps(null); }}>
              Download anyway
            </button>
            <button type="button" className="text-zinc-300 hover:text-white" onClick={() => setRangeGaps(null)}>Cancel</button>
          </div>
        </div>
      )}

      {message && (
        <p className={`text-sm ${message.type === 'error' ? 'text-red-400' : 'text-zinc-300'}`}>{message.text}</p>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
        {isLoading && <p className="p-4 text-sm text-zinc-400">Loading…</p>}
        {error != null && <p className="p-4 text-sm text-red-400">{apiErrorMessage(error)}</p>}
        {day && day.items.length === 0 && <p className="p-4 text-sm text-zinc-400">Nothing to show for this day yet.</p>}
        {day?.items.map((item) => {
          if (item.kind === 'gap') {
            const seconds = Math.round((item.end_ms - item.start_ms) / 1000);
            return (
              <div key={`gap-${item.start_ms}`} className={`flex items-center gap-4 px-4 ${item.label === 'interruption' ? 'py-1 text-xs text-zinc-400' : 'py-2 text-sm'}`}>
                <span className="w-28 tabular-nums text-zinc-400">{formatTime(item.start_ms)}–{formatTime(item.end_ms)}</span>
                <span className={item.label === 'no_recording' ? 'text-amber-300 font-medium' : 'text-zinc-400'}>
                  {GAP_TEXT[item.label]}{item.label === 'interruption' ? ` (${seconds}s)` : ''}
                </span>
              </div>
            );
          }
          const key = `${item.day}/${item.name}`;
          return (
            <div key={key}>
              <div className="flex items-center gap-4 px-4 py-2 text-sm text-zinc-300">
                <span className="w-28 tabular-nums">{formatTime(item.start_ms)}–{item.recording_now ? '' : formatTime(item.end_ms)}</span>
                <span className="w-16 text-zinc-400 tabular-nums">{formatBytes(item.size_bytes)}</span>
                <button type="button" onClick={() => setPlaying(playing === key ? null : key)} className="inline-flex items-center gap-1 text-zinc-300 hover:text-white">
                  {playing === key ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />} {playing === key ? 'Stop' : 'Play'}
                </button>
                <a href={recordingFileUrl(item.day, item.name, true)} className="inline-flex items-center gap-1 text-zinc-300 hover:text-white">
                  <Download className="w-4 h-4" /> Download
                </a>
                <span className="ml-auto">
                  {item.recording_now ? (
                    <span className="text-emerald-400">recording now…</span>
                  ) : item.held ? (
                    <span className="inline-flex items-center gap-1 text-zinc-300" title="Held recordings are never deleted">
                      <Lock className="w-4 h-4 text-zinc-400" /> held · “{holdNoteFor(item.start_ms, item.end_ms)}”
                    </span>
                  ) : (
                    <ConfirmButton label="Delete" icon={<Trash2 className="w-4 h-4" />} disabled={deleteFile.isPending} onConfirm={() => deleteFile.mutate({ day: item.day, name: item.name })} />
                  )}
                </span>
              </div>
              {playing === key && (
                <div className="px-4 pb-3">
                  <audio controls autoPlay preload="metadata" src={recordingFileUrl(item.day, item.name)} className="w-full" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-200">Keep a period</h2>
          <p className="text-xs text-zinc-400">
            Recordings that overlap a kept period are never deleted — not by retention, not by the disk floor, not by a purge — until the hold is removed.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-300"><span className="block mb-1">From</span>
              <input type="datetime-local" value={holdFrom} onChange={(e) => setHoldFrom(e.target.value)} className={inputClass} />
            </label>
            <label className="text-xs text-zinc-300"><span className="block mb-1">To</span>
              <input type="datetime-local" value={holdTo} onChange={(e) => setHoldTo(e.target.value)} className={inputClass} />
            </label>
            <label className="text-xs text-zinc-300 flex-1 min-w-[10rem]"><span className="block mb-1">Why</span>
              <input type="text" value={holdNote} maxLength={200} placeholder="e.g. CNA request 1182" onChange={(e) => setHoldNote(e.target.value)} className={`${inputClass} w-full placeholder:text-zinc-500`} />
            </label>
            <button type="button" onClick={submitHold} disabled={createHold.isPending} className={buttonClass}>
              <Lock className="w-4 h-4" /> Keep
            </button>
          </div>
          {holdError && <p className="text-red-400 text-xs">{holdError}</p>}
          {day && day.holds.length > 0 && (
            <ul className="text-sm text-zinc-300 divide-y divide-zinc-800">
              {day.holds.map((h) => (
                <li key={h.id} className="flex items-center gap-3 py-1.5">
                  <span className="tabular-nums">{formatDateTime(h.from_ms)} – {formatDateTime(h.to_ms)}</span>
                  <span className="text-zinc-400 truncate">“{h.note}”</span>
                  <span className="ml-auto"><ConfirmButton label="Remove" onConfirm={() => removeHold.mutate(h.id)} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-200">Purge</h2>
          <p className="text-xs text-zinc-400">Deleted recordings cannot be recovered. Held recordings and the file being written are always skipped.</p>
          <div className="flex items-center gap-3 text-sm text-zinc-300">
            <span>Everything recorded on {date}:</span>
            <ConfirmButton label="Delete this day" confirmLabel={`Delete ${date}`} icon={<Trash2 className="w-4 h-4" />} disabled={deleteDay.isPending} onConfirm={() => deleteDay.mutate(date)} />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
            <span>Everything older than</span>
            <input type="date" aria-label="Purge before" value={purgeBefore} max={today} onChange={(e) => setPurgeBefore(e.target.value)} className={inputClass} />
            <ConfirmButton label="Delete older" confirmLabel={`Delete everything before ${purgeBefore}`} icon={<Trash2 className="w-4 h-4" />} disabled={!purgeBefore || purge.isPending} onConfirm={() => purge.mutate(purgeBefore)} />
          </div>
        </section>
      </div>
    </div>
  );
}
