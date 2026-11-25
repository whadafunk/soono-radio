import { useState } from 'react';
import { Download, Flag, Trash2, X } from 'lucide-react';
import { RECORDING_FLAGS, RECORDING_FLAG_LABELS, type RecordingArchivePreview, type RecordingFlag } from '@soono/shared';
import { buttonClass, formatBytes, inputClass } from './recordingFormat';

type Panel = 'flag' | 'delete' | null;

// What an archive leaves out, in words; empty when it leaves nothing out.
export function describeLeftOut(preview: RecordingArchivePreview): string {
  const parts: string[] = [];
  if (preview.skipped_active > 0) parts.push(`${preview.skipped_active} still being recorded`);
  if (preview.skipped_missing > 0) parts.push(`${preview.skipped_missing} no longer there`);
  return parts.join(', ');
}

// The actions on the selected recordings. Every confirmation is inline.
export function RecordingSelectionBar({ count, sizeBytes, busy, archivePreview, onDownload, onConfirmDownload, onCancelDownload, onFlag, onDelete, onClear }: {
  count: number;
  sizeBytes: number;
  busy: boolean;
  // Set when the archive would leave something out and the operator must decide.
  archivePreview: RecordingArchivePreview | null;
  onDownload: () => void;
  onConfirmDownload: () => void;
  onCancelDownload: () => void;
  onFlag: (flag: RecordingFlag, set: boolean, note: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [flag, setFlag] = useState<RecordingFlag>('protect');
  const [note, setNote] = useState('');
  const recordings = count === 1 ? 'recording' : 'recordings';

  return (
    <div className="sticky bottom-0 z-10 bg-zinc-800 border border-zinc-600 rounded-lg px-4 py-3 space-y-3 shadow-lg">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-zinc-100 font-medium">{count} selected · {formatBytes(sizeBytes)}</span>
        <button type="button" disabled={busy} onClick={() => { setPanel(null); onDownload(); }} className={buttonClass}>
          <Download className="w-4 h-4" /> Download
        </button>
        <button type="button" disabled={busy} onClick={() => setPanel(panel === 'flag' ? null : 'flag')} className={buttonClass}>
          <Flag className="w-4 h-4" /> Flag
        </button>
        <button type="button" disabled={busy} onClick={() => setPanel(panel === 'delete' ? null : 'delete')} className={buttonClass}>
          <Trash2 className="w-4 h-4" /> Delete
        </button>
        <button type="button" onClick={() => { setPanel(null); onClear(); }} className="ml-auto inline-flex items-center gap-1 text-zinc-300 hover:text-white">
          <X className="w-4 h-4" /> Clear selection
        </button>
      </div>

      {archivePreview && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-amber-200">
          <span>
            The archive will hold {archivePreview.files} of the {count} selected {recordings} ({formatBytes(archivePreview.size_bytes)}). Left out: {describeLeftOut(archivePreview)}.
          </span>
          <button type="button" onClick={onConfirmDownload} className={buttonClass}>Download anyway</button>
          <button type="button" onClick={onCancelDownload} className="text-zinc-300 hover:text-white">Cancel</button>
        </div>
      )}

      {panel === 'flag' && (
        <div className="flex flex-wrap items-end gap-3 text-sm text-zinc-300">
          <label>
            <span className="block mb-1 text-xs">Flag</span>
            <select aria-label="Flag to change" value={flag} onChange={(e) => setFlag(e.target.value as RecordingFlag)} className={inputClass}>
              {RECORDING_FLAGS.map((f) => <option key={f} value={f}>{RECORDING_FLAG_LABELS[f]}</option>)}
            </select>
          </label>
          <label className="flex-1 min-w-[12rem]">
            <span className="block mb-1 text-xs">Note (optional — leave empty to keep notes already there)</span>
            <input type="text" aria-label="Flag note" value={note} maxLength={200} placeholder="e.g. CNA request 1182" onChange={(e) => setNote(e.target.value)} className={`${inputClass} w-full placeholder:text-zinc-500`} />
          </label>
          <button type="button" disabled={busy} onClick={() => { onFlag(flag, true, note.trim()); setNote(''); setPanel(null); }} className={buttonClass}>
            Set on {count} {recordings}
          </button>
          <button type="button" disabled={busy} onClick={() => { onFlag(flag, false, ''); setPanel(null); }} className={buttonClass}>
            Remove from {count} {recordings}
          </button>
          <button type="button" onClick={() => setPanel(null)} className="text-zinc-300 hover:text-white pb-1.5">Cancel</button>
          {flag === 'protect' && (
            <p className="w-full text-xs text-zinc-400">Protected recordings are never deleted — not by the automatic clean-up, not by Delete — until the flag is removed.</p>
          )}
        </div>
      )}

      {panel === 'delete' && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-zinc-200">
          <span>Delete {count} {recordings} ({formatBytes(sizeBytes)})? This cannot be undone. Protected recordings are skipped.</span>
          <button type="button" disabled={busy} onClick={() => { setPanel(null); onDelete(); }} className="px-3 py-1.5 rounded bg-red-900/60 text-red-200 hover:bg-red-800 disabled:opacity-40">
            Delete {count} {recordings}
          </button>
          <button type="button" onClick={() => setPanel(null)} className="text-zinc-300 hover:text-white">Cancel</button>
        </div>
      )}
    </div>
  );
}
