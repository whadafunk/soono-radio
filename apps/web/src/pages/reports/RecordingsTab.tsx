import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Scissors, Settings, Trash2 } from 'lucide-react';
import {
  EMPTY_RECORDING_FILTER,
  RECORDING_FLAG_LABELS,
  addDaysYmd,
  filterPeriodDays,
  localYmd,
  type BroadcastRecordingStatus,
  type RecordingArchivePreview,
  type RecordingDeleteResult,
  type RecordingFilter,
  type RecordingFlag,
  type RecordingRef,
} from '@soono/shared';
import {
  apiErrorMessage,
  deleteRecordingFile,
  deleteRecordingSelection,
  downloadRecordingArchive,
  fetchRecordingPeriod,
  fetchRecordingStatus,
  previewRecordingArchive,
  purgeRecordingsBefore,
  setRecordingFlag,
} from '../../api';
import { ConfirmButton } from './ConfirmButton';
import { RecordingCutPanel } from './RecordingCutPanel';
import { RecordingDayGroup, isSelectable } from './RecordingDayGroup';
import { RecordingFilterBar } from './RecordingFilterBar';
import { RecordingSelectionBar } from './RecordingSelectionBar';
import { RecordingSettingsPanel } from './RecordingSettingsPanel';
import { buttonClass, formatBytes, inputClass, recordingKey } from './recordingFormat';

// Reports → Recordings (docs/reports-recordings-list-design.md). One list
// over a period, grouped by station day; recordings are selected across days
// and then downloaded as an archive, flagged or deleted. Dates and times are
// typed and shown in the browser's timezone, which is the station's (the app
// is only used from Romania — docs/station-timezone-design.md).

const NOT_RECORDING_REASON: Record<BroadcastRecordingStatus['reason'], string> = {
  ok: '',
  disabled: 'recording is switched off in the Mix Engine settings',
  off_air: 'the station is off air',
  mix_engine_down: 'the Mix Engine is not running',
  not_recording: 'no recording file has been written for over a minute',
};

function describeDeleteResult(r: RecordingDeleteResult): string {
  const parts = [`${r.deleted} deleted`];
  if (r.skipped_protected > 0) parts.push(`${r.skipped_protected} skipped (protected)`);
  if (r.skipped_active > 0) parts.push(`${r.skipped_active} skipped (recording now)`);
  return parts.join(' · ');
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
          Disk space is below the floor and nothing more can be deleted: what remains is protected or younger than the protected age.
        </p>
      )}
    </div>
  );
}

