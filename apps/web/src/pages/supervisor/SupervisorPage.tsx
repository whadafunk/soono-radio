import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Circle,
  Clock,
  Mic2,
  Loader,
  SkipForward,
} from 'lucide-react';
import { useState } from 'react';
import type {
  SupervisorV2PlanItem,
  SupervisorV2StopSetEstimate,
  SupervisorV2CurrentSegment,
  SupervisorV2NextPlan,
  SupervisorV2RecentPlay,
  SupervisorV2SegmentConfig,
} from '@soono/shared';
import {
  fetchSupervisorV2Status,
  postSupervisorSkip,
  postSupervisorAlignToWallClock,
  postSupervisorAlignToClock,
} from '../../api';
import {
  fmtMmSs,
  fmtDriftSign,
  fmtRelativeTime,
  CONTENT_TYPE_META,
  ContentTypeCell,
  heartbeatStatus,
} from '../../lib/supervisorV2Ui';

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; label: string }> = {
    pending:            { cls: 'bg-zinc-800 text-zinc-400',              label: 'pending'    },
    playing:            { cls: 'bg-brand-600/60 text-brand-200',       label: 'playing'    },
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
  hasActivePlan,
  liveTakeoverActive,
  driftSeconds,
}: {
  hasActivePlan: boolean;
  liveTakeoverActive: boolean;
  driftSeconds: number;
}) {
  const queryClient = useQueryClient();

  const skipMutation = useMutation({
    mutationFn: postSupervisorSkip,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const reconcileMutation = useMutation({
    mutationFn: postSupervisorAlignToWallClock,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const alignToClockMutation = useMutation({
    mutationFn: postSupervisorAlignToClock,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
  });

  const skipDisabled = !hasActivePlan || liveTakeoverActive || skipMutation.isPending;
  const reconcileDisabled = !hasActivePlan || liveTakeoverActive || Math.abs(driftSeconds) < 5 || reconcileMutation.isPending;
  const alignToClockDisabled = !hasActivePlan || liveTakeoverActive || alignToClockMutation.isPending;

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

      <button
        onClick={() => reconcileMutation.mutate()}
        disabled={reconcileDisabled}
        title="Safely re-check the schedule and correct anything stale — never disturbs a plan that's already trustworthy"
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
          ${reconcileDisabled
            ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white'
          }`}
      >
        <Clock className="w-4 h-4" />
        Reconcile
      </button>

      <button
        onClick={() => {
          if (window.confirm('Align to Clock discards the active plan and rebuilds it from the wall clock. Content already queued but not yet aired will be dropped. Continue?')) {
            alignToClockMutation.mutate();
          }
        }}
        disabled={alignToClockDisabled}
        title="Forcefully discard the active plan and rebuild from wall clock. Forward-only — a no-op if the plan is already at or ahead of the clock."
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
          ${alignToClockDisabled
            ? 'bg-zinc-800/40 text-zinc-600 cursor-not-allowed'
            : 'bg-amber-900/20 text-amber-400 border border-amber-800 hover:bg-amber-900/40 hover:text-amber-300'
          }`}
      >
        <AlertTriangle className="w-4 h-4" />
        Align to Clock
      </button>
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

  const hb = heartbeatStatus(lastHeartbeatAt);

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
          <p className={`text-sm font-medium ${hb.cls}`}>
            {fmtRelativeTime(lastHeartbeatAt)}
          </p>
          <p className={`text-xs mt-1 ${hb.cls}`}>{hb.label}</p>
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

// ─── Now Playing ─────────────────────────────────────────────────────────────

function NowPlayingPanel({ planItems }: { planItems: SupervisorV2PlanItem[] }) {
  const playing = planItems.find((i) => i.status === 'playing');
  if (!playing) return null;
  const meta = CONTENT_TYPE_META[playing.content_type] ?? { label: playing.content_type, Icon: Circle, color: 'text-zinc-400' };
  const { Icon, color } = meta;
  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-zinc-800/50 border border-zinc-700 rounded-lg">
      <Icon className={`w-5 h-5 flex-shrink-0 ${color}`} />
      <div className="min-w-0">
        <p className="text-white font-semibold truncate">
          {playing.media_title ?? <span className="text-zinc-400 italic">untitled</span>}
        </p>
        <p className="text-xs text-zinc-400 truncate">{meta.label} · {fmtMmSs(playing.planned_duration_seconds)}</p>
      </div>
    </div>
  );
}

// ─── Current Segment Header ───────────────────────────────────────────────────

function CurrentSegmentLabel({ segment, nextPlan }: {
  segment: SupervisorV2CurrentSegment | null | undefined;
  nextPlan: SupervisorV2NextPlan | null | undefined;
}) {
  if (!segment) return null;
  const remainingMins = Math.floor(segment.remaining_seconds / 60);
  const remainingSecs = Math.floor(segment.remaining_seconds % 60);
  return (
    <div className="flex items-center gap-4 text-xs text-zinc-400">
      <span>
        <span className="text-zinc-300 font-medium uppercase tracking-wide text-[11px]">{segment.type}</span>
        {' · '}
        <span className="text-zinc-300">{segment.name}</span>
      </span>
      <span className="text-zinc-600">·</span>
      <span>
        {remainingMins}m {remainingSecs.toString().padStart(2, '0')}s remaining
      </span>
      {nextPlan && (
        <>
          <span className="text-zinc-600">·</span>
          <span>
            Next: <span className="text-zinc-300">{nextPlan.segment_type} · {nextPlan.segment_name}</span>
            {' '}
            <span className={`inline-block px-1 py-0.5 rounded text-[10px] font-mono uppercase ${nextPlan.status === 'finalized' ? 'text-green-400' : 'text-amber-400'}`}>
              {nextPlan.status}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

// ─── Recent Plays ─────────────────────────────────────────────────────────────

function RecentPlaysPanel({ plays }: { plays: SupervisorV2RecentPlay[] }) {
  const [open, setOpen] = useState(false);
  if (plays.length === 0) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-base font-semibold text-white mb-3 hover:text-zinc-300 transition-colors"
      >
        <span>Recent Plays</span>
        <span className="text-xs font-normal text-zinc-400">{plays.length} items</span>
        <span className="text-zinc-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-950/50 border-b border-zinc-800">
              <tr>
                <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-28">Type</th>
                <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Title</th>
                <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Artist</th>
                <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-20">Dur</th>
                <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2 w-24">When</th>
              </tr>
            </thead>
            <tbody>
              {plays.map((play, i) => (
                <tr key={i} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2">
                    {play.content_type ? <ContentTypeCell type={play.content_type} /> : <span className="text-zinc-500 text-xs italic">—</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-300 truncate max-w-xs">
                    {play.title ?? <span className="text-zinc-500 italic">untitled</span>}
                  </td>
                  <td className="px-3 py-2 text-zinc-400 truncate max-w-xs text-xs">
                    {play.artist ?? <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                    {play.duration_seconds != null ? fmtMmSs(play.duration_seconds) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-zinc-500">
                    {fmtRelativeTime(play.started_at_ms)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── Config Inspector ─────────────────────────────────────────────────────────

function ConfigInspectorPanel({
  segment,
  config,
}: {
  segment: SupervisorV2CurrentSegment | null | undefined;
  config: SupervisorV2SegmentConfig | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (!segment || !config) return null;
  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-base font-semibold text-white mb-3 hover:text-zinc-300 transition-colors"
      >
        <span>Segment Configuration</span>
        <span className="text-zinc-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Segment</p>
              <p className="text-zinc-300">{segment.name} <span className="text-zinc-500 text-xs">({segment.type})</span></p>
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Duration</p>
              <p className="text-zinc-300 font-mono">{fmtMmSs(segment.duration_seconds)}</p>
            </div>
            {segment.show_name && (
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">Show</p>
                <p className="text-zinc-300">{segment.show_name}</p>
              </div>
            )}
          </div>
          <div className="border-t border-zinc-800 pt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <p className="text-zinc-500 uppercase tracking-wide mb-1">Rotations</p>
              {config.rotation_ids.length > 0
                ? config.rotation_ids.map((id) => (
                    <span key={id} className="inline-block mr-1 mb-1 px-1.5 py-0.5 bg-zinc-800 rounded font-mono text-zinc-300">#{id}</span>
                  ))
                : <span className="text-zinc-600 italic">none</span>}
            </div>
            <div className="space-y-1">
              {config.jingle_playlist_id != null && (
                <p><span className="text-zinc-500">Jingles:</span> <span className="font-mono text-zinc-300">playlist #{config.jingle_playlist_id}</span></p>
              )}
              {config.show_jingle_playlist_id != null && (
                <p><span className="text-zinc-500">Show jingles:</span> <span className="font-mono text-zinc-300">playlist #{config.show_jingle_playlist_id}</span></p>
              )}
              {config.station_id_playlist_id != null && (
                <p><span className="text-zinc-500">Station IDs:</span> <span className="font-mono text-zinc-300">playlist #{config.station_id_playlist_id}</span></p>
              )}
              {config.start_clip_playlist_id != null && (
                <p><span className="text-zinc-500">Start clip:</span> <span className="font-mono text-zinc-300">playlist #{config.start_clip_playlist_id}</span></p>
              )}
              {config.end_clip_playlist_id != null && (
                <p><span className="text-zinc-500">End clip:</span> <span className="font-mono text-zinc-300">playlist #{config.end_clip_playlist_id}</span></p>
              )}
            </div>
          </div>
        </div>
      )}
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
  // All processes run in the same server process; if the supervisor heartbeat
  // is alive, all processes are alive.
  const status = heartbeatStatus(lastHeartbeatAt);

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Process Health</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {PROCESSES.map((name) => {
            const heartbeatLabel = fmtRelativeTime(lastHeartbeatAt);

            return (
              <div key={name} className="flex flex-col gap-1 p-2 bg-zinc-800/40 rounded">
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${status.dotCls}`} />
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

  // Compute live drift: how many seconds the wall clock is ahead of audio consumption.
  // This is the meaningful "on-time?" metric for an operator. current_drift_seconds is
  // an internal planner value (boundary offset) and should not drive operator-facing UI.
  const liveDriftSeconds = (() => {
    const startMs = data?.segment_started_at_ms;
    const consumed = data?.plan_consumed_seconds ?? 0;
    if (startMs == null) return 0;
    const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
    return elapsed - consumed;
  })();

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
            hasActivePlan={data?.active_plan_id != null}
            liveTakeoverActive={data?.live_takeover_active ?? false}
            driftSeconds={liveDriftSeconds}
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

      {!data?.live_takeover_active && data?.active_plan_id === null && !isLoading && (
        <div className="flex items-center gap-3 px-4 py-3 bg-zinc-800/40 border border-zinc-700 rounded-lg">
          <CheckCircle className="w-4 h-4 text-zinc-400 flex-shrink-0" />
          <span className="text-zinc-400 text-sm">No active plan — supervisor is idle.</span>
        </div>
      )}

      {/* D1: Now Playing + segment context */}
      <NowPlayingPanel planItems={data?.plan_items ?? []} />
      <CurrentSegmentLabel segment={data?.current_segment} nextPlan={data?.next_plan} />

      <SegmentTimeline
        segmentStartedAtMs={data?.segment_started_at_ms ?? null}
        segmentDurationSeconds={data?.segment_duration_seconds ?? null}
        planConsumedSeconds={data?.plan_consumed_seconds ?? 0}
        planItems={data?.plan_items ?? []}
        expectedCurrentItemEndMs={data?.expected_current_item_end_ms ?? null}
      />

      <DriftPanel
        driftSeconds={liveDriftSeconds}
        lastHeartbeatAt={data?.last_heartbeat_at ?? null}
      />

      <ProcessHealthPanel lastHeartbeatAt={data?.last_heartbeat_at ?? null} />

      <ActivePlanPanel items={data?.plan_items ?? []} />

      {/* D1: Recent plays */}
      <RecentPlaysPanel plays={data?.recent_plays ?? []} />

      <CampaignPacingPanel estimates={data?.stop_set_estimates ?? []} />

      {/* D2: Config inspector */}
      <ConfigInspectorPanel segment={data?.current_segment} config={data?.segment_config} />
    </div>
  );
}
