import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Download, Lock, Play, Square, Trash2 } from 'lucide-react';
import { RECORDING_FLAG_LABELS, type RecordingListItem, type RecordingPeriodDay } from '@soono/shared';
import { recordingFileUrl } from '../../api';
import { ConfirmButton } from './ConfirmButton';
import { formatBytes, formatDay, formatDuration, formatTime, recordingKey } from './recordingFormat';

type FileItem = Extract<RecordingListItem, { kind: 'file' }>;
type GapItem = Extract<RecordingListItem, { kind: 'gap' }>;

const GAP_TEXT: Record<GapItem['label'], string> = {
  off_air: '— Off air —',
  interruption: 'Interruption',
  no_recording: 'No recording',
};

// A recording can be selected unless it is still being written.
export const isSelectable = (item: RecordingListItem): item is FileItem => item.kind === 'file' && !item.recording_now;

function DayCheckbox({ state, onChange, label }: { state: 'none' | 'some' | 'all'; onChange: (checked: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === 'some'; }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === 'all'} onChange={(e) => onChange(e.target.checked)} />;
}

// One station day: a summary line that says how much was recorded and how
// much is missing even while collapsed, and the day's rows.
export function RecordingDayGroup({ day, expanded, onToggleExpanded, selection, onSelect, playing, onPlay, onDelete, deleting }: {
  day: RecordingPeriodDay;            // already filtered; totals are the whole day's
  expanded: boolean;
  onToggleExpanded: () => void;
  selection: ReadonlySet<string>;
  onSelect: (keys: string[], selected: boolean) => void;
  playing: string | null;
  onPlay: (key: string | null) => void;
  onDelete: (file: { day: string; name: string }) => void;
  deleting: boolean;
}) {
  const selectable = day.items.filter(isSelectable);
  const selectedCount = selectable.filter((f) => selection.has(recordingKey(f))).length;
  const dayState = selectedCount === 0 ? 'none' : selectedCount === selectable.length ? 'all' : 'some';

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-2.5 text-sm bg-zinc-900">
        {selectable.length > 0
          ? <DayCheckbox state={dayState} label={`Select ${formatDay(day.date)}`} onChange={(checked) => onSelect(selectable.map(recordingKey), checked)} />
          : <span className="w-[13px]" />}
        <button type="button" onClick={onToggleExpanded} aria-expanded={expanded} className="flex flex-1 items-center gap-3 text-left text-zinc-200 hover:text-white">
          {expanded ? <ChevronDown className="w-4 h-4 text-zinc-400" /> : <ChevronRight className="w-4 h-4 text-zinc-400" />}
          <span className="w-40 font-medium">{formatDay(day.date)}</span>
          <span className="text-zinc-300">{formatDuration(day.recorded_ms)} recorded</span>
          {day.no_recording_ms > 0 && (
            <span className="text-amber-300 font-medium">· {formatDuration(day.no_recording_ms)} no recording</span>
          )}
          <span className="ml-auto text-zinc-400 tabular-nums">{formatBytes(day.size_bytes)}</span>
        </button>
      </div>

      {expanded && day.items.map((item) => {
        if (item.kind === 'gap') {
          const seconds = Math.round((item.end_ms - item.start_ms) / 1000);
          return (
            <div key={`gap-${item.start_ms}`} className={`flex items-center gap-3 pl-11 pr-4 ${item.label === 'interruption' ? 'py-1 text-xs text-zinc-400' : 'py-2 text-sm'}`}>
              <span className="w-28 tabular-nums text-zinc-400">{formatTime(item.start_ms)}–{formatTime(item.end_ms)}</span>
              <span className={item.label === 'no_recording' ? 'text-amber-300 font-medium' : 'text-zinc-400'}>
                {GAP_TEXT[item.label]}{item.label === 'interruption' ? ` (${seconds}s)` : ''}
              </span>
            </div>
          );
        }
        const key = recordingKey(item);
        const isProtected = item.flags.some((f) => f.flag === 'protect');
        return (
          <div key={key}>
            <div className="flex items-center gap-3 pl-4 pr-4 py-2 text-sm text-zinc-300">
              {item.recording_now
                ? <span className="w-[13px]" />
                : <input type="checkbox" aria-label={`Select ${formatTime(item.start_ms)}`} checked={selection.has(key)} onChange={(e) => onSelect([key], e.target.checked)} />}
              <span className="w-4" />
              <span className="w-28 tabular-nums">{formatTime(item.start_ms)}–{item.recording_now ? '' : formatTime(item.end_ms)}</span>
              <span className="w-16 text-zinc-400 tabular-nums">{formatBytes(item.size_bytes)}</span>
              <button type="button" onClick={() => onPlay(playing === key ? null : key)} className="inline-flex items-center gap-1 text-zinc-300 hover:text-white">
                {playing === key ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />} {playing === key ? 'Stop' : 'Play'}
              </button>
              <a href={recordingFileUrl(item.day, item.name, true)} className="inline-flex items-center gap-1 text-zinc-300 hover:text-white">
                <Download className="w-4 h-4" /> Download
              </a>
              <span className="flex flex-wrap items-center gap-1.5">
                {item.flags.map((f) => (
                  <span key={f.flag} title={f.note || undefined} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200">
                    {f.flag === 'protect' && <Lock className="w-3 h-3 text-zinc-400" />}
                    {RECORDING_FLAG_LABELS[f.flag]}
                    {f.note && <span className="text-zinc-400 max-w-[16rem] truncate">“{f.note}”</span>}
                  </span>
                ))}
              </span>
              <span className="ml-auto">
                {item.recording_now ? (
                  <span className="text-emerald-400">recording now…</span>
                ) : isProtected ? null : (
                  <ConfirmButton label="Delete" icon={<Trash2 className="w-4 h-4" />} disabled={deleting} onConfirm={() => onDelete({ day: item.day, name: item.name })} />
                )}
              </span>
            </div>
            {playing === key && (
              <div className="pl-11 pr-4 pb-3">
                <audio controls autoPlay preload="metadata" src={recordingFileUrl(item.day, item.name)} className="w-full" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