export function RecordingsTab() {
  const queryClient = useQueryClient();
  const today = localYmd();
  const [period, setPeriod] = useState({ from: addDaysYmd(today, -6), to: today });
  const [filter, setFilter] = useState<RecordingFilter>(EMPTY_RECORDING_FILTER);
  // Days the operator opened or closed by hand; the rest follow the default.
  const [expandedOverride, setExpandedOverride] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showCut, setShowCut] = useState(false);
  const [message, setMessage] = useState<{ type: 'info' | 'error'; text: string } | null>(null);
  const [archivePreview, setArchivePreview] = useState<RecordingArchivePreview | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [purgeBefore, setPurgeBefore] = useState('');

  const { data: status } = useQuery({ queryKey: ['recording-status'], queryFn: fetchRecordingStatus, refetchInterval: 15_000 });
  const { data, isLoading, error } = useQuery({
    queryKey: ['recording-period', period.from, period.to],
    queryFn: () => fetchRecordingPeriod(period.from, period.to),
    refetchInterval: period.to >= today ? 30_000 : false,
    placeholderData: (previous) => previous,
  });

  const days = useMemo(() => filterPeriodDays(data?.days ?? [], filter), [data, filter]);
  // The recordings on screen that can be selected, by key.
  const selectable = useMemo(() => {
    const byKey = new Map<string, { ref: RecordingRef; sizeBytes: number }>();
    for (const day of days) {
      for (const item of day.items) {
        if (isSelectable(item)) byKey.set(recordingKey(item), { ref: { day: item.day, name: item.name }, sizeBytes: item.size_bytes });
      }
    }
    return byKey;
  }, [days]);

  // A recording that is no longer on screen (filtered out, deleted, another
  // period) leaves the selection, so the count always matches what is seen.
  useEffect(() => {
    setSelection((current) => {
      const kept = [...current].filter((key) => selectable.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
    setArchivePreview(null);
  }, [selectable]);

  const selected = useMemo(() => [...selection].flatMap((key) => {
    const entry = selectable.get(key);
    return entry ? [entry] : [];
  }), [selection, selectable]);
  const selectedRefs = selected.map((s) => s.ref);
  const selectedBytes = selected.reduce((sum, s) => sum + s.sizeBytes, 0);

  const select = (keys: string[], on: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      for (const key of keys) { if (on) next.add(key); else next.delete(key); }
      return next;
    });
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['recording-period'] });
    queryClient.invalidateQueries({ queryKey: ['recording-status'] });
  };
  const info = (text: string) => setMessage({ type: 'info', text });
  const fail = (err: unknown) => setMessage({ type: 'error', text: apiErrorMessage(err) });
  const reportDelete = (r: RecordingDeleteResult) => { info(describeDeleteResult(r)); refresh(); };

  const deleteFile = useMutation({ mutationFn: (f: RecordingRef) => deleteRecordingFile(f.day, f.name), onSuccess: reportDelete, onError: fail });
  const deleteSelection = useMutation({ mutationFn: deleteRecordingSelection, onSuccess: reportDelete, onError: fail });
  const purge = useMutation({ mutationFn: purgeRecordingsBefore, onSuccess: reportDelete, onError: fail });
  const flag = useMutation({
    mutationFn: setRecordingFlag,
    onSuccess: (r, change) => {
      const label = RECORDING_FLAG_LABELS[change.flag];
      info(change.set ? `${label} set on ${r.changed} ${r.changed === 1 ? 'recording' : 'recordings'}` : `${label} removed from ${r.changed} ${r.changed === 1 ? 'recording' : 'recordings'}`);
      refresh();
    },
    onError: fail,
  });

  const sendArchive = (preview: RecordingArchivePreview) => {
    downloadRecordingArchive(selectedRefs, (text) => setMessage({ type: 'error', text }));
    setArchivePreview(null);
    info(`Downloading ${preview.files} ${preview.files === 1 ? 'recording' : 'recordings'} (${formatBytes(preview.size_bytes)}) as one archive.`);
  };
  const startArchive = async () => {
    setMessage(null);
    setArchivePreview(null);
    setArchiveBusy(true);
    try {
      const preview = await previewRecordingArchive(selectedRefs);
      // Something would be left out: say so before the download starts.
      if (preview.skipped_active > 0 || preview.skipped_missing > 0) setArchivePreview(preview);
      else sendArchive(preview);
    } catch (err) {
      fail(err);
    } finally {
      setArchiveBusy(false);
    }
  };

  const isExpanded = (date: string) => expandedOverride[date] ?? (filter.noRecordingOnly || date === today);
  const busy = archiveBusy || deleteSelection.isPending || flag.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        {status ? <StatusLine status={status} /> : <span className="text-sm text-zinc-400">Checking recording status…</span>}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowCut((v) => !v)} className={buttonClass}>
            <Scissors className="w-4 h-4" /> Cut exact time…
          </button>
          <button type="button" onClick={() => setShowSettings((v) => !v)} className={buttonClass}>
            <Settings className="w-4 h-4" /> Settings
          </button>
        </div>
      </div>

      {showSettings && <RecordingSettingsPanel />}
      {showCut && <RecordingCutPanel />}

      <RecordingFilterBar
        from={period.from}
        to={period.to}
        today={today}
        onPeriod={(from, to) => { setPeriod({ from, to }); setPlaying(null); setExpandedOverride({}); }}
        filter={filter}
        onFilter={(next) => { setFilter(next); setExpandedOverride({}); }}
      />

      {message && (
        <p className={`text-sm ${message.type === 'error' ? 'text-red-400' : 'text-zinc-300'}`}>{message.text}</p>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
        {isLoading && <p className="p-4 text-sm text-zinc-400">Loading…</p>}
        {error != null && <p className="p-4 text-sm text-red-400">{apiErrorMessage(error)}</p>}
        {data && days.length === 0 && (
          <p className="p-4 text-sm text-zinc-400">
            {data.days.length === 0 ? 'Nothing to show for this period yet.' : 'Nothing in this period matches the filters.'}
          </p>
        )}
        {days.map((day) => (
          <RecordingDayGroup
            key={day.date}
            day={day}
            expanded={isExpanded(day.date)}
            onToggleExpanded={() => setExpandedOverride((o) => ({ ...o, [day.date]: !isExpanded(day.date) }))}
            selection={selection}
            onSelect={select}
            playing={playing}
            onPlay={setPlaying}
            onDelete={(f) => deleteFile.mutate(f)}
            deleting={deleteFile.isPending}
          />
        ))}
      </div>

      {selected.length > 0 && (
        <RecordingSelectionBar
          count={selected.length}
          sizeBytes={selectedBytes}
          busy={busy}
          archivePreview={archivePreview}
          onDownload={startArchive}
          onConfirmDownload={() => { if (archivePreview) sendArchive(archivePreview); }}
          onCancelDownload={() => setArchivePreview(null)}
          onFlag={(f: RecordingFlag, set, note) => flag.mutate({ files: selectedRefs, flag: f, set, note: note === '' ? undefined : note })}
          onDelete={() => deleteSelection.mutate(selectedRefs)}
          onClear={() => setSelection(new Set())}
        />
      )}

      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-200">Purge</h2>
        <p className="text-xs text-zinc-400">Deleted recordings cannot be recovered. Protected recordings and the one being recorded are always skipped.</p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          <span>Everything older than</span>
          <input type="date" aria-label="Purge before" value={purgeBefore} max={today} onChange={(e) => setPurgeBefore(e.target.value)} className={inputClass} />
          <ConfirmButton label="Delete older" confirmLabel={`Delete everything before ${purgeBefore}`} icon={<Trash2 className="w-4 h-4" />} disabled={!purgeBefore || purge.isPending} onConfirm={() => purge.mutate(purgeBefore)} />
        </div>
      </section>
    </div>
  );
}
