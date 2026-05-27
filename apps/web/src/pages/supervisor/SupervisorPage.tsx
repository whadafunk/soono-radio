import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Circle,
  Mic2,
  Music2,
  Megaphone,
  Radio,
  FileText,
  Volume2,
  Layers,
  Loader,
  SkipForward,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import type { SupervisorV2PlanItem, SupervisorV2StopSetEstimate } from '@radio/shared';
import {
  fetchSupervisorV2Status,
  postSupervisorSkip,
  postSupervisorPause,
  postSupervisorResume,
} from '../../api';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtMmSs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtDriftSign(seconds: number): string {
  if (Math.abs(seconds) < 0.05) return '0.0s';
  const sign = seconds > 0 ? '+' : '−';
  return `${sign}${Math.abs(seconds).toFixed(1)}s`;
}

function fmtRelativeTime(unixMs: number | null): string {
  if (unixMs === null) return 'never';
  const ago = Math.floor((Date.now() - unixMs) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  return `${Math.floor(ago / 3600)}h ago`;
}

// ─── Content type display ─────────────────────────────────────────────────────

const CONTENT_TYPE_META: Record<
  string,
  { label: string; Icon: React.ElementType; color: string; barColor: string }
> = {
  music:       { label: 'Music',      Icon: Music2,    color: 'text-indigo-400',  barColor: 'bg-indigo-500'  },
  jingle:      { label: 'Jingle',     Icon: Volume2,   color: 'text-cyan-400',    barColor: 'bg-cyan-500'    },
  branding:    { label: 'Branding',   Icon: Radio,     color: 'text-violet-400',  barColor: 'bg-violet-500'  },
  station_id:  { label: 'Station ID', Icon: Radio,     color: 'text-violet-400',  barColor: 'bg-violet-500'  },
  campaign:    { label: 'Campaign',   Icon: Megaphone, color: 'text-amber-400',   barColor: 'bg-amber-500'   },
  promo:       { label: 'Promo',      Icon: Megaphone, color: 'text-orange-400',  barColor: 'bg-orange-500'  },
  rundown:     { label: 'Rundown',    Icon: FileText,  color: 'text-teal-400',    barColor: 'bg-teal-500'    },
  voice_track: { label: 'Voice',      Icon: Mic2,      color: 'text-pink-400',    barColor: 'bg-pink-500'    },
  filler:      { label: 'Filler',     Icon: Layers,    color: 'text-zinc-400',    barColor: 'bg-zinc-500'    },
};

function ContentTypeCell({ type }: { type: string }) {
  const meta = CONTENT_TYPE_META[type] ?? {
    label: type,
    Icon: Circle,
    color: 'text-zinc-400',
    barColor: 'bg-zinc-500',
  };
  const { label, Icon, color } = meta;
  return (
    <span className={`inline-flex items-center gap-1 ${color}`}>
      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="text-xs">{label}</span>
    </span>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; label: string }> = {
    pending:            { cls: 'bg-zinc-800 text-zinc-400',              label: 'pending'    },
    playing:            { cls: 'bg-indigo-600/60 text-indigo-200',       label: 'playing'    },
    played:             { cls: 'bg-zinc-800/60 text-zinc-500',           label: 'played'     },
    dropped:            { cls: 'bg-red-900/40 text-red-400',             label: 'dropped'    },
    skipped:            { cls: 'bg-zinc-800/60 text-zinc-500',           label: 'skipped'    },
    supervisor_skipped: { cls: 'bg-amber-900/40 text-amber-400',         label: 'sv-skipped' },
    operator_skipped:   { cls: 'bg-orange-900/40 text-orange-400',       label: 'op-skipped' },
  };
  const { cls, label } = cfg[status] ?? { cls: 'bg-zinc-800 text-zinc-400', label: status };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase ${cls}`}>
      {label}
    </span>
  );
}

// ─── Control bar ──────────────────────────────────────────────────────────────

function ControlBar({
  paused,
  hasActivePlan,
  liveTakeoverActive,
}: {
  paused: boolean;
  hasActivePlan: boolean;
  liveTakeoverActive: boolean;
}) {
  const queryClient = useQueryClient();

  const skipMutation = useMutation({
    mutationFn: postSupervisorSkip,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const pauseMutation = useMutation({
    mutationFn: postSupervisorPause,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const resumeMutation = useMutation({
    mutationFn: postSupervisorResume,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const skipDisabled = !hasActivePlan || liveTakeoverActive || skipMutation.isPending;
  const toggleDisabled = pauseMutation.isPending || resumeMutation.isPending;

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => skipMutation.mutate()}
        disabled={skipDisabled}
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
          ${skipDisabled
            ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white'
          }`}
      >
        <SkipForward className="w-4 h-4" />
        Skip
      </button>

      {paused ? (
        <button
          onClick={() => resumeMutation.mutate()}
          disabled={toggleDisabled}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
            ${toggleDisabled
              ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
              : 'bg-green-900/40 text-green-300 border border-green-800 hover:bg-green-900/60 hover:text-green-200'
            }`}
        >
          <PlayCircle className="w-4 h-4" />
          Resume
        </button>
      ) : (
        <button
          onClick={() => pauseMutation.mutate()}
          disabled={toggleDisabled}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
            ${toggleDisabled
              ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
              : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white'
            }`}
        >
          <PauseCircle className="w-4 h-4" />
          Pause
        </button>
      )}
    </div>
  );
}

