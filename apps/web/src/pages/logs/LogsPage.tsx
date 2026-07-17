import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ChevronDown, ChevronRight, HardDrive, Pause, Play,
  RefreshCcw, Scissors, Trash2,
} from 'lucide-react';
import type { LogEntry, LogSourceId, LogSourceInfo } from '@soono/shared';
import { fetchLogSources, fetchLogTail, purgeLogSource, rotateLogSource } from '../../api';

// ─── View presets ─────────────────────────────────────────────────────────────
// Supervisor / Planner / Content Pickers are filter presets over the single
// structured supervisor.log stream (selected via the `process` field);
// LiquidSoap and Icecast are genuinely separate text sources; Problems is a
// severity preset (warn+error) across the structured sources.
interface ViewDef {
  id: string;
  label: string;
  sources: LogSourceId[];
  process?: string;
  levelMin?: number;
  structured: boolean;
}

const VIEWS: ViewDef[] = [
  // The whole engine stream interleaved (no process filter) — the forensic
  // view for following one plan across planner/supervisor/feeder.
  { id: 'engine', label: 'Engine (all)', sources: ['supervisor'], structured: true },
  { id: 'supervisor', label: 'Supervisor', sources: ['supervisor'], process: 'supervisor,queueFeeder', structured: true },
  { id: 'planner', label: 'Planner', sources: ['supervisor'], process: 'planner', structured: true },
  { id: 'content', label: 'Content Pickers', sources: ['supervisor'], process: 'music,campaign,branding,rundown', structured: true },
  { id: 'api', label: 'API', sources: ['api'], structured: true },
  { id: 'liquidsoap', label: 'LiquidSoap', sources: ['liquidsoap'], structured: false },
  { id: 'icecast', label: 'Icecast', sources: ['icecast-error'], structured: false },
  { id: 'problems', label: 'Problems', sources: ['supervisor', 'api'], levelMin: 40, structured: true },
];

const LEVEL_OPTIONS = [
  { value: 0, label: 'All levels' },
  { value: 30, label: 'Info +' },
  { value: 40, label: 'Warn +' },
  { value: 50, label: 'Error only' },
];

const LIMIT_OPTIONS = [200, 500, 1000];

function levelBadge(level: number | null) {
  if (level == null) return null;
  if (level >= 50) return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-900/50 border border-red-700 text-red-300">ERROR</span>;
  if (level >= 40) return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/50 border border-amber-700 text-amber-300">WARN</span>;
  if (level >= 30) return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-900/50 border border-sky-800 text-sky-300">INFO</span>;
  return <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-800 border border-zinc-700 text-zinc-400">DEBUG</span>;
}

function formatTs(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function LogRow({ entry, structured }: { entry: LogEntry; structured: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-zinc-800/60">
      <button
        className="w-full flex items-start gap-2 px-2 py-1 text-left font-mono text-xs hover:bg-zinc-900/70"
        onClick={() => setExpanded((v) => !v)}
      >
        {structured ? (
          expanded
            ? <ChevronDown className="w-3 h-3 mt-0.5 text-zinc-400 flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 mt-0.5 text-zinc-400 flex-shrink-0" />
        ) : null}
        {entry.ts_ms != null && (
          <span className="text-zinc-400 flex-shrink-0">{formatTs(entry.ts_ms)}</span>
        )}
        {levelBadge(entry.level)}
        {entry.process && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 border border-zinc-700 text-zinc-300 flex-shrink-0">
            {entry.process}
          </span>
        )}
        {entry.event && <span className="text-brand-300 flex-shrink-0">{entry.event}</span>}
        <span className="text-zinc-300 break-all">{entry.msg}</span>
      </button>
      {expanded && structured && (
        <pre className="mx-2 mb-2 p-2 rounded bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all">
          {prettyRaw(entry.raw)}
        </pre>
      )}
    </div>
  );
}

function MaintenanceCard({ sources }: { sources: LogSourceInfo[] }) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['log-sources'] });
    queryClient.invalidateQueries({ queryKey: ['log-tail'] });
  };
  const rotateMut = useMutation({ mutationFn: rotateLogSource, onSettled: invalidate });
  const purgeMut = useMutation({ mutationFn: purgeLogSource, onSettled: invalidate });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center gap-2 mb-3">
        <HardDrive className="w-4 h-4 text-zinc-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Log files</h2>
      </div>
      <div className="space-y-2">
        {sources.map((s) => {
          const rotatedBytes = s.rotated_files.reduce((acc, f) => acc + f.size_bytes, 0);
          return (
            <div key={s.id} className="flex items-center gap-3 text-xs">
              <span className="w-32 text-zinc-300">{s.label}</span>
              {s.available ? (
                <>
                  <span className="text-zinc-400 font-mono w-20">{formatBytes(s.size_bytes)}</span>
                  <span className="text-zinc-400 w-40">
                    {s.rotated_files.length > 0
                      ? `+ ${s.rotated_files.length} rotated (${formatBytes(rotatedBytes)})`
                      : 'no rotated files'}
                  </span>
                  {s.can_rotate && (
                    <button
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                      onClick={() => rotateMut.mutate(s.id)}
                      title="Close the current file and start a fresh one"
                    >
                      <Scissors className="w-3 h-3" /> Rotate
                    </button>
                  )}
                  <button
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-900 text-red-300 hover:bg-red-950/40"
                    onClick={() => {
                      if (window.confirm(`Clear all ${s.label} logs? This deletes rotated files and empties the current one.`)) {
                        purgeMut.mutate(s.id);
                      }
                    }}
                    title="Delete rotated files and empty the current file"
                  >
                    <Trash2 className="w-3 h-3" /> Clear
                  </button>
                </>
              ) : (
                <span className="text-zinc-400">not available</span>
              )}
            </div>
          );
        })}
      </div>
      {(rotateMut.error || purgeMut.error) && (
        <p className="mt-2 text-xs text-red-400">
          {String((rotateMut.error ?? purgeMut.error as Error)?.message ?? '')}
        </p>
      )}
    </div>
  );
}

