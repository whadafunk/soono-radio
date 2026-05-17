import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Play, Loader2, ArrowLeft, Music, Mic, Megaphone, Radio } from 'lucide-react';
import { fetchSimulate } from '../../api';
import type { SimulatedPlay } from '@radio/shared';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Default range: tomorrow 00:00 to 23:59 local time. */
function defaultRange(): { from: string; to: string } {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const end = new Date(tomorrow.getTime() + ONE_DAY_MS - 1);
  return {
    from: toLocalInput(tomorrow),
    to: toLocalInput(end),
  };
}

/** Convert a Date to "YYYY-MM-DDTHH:mm" — the format <input type="datetime-local"> expects. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(s: string): Date {
  return new Date(s);
}

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SEGMENT_TYPE_ICONS: Record<string, typeof Music> = {
  music: Music,
  news: Radio,
  bulletin: Radio,
  voice_track: Mic,
  live: Mic,
  live_audience: Mic,
  stop_set: Megaphone,
};

const SEGMENT_TYPE_COLORS: Record<string, string> = {
  music: 'text-indigo-300',
  news: 'text-amber-300',
  bulletin: 'text-amber-300',
  voice_track: 'text-emerald-300',
  live: 'text-rose-300',
  live_audience: 'text-rose-300',
  stop_set: 'text-violet-300',
};

export function SchedulePreviewPage() {
  const init = defaultRange();
  const [fromStr, setFromStr] = useState(init.from);
  const [toStr, setToStr] = useState(init.to);
  const [results, setResults] = useState<SimulatedPlay[] | null>(null);

  const sim = useMutation({
    mutationFn: () => fetchSimulate(fromLocalInput(fromStr), fromLocalInput(toStr)),
    onSuccess: (plays) => setResults(plays),
  });

  // Group results by the hour each pick begins. Stop_set / live placeholders
  // join their containing hour naturally because their `at` is the moment the
  // segment starts.
  const grouped = results
    ? results.reduce<Map<string, SimulatedPlay[]>>((acc, p) => {
        const hourKey = `${p.at.getFullYear()}-${String(p.at.getMonth() + 1).padStart(2, '0')}-${String(p.at.getDate()).padStart(2, '0')} ${String(p.at.getHours()).padStart(2, '0')}:00`;
        if (!acc.has(hourKey)) acc.set(hourKey, []);
        acc.get(hourKey)!.push(p);
        return acc;
      }, new Map<string, SimulatedPlay[]>())
    : null;

  const totalDurationS = results?.reduce(
    (sum, p) => sum + (p.media?.duration_seconds ?? 0),
    0,
  );

  return (
    <div className="space-y-5 h-full flex flex-col">
      <div className="flex items-center gap-3">
        <Link
          to="/schedule"
          className="text-zinc-400 hover:text-zinc-200 transition flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to schedule
        </Link>
      </div>
      <div>
        <h1 className="text-3xl font-bold text-white">Schedule Preview</h1>
        <p className="text-zinc-400 mt-2">
          Walks the predictor forward from the start date and shows what the picker would air.
          Doesn't touch the live stream — useful for sanity-checking clock and campaign configuration.
        </p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">From</label>
            <input
              type="datetime-local"
              value={fromStr}
              onChange={(e) => setFromStr(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">To</label>
            <input
              type="datetime-local"
              value={toStr}
              onChange={(e) => setToStr(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={() => sim.mutate()}
              disabled={sim.isPending}
              className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm transition disabled:opacity-40"
            >
              {sim.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {sim.isPending ? 'Simulating…' : 'Generate preview'}
            </button>
          </div>
        </div>
        <p className="text-xs text-zinc-500">
          Maximum window: 7 days · maximum picks: 2000. Spans larger than that are truncated.
        </p>
        {sim.error && (
          <p className="text-xs text-rose-400">{(sim.error as Error).message}</p>
        )}
      </div>

      {results && (
        <div className="flex-1 min-h-0 overflow-auto bg-zinc-900 border border-zinc-800 rounded-lg">
          <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-400 z-10">
            {results.length} picks generated · total music airtime ~ {formatDuration(totalDurationS ?? 0)}
          </div>
          {results.length === 0 ? (
            <p className="text-sm text-zinc-500 italic px-4 py-3">
              No picks — likely no schedule covers this date range.
            </p>
          ) : (
            <div className="divide-y divide-zinc-800">
              {grouped &&
                [...grouped.entries()].map(([hourLabel, plays]) => (
                  <div key={hourLabel}>
                    <div className="sticky top-9 bg-zinc-900/95 backdrop-blur border-b border-zinc-800/60 px-4 py-1.5 text-xs font-medium text-zinc-300">
                      {hourLabel}
                    </div>
                    <table className="w-full text-sm">
                      <tbody>
                        {plays.map((p, i) => {
                          const Icon = SEGMENT_TYPE_ICONS[p.segment_type] ?? Music;
                          const color = SEGMENT_TYPE_COLORS[p.segment_type] ?? 'text-zinc-400';
                          return (
                            <tr key={`${hourLabel}-${i}`} className="hover:bg-zinc-800/30">
                              <td className="px-4 py-1.5 text-zinc-500 font-mono text-xs whitespace-nowrap w-20">
                                {formatTime(p.at)}
                              </td>
                              <td className="px-2 py-1.5 w-6">
                                <Icon className={`w-3.5 h-3.5 ${color}`} />
                              </td>
                              <td className="px-2 py-1.5 text-xs text-zinc-500 whitespace-nowrap w-32 truncate">
                                {p.clock_name} · {p.segment_name}
                              </td>
                              <td className="px-2 py-1.5 text-zinc-200">
                                {p.media ? (
                                  <span>
                                    {p.media.title ?? p.media.original_filename}
                                    {p.media.artist ? (
                                      <span className="text-zinc-500"> — {p.media.artist}</span>
                                    ) : null}
                                  </span>
                                ) : (
                                  <span className="italic text-zinc-500">
                                    {p.segment_type === 'stop_set'
                                      ? `${p.segment_type} (not simulated)`
                                      : `${p.segment_type} segment`}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-xs text-zinc-500 w-16 text-right">
                                {p.media ? formatDuration(p.media.duration_seconds) : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-xs text-zinc-600 max-w-md truncate" title={p.reason}>
                                {p.reason}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