// ─── Segment timeline ─────────────────────────────────────────────────────────

function SegmentTimeline({
  segmentStartedAtMs,
  segmentDurationSeconds,
  planConsumedSeconds,
  planItems,
  expectedCurrentItemEndMs,
}: {
  segmentStartedAtMs: number | null;
  segmentDurationSeconds: number | null;
  planConsumedSeconds: number;
  planItems: SupervisorV2PlanItem[];
  expectedCurrentItemEndMs: number | null;
}) {
  if (segmentStartedAtMs == null || segmentDurationSeconds == null || segmentDurationSeconds <= 0) {
    return (
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Segment Timeline</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-zinc-500 text-sm italic">
          No active segment
        </div>
      </section>
    );
  }

  const nowMs = Date.now();
  const calendarElapsed = Math.max(0, (nowMs - segmentStartedAtMs) / 1000);
  const remaining = Math.max(0, segmentDurationSeconds - calendarElapsed);

  const drift = calendarElapsed - planConsumedSeconds;
  const absDrift = Math.abs(drift);
  const driftCursorColor =
    absDrift < 5 ? 'bg-green-400' : absDrift < 10 ? 'bg-amber-400' : 'bg-red-400';

  // Build item positions: cumulative offset from segment start
  const terminalStatuses = new Set(['played', 'supervisor_skipped', 'operator_skipped', 'dropped']);
  let cursor = 0;
  const itemBlocks: Array<{
    left: number;
    width: number;
    barColor: string;
    isTerminal: boolean;
    label: string;
  }> = [];

  for (const item of planItems) {
    const dur = item.planned_duration_seconds ?? 0;
    const left = (cursor / segmentDurationSeconds) * 100;
    const width = (dur / segmentDurationSeconds) * 100;
    const meta = CONTENT_TYPE_META[item.content_type] ?? { barColor: 'bg-zinc-500', label: item.content_type };
    itemBlocks.push({
      left,
      width,
      barColor: meta.barColor,
      isTerminal: terminalStatuses.has(item.status),
      label: item.media_title ?? item.content_type,
    });
    cursor += dur;
  }

  const calendarCursorLeft = Math.min(100, (calendarElapsed / segmentDurationSeconds) * 100);
  const planCursorLeft = Math.min(100, (planConsumedSeconds / segmentDurationSeconds) * 100);

  const expectedEndLeft =
    expectedCurrentItemEndMs != null
      ? Math.min(100, ((expectedCurrentItemEndMs - segmentStartedAtMs) / 1000 / segmentDurationSeconds) * 100)
      : null;

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Segment Timeline</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        {/* Header stats */}
        <div className="flex items-center gap-6 mb-3 text-xs text-zinc-400">
          <span>
            <span className="text-zinc-300 font-mono">{fmtMmSs(calendarElapsed)}</span>
            {' '}elapsed
          </span>
          <span>
            <span className="text-zinc-300 font-mono">{fmtMmSs(remaining)}</span>
            {' '}remaining
          </span>
          <span>
            drift{' '}
            <span className={`font-mono font-semibold ${
              absDrift < 5 ? 'text-green-400' : absDrift < 10 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {fmtDriftSign(drift)}
            </span>
          </span>
        </div>

        {/* Timeline bar */}
        <div className="relative h-10 bg-zinc-800 rounded overflow-hidden">
          {/* Plan item blocks */}
          {itemBlocks.map((block, i) => (
            <div
              key={i}
              className={`absolute top-1 bottom-1 rounded-sm ${block.barColor} ${block.isTerminal ? 'opacity-30' : 'opacity-70'}`}
              style={{ left: `${block.left}%`, width: `${Math.max(0.3, block.width)}%` }}
              title={block.label}
            />
          ))}

          {/* Plan cursor (colored by drift) */}
          <div
            className={`absolute top-0 bottom-0 w-0.5 ${driftCursorColor}`}
            style={{ left: `${planCursorLeft}%` }}
            title={`Plan: ${fmtMmSs(planConsumedSeconds)}`}
          />

          {/* Expected end of current item */}
          {expectedEndLeft != null && (
            <div
              className="absolute top-0 bottom-0 w-px bg-zinc-500 opacity-60"
              style={{ left: `${expectedEndLeft}%` }}
              title="Expected end of current item"
            />
          )}

          {/* Calendar cursor (white, always on top) */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-white"
            style={{ left: `${calendarCursorLeft}%` }}
            title={`Clock: ${fmtMmSs(calendarElapsed)}`}
          />
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-[10px] text-zinc-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-white inline-block" />wall clock</span>
          <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${driftCursorColor} inline-block`} />plan position</span>
        </div>
      </div>
    </section>
  );
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function LiveTakeoverBanner() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-red-900/30 border border-red-700 rounded-lg">
      <Mic2 className="w-5 h-5 text-red-400 flex-shrink-0" />
      <span className="text-red-300 font-semibold">Live takeover in progress</span>
    </div>
  );
}

