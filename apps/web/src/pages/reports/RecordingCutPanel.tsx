import { useState } from 'react';
import { Download } from 'lucide-react';
import type { RecordingRangePreview } from '@soono/shared';
import { apiErrorMessage, previewRecordingRange, recordingRangeUrl } from '../../api';
import { buttonClass, formatTime, inputClass } from './recordingFormat';

// An exact stretch of time as ONE audio file ("14:20 to 14:35"), cut and
// joined from the recordings it spans. For whole recordings, select them in
// the list and download the archive instead.
export function RecordingCutPanel() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gaps, setGaps] = useState<{ fromMs: number; toMs: number; preview: RecordingRangePreview } | null>(null);

  const start = async () => {
    setError(null);
    setGaps(null);
    if (!from || !to) { setError('Choose when the cut starts and ends.'); return; }
    // datetime-local values are read in the browser's zone, which is the station's.
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    setBusy(true);
    try {
      const preview = await previewRecordingRange(fromMs, toMs);
      // A file that may be handed to an authority must never hide missing
      // minutes: show them and let the operator decide.
      if (preview.gaps.length > 0) setGaps({ fromMs, toMs, preview });
      else window.location.assign(recordingRangeUrl(fromMs, toMs));
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-zinc-200">Cut exact time</h2>
      <p className="text-xs text-zinc-400">One audio file from an exact start to an exact end, up to 24 hours. It can cross midnight.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-zinc-300"><span className="block mb-1">From</span>
          <input type="datetime-local" aria-label="Cut start" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </label>
        <label className="text-xs text-zinc-300"><span className="block mb-1">To</span>
          <input type="datetime-local" aria-label="Cut end" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </label>
        <button type="button" onClick={start} disabled={busy} className={buttonClass}>
          <Download className="w-4 h-4" /> {busy ? 'Checking…' : 'Download cut'}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {gaps && (
        <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-3 text-sm text-amber-200 space-y-2">
          <p className="font-medium">This stretch is not fully recorded. Missing:</p>
          <ul className="list-disc list-inside">
            {gaps.preview.gaps.map((g) => (
              <li key={g.start_ms}>{formatTime(g.start_ms)}–{formatTime(g.end_ms)} missing</li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <button type="button" className={buttonClass} onClick={() => { window.location.assign(recordingRangeUrl(gaps.fromMs, gaps.toMs)); setGaps(null); }}>
              Download anyway
            </button>
            <button type="button" className="text-zinc-300 hover:text-white" onClick={() => setGaps(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
