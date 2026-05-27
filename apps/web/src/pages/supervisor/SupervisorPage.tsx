import { useQuery } from '@tanstack/react-query';
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
} from 'lucide-react';
import type { SupervisorV2PlanItem, SupervisorV2StopSetEstimate } from '@radio/shared';
import { fetchSupervisorV2Status } from '../../api';

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
  { label: string; Icon: React.ElementType; color: string }
> = {
  music:      { label: 'Music',      Icon: Music2,    color: 'text-indigo-400'  },
  jingle:     { label: 'Jingle',     Icon: Volume2,   color: 'text-cyan-400'    },
  branding:   { label: 'Branding',   Icon: Radio,     color: 'text-violet-400'  },
  station_id: { label: 'Station ID', Icon: Radio,     color: 'text-violet-400'  },
  campaign:   { label: 'Campaign',   Icon: Megaphone, color: 'text-amber-400'   },
  promo:      { label: 'Promo',      Icon: Megaphone, color: 'text-orange-400'  },
  rundown:    { label: 'Rundown',    Icon: FileText,  color: 'text-teal-400'    },
  voice_track: { label: 'Voice',     Icon: Mic2,      color: 'text-pink-400'    },
  filler:     { label: 'Filler',     Icon: Layers,    color: 'text-zinc-400'    },
};

function ContentTypeCell({ type }: { type: string }) {
  const meta = CONTENT_TYPE_META[type] ?? {
    label: type,
    Icon: Circle,
    color: 'text-zinc-400',
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
    pending:           { cls: 'bg-zinc-800 text-zinc-400',              label: 'pending'    },
    playing:           { cls: 'bg-indigo-600/60 text-indigo-200',       label: 'playing'    },
    played:            { cls: 'bg-zinc-800/60 text-zinc-500',           label: 'played'     },
    dropped:           { cls: 'bg-red-900/40 text-red-400',             label: 'dropped'    },
    skipped:           { cls: 'bg-zinc-800/60 text-zinc-500',           label: 'skipped'    },
    supervisor_skipped:{ cls: 'bg-amber-900/40 text-amber-400',         label: 'sv-skipped' },
    operator_skipped:  { cls: 'bg-orange-900/40 text-orange-400',       label: 'op-skipped' },
  };
  const { cls, label } = cfg[status] ?? { cls: 'bg-zinc-800 text-zinc-400', label: status };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase ${cls}`}>
      {label}
    </span>
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

  function getStatus(processName: string): { label: string; cls: string } {
    if (processName !== 'supervisor') {
      return { label: 'N/A', cls: 'text-zinc-500' };
    }
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

            const heartbeatLabel =
              name === 'supervisor'
                ? fmtRelativeTime(lastHeartbeatAt)
                : 'N/A';

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
        <div className="flex items-center gap-2 mt-1">
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

      {!data?.live_takeover_active && data?.active_plan_id === null && !isLoading && (
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-800/40 border border-zinc-700 rounded-lg">
          <CheckCircle className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <span className="text-zinc-400 text-sm">No active plan — supervisor is idle.</span>
        </div>
      )}

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