function PausedBanner() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-amber-900/30 border border-amber-700 rounded-lg">
      <PauseCircle className="w-5 h-5 text-amber-400 flex-shrink-0" />
      <span className="text-amber-300 font-semibold">Automation paused</span>
    </div>
  );
}

function ActivePlanPanel({ items }: { items: SupervisorV2PlanItem[] }) {
  if (items.length === 0) {
    return (
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Active Plan</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-zinc-500 text-sm italic">
          No active plan — supervisor is idle or between segments.
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">
        Active Plan
        <span className="ml-2 text-xs font-normal text-zinc-400">{items.length} items</span>
      </h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950/50 border-b border-zinc-800">
            <tr>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-10">#</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-28">Type</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Title</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-20">Duration</th>
              <th className="text-center text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-28">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isPlaying = item.status === 'playing';
              const isDim = item.status === 'played' || item.status === 'skipped' || item.status === 'supervisor_skipped' || item.status === 'dropped' || item.status === 'operator_skipped';
              return (
                <tr
                  key={item.id}
                  className={`border-t border-zinc-800/60 ${isPlaying ? 'bg-zinc-700/40' : ''} ${isDim ? 'opacity-50' : ''}`}
                >
                  <td className="px-3 py-2 text-zinc-500 font-mono text-xs">{item.position}</td>
                  <td className="px-3 py-2">
                    <ContentTypeCell type={item.content_type} />
                  </td>
                  <td className="px-3 py-2 text-zinc-300 truncate max-w-xs">
                    <span
                      title={item.reason}
                      className="block truncate"
                    >
                      {item.media_title ?? <span className="text-zinc-500 italic">untitled</span>}
                    </span>
                    {item.reason && (
                      <span className="block text-[10px] text-zinc-500 truncate" title={item.reason}>
                        {item.reason}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                    {fmtMmSs(item.planned_duration_seconds)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <StatusBadge status={item.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DriftPanel({
  driftSeconds,
  lastHeartbeatAt,
}: {
  driftSeconds: number;
  lastHeartbeatAt: number | null;
}) {
  const abs = Math.abs(driftSeconds);
  const driftColor =
    abs < 5 ? 'text-green-400' : abs < 10 ? 'text-amber-400' : 'text-red-400';

  const heartbeatAgo = lastHeartbeatAt
    ? Math.floor((Date.now() - lastHeartbeatAt) / 1000)
    : null;

  const heartbeatStatus =
    heartbeatAgo === null
      ? { label: 'offline', cls: 'text-red-400' }
      : heartbeatAgo < 60
        ? { label: 'ok', cls: 'text-green-400' }
        : heartbeatAgo < 300
          ? { label: 'stale', cls: 'text-amber-400' }
          : { label: 'offline', cls: 'text-red-400' };

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Drift</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex items-center gap-8">
        <div>
          <p className="text-xs text-zinc-400 mb-1">Current drift</p>
          <p className={`text-3xl font-bold font-mono ${driftColor}`}>
            {fmtDriftSign(driftSeconds)}
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            {abs < 5 ? 'On time' : abs < 10 ? 'Minor drift' : 'Significant drift'}
          </p>
        </div>
        <div className="border-l border-zinc-800 pl-8">
          <p className="text-xs text-zinc-400 mb-1">Last heartbeat</p>
          <p className={`text-sm font-medium ${heartbeatStatus.cls}`}>
            {fmtRelativeTime(lastHeartbeatAt)}
          </p>
          <p className={`text-xs mt-1 ${heartbeatStatus.cls}`}>{heartbeatStatus.label}</p>
        </div>
      </div>
    </section>
  );
}

function CampaignPacingPanel({ estimates }: { estimates: SupervisorV2StopSetEstimate[] }) {
  if (estimates.length === 0) {
    return (
      <section>
        <h2 className="text-base font-semibold text-white mb-3">Campaign Pacing</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 text-zinc-500 text-sm italic">
          No stop-set estimates for today.
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Campaign Pacing</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950/50 border-b border-zinc-800">
            <tr>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Segment</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Break</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Hard</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Contested</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Free</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Occupancy</th>
              <th className="text-center text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-24">Status</th>
            </tr>
          </thead>
          <tbody>
            {estimates.map((est) => (
              <tr key={est.id} className="border-t border-zinc-800/60">
                <td className="px-3 py-2 font-mono text-xs text-zinc-400">seg #{est.segment_id}</td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                  {fmtMmSs(est.break_duration_seconds)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                  {fmtMmSs(est.hard_claimed_seconds)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                  {fmtMmSs(est.contested_seconds)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                  {fmtMmSs(est.free_seconds)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-300">
                  {(est.occupation_ratio * 100).toFixed(1)}%
                </td>
                <td className="px-3 py-2 text-center">
                  {est.oversubscribed ? (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase bg-red-900/60 text-red-300">
                      oversubscribed
                    </span>
                  ) : (
                    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase bg-green-900/40 text-green-400">
                      ok
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PROCESSES = [
  'music',
  'campaign',
  'branding',
  'rundown',
  'planner',
  'queueFeeder',
  'supervisor',
] as const;

function ProcessHealthPanel({
  lastHeartbeatAt,
}: {
  lastHeartbeatAt: number | null;
}) {
  const heartbeatAgo = lastHeartbeatAt
    ? Math.floor((Date.now() - lastHeartbeatAt) / 1000)
    : null;

  // All processes run in the same server process; if the supervisor heartbeat
  // is alive, all processes are alive. N/A shown only when heartbeat is absent.
  function getStatus(_processName: string): { label: string; cls: string } {
    if (heartbeatAgo === null) {
      return { label: 'offline', cls: 'text-red-400' };
    }
    if (heartbeatAgo < 60) return { label: 'ok', cls: 'text-green-400' };
    if (heartbeatAgo < 300) return { label: 'stale', cls: 'text-amber-400' };
    return { label: 'offline', cls: 'text-red-400' };
  }

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Process Health</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {PROCESSES.map((name) => {
            const status = getStatus(name);
            const dotCls =
              status.label === 'ok'
                ? 'bg-green-500'
                : status.label === 'stale'
                  ? 'bg-amber-500'
                  : status.label === 'offline'
                    ? 'bg-red-500'
                    : 'bg-zinc-600';

            const heartbeatLabel = fmtRelativeTime(lastHeartbeatAt);

            return (
              <div key={name} className="flex flex-col gap-1 p-2 bg-zinc-800/40 rounded">
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotCls}`} />
                  <span className="text-xs font-medium text-zinc-300 truncate">{name}</span>
                </div>
                <span className={`text-[10px] font-mono ${status.cls}`}>{status.label}</span>
                <span className="text-[10px] text-zinc-500">{heartbeatLabel}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SupervisorPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['supervisor-v2-status'],
    queryFn: fetchSupervisorV2Status,
    refetchInterval: 3000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Supervisor</h1>
          <p className="text-zinc-400 mt-1 text-sm">
            Live visibility into the automation engine
          </p>
        </div>
        <div className="flex items-center gap-4 mt-1">
          {isLoading && (
            <span className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Loader className="w-3 h-3 animate-spin" />
              Loading…
            </span>
          )}
          {!isLoading && !isError && (
            <span className="flex items-center gap-1.5 text-xs text-green-400">
              <Activity className="w-3 h-3" />
              Polling every 3s
            </span>
          )}
          <ControlBar
            paused={data?.paused ?? false}
            hasActivePlan={data?.active_plan_id != null}
            liveTakeoverActive={data?.live_takeover_active ?? false}
          />
        </div>
      </div>

      {isError && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-900/20 border border-red-800 rounded-lg">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <span className="text-red-300 text-sm">
            {(error as Error)?.message ?? 'Failed to fetch supervisor status'}
          </span>
        </div>
      )}

      {data?.live_takeover_active && <LiveTakeoverBanner />}

      {data?.paused && <PausedBanner />}

      {!data?.live_takeover_active && !data?.paused && data?.active_plan_id === null && !isLoading && (
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-800/40 border border-zinc-700 rounded-lg">
          <CheckCircle className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <span className="text-zinc-400 text-sm">No active plan — supervisor is idle.</span>
        </div>
      )}

      <SegmentTimeline
        segmentStartedAtMs={data?.segment_started_at_ms ?? null}
        segmentDurationSeconds={data?.segment_duration_seconds ?? null}
        planConsumedSeconds={data?.plan_consumed_seconds ?? 0}
        planItems={data?.plan_items ?? []}
        expectedCurrentItemEndMs={data?.expected_current_item_end_ms ?? null}
      />

      <DriftPanel
        driftSeconds={data?.current_drift_seconds ?? 0}
        lastHeartbeatAt={data?.last_heartbeat_at ?? null}
      />

      <ProcessHealthPanel lastHeartbeatAt={data?.last_heartbeat_at ?? null} />

      <ActivePlanPanel items={data?.plan_items ?? []} />

      <CampaignPacingPanel estimates={data?.stop_set_estimates ?? []} />
    </div>
  );
}