export function LogsPage() {
  // Deep links (e.g. the Supervisor page's plan-story modal) can preconfigure
  // the view and search: /logs?view=engine&q="plan_id":8617
  const params = new URLSearchParams(window.location.search);
  const initialView = VIEWS.some((v) => v.id === params.get('view')) ? params.get('view')! : 'supervisor';
  const [viewId, setViewId] = useState<string>(initialView);
  const [icecastFile, setIcecastFile] = useState<LogSourceId>('icecast-error');
  const [levelMin, setLevelMin] = useState(0);
  const [eventFilter, setEventFilter] = useState('');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [limit, setLimit] = useState(200);
  const [live, setLive] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);

  const view = VIEWS.find((v) => v.id === viewId)!;
  const sources = view.id === 'icecast' ? [icecastFile] : view.sources;
  const effectiveLevelMin = Math.max(levelMin, view.levelMin ?? 0);

  const { data: sourcesData } = useQuery({
    queryKey: ['log-sources'],
    queryFn: fetchLogSources,
    refetchInterval: 30_000,
  });

  const tailQueries = useQuery({
    queryKey: ['log-tail', sources, view.process, effectiveLevelMin, eventFilter, search, limit],
    queryFn: async () => {
      const results = await Promise.all(
        sources.map((source) =>
          fetchLogTail({
            source,
            limit,
            level_min: effectiveLevelMin > 0 ? effectiveLevelMin : undefined,
            process: view.process,
            event: eventFilter || undefined,
            q: search || undefined,
          }),
        ),
      );
      return results;
    },
    refetchInterval: live ? 5_000 : false,
  });

  const entries = useMemo(() => {
    const all = (tailQueries.data ?? []).flatMap((r) => r.entries);
    if (sources.length > 1) {
      all.sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0));
    }
    return all.slice(-limit);
  }, [tailQueries.data, sources.length, limit]);

  return (
    <div className="p-6 max-w-[1400px]">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-zinc-100">Logs</h1>
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
          onClick={() => setShowMaintenance((v) => !v)}
        >
          <HardDrive className="w-4 h-4" />
          Maintenance
        </button>
      </div>
      <p className="text-sm text-zinc-400 mb-4">Structured event streams from every component</p>

      {showMaintenance && sourcesData && (
        <div className="mb-4">
          <MaintenanceCard sources={sourcesData.sources} />
        </div>
      )}

      {/* View tabs */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={`px-3 py-1.5 rounded-md text-sm ${
              v.id === viewId
                ? 'bg-zinc-800 text-zinc-100 border border-zinc-600'
                : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
            } ${v.id === 'problems' ? 'inline-flex items-center gap-1' : ''}`}
            onClick={() => setViewId(v.id)}
          >
            {v.id === 'problems' && <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />}
            {v.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {view.id === 'icecast' && (
          <select
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300"
            value={icecastFile}
            onChange={(e) => setIcecastFile(e.target.value as LogSourceId)}
          >
            <option value="icecast-error">error.log</option>
            <option value="icecast-access">access.log</option>
          </select>
        )}
        {view.structured && (
          <>
            <select
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300"
              value={levelMin}
              onChange={(e) => setLevelMin(Number(e.target.value))}
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <input
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300 w-48 placeholder:text-zinc-500"
              placeholder="Event (e.g. PLAN_)"
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
            />
          </>
        )}
        <input
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300 w-64 placeholder:text-zinc-500"
          placeholder='Search (e.g. "plan_id":8617)'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-300"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {LIMIT_OPTIONS.map((n) => (
            <option key={n} value={n}>{n} lines</option>
          ))}
        </select>
        <button
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm ${
            live
              ? 'border-green-800 text-green-300 bg-green-950/30'
              : 'border-zinc-700 text-zinc-300'
          }`}
          onClick={() => setLive((v) => !v)}
        >
          {live ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          {live ? 'Live (5s)' : 'Paused'}
        </button>
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
          onClick={() => tailQueries.refetch()}
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${tailQueries.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Log lines */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        {tailQueries.isLoading ? (
          <p className="p-4 text-sm text-zinc-400">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="p-4 text-sm text-zinc-400">No log lines match the current filters.</p>
        ) : (
          <div className="max-h-[65vh] overflow-y-auto">
            {entries.map((entry, i) => (
              <LogRow key={`${entry.ts_ms ?? 0}-${i}`} entry={entry} structured={view.structured} />
            ))}
          </div>
        )}
      </div>
      {tailQueries.data && (
        <p className="mt-2 text-xs text-zinc-400">
          Showing the most recent matches within the last{' '}
          {formatBytes(Math.max(...tailQueries.data.map((r) => r.scanned_bytes), 0))} of each file.
        </p>
      )}
    </div>
  );
}
