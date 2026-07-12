import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  ChevronsLeft,
  ChevronsRight,
  Circle,
  Clock,
  Mic2,
  Loader,
  SkipForward,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type {
  SupervisorV2PlanItem,
  SupervisorV2StopSetEstimate,
  SupervisorV2CurrentSegment,
  SupervisorV2NextPlan,
  SupervisorV2NextHardSegment,
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
  scheduleSourceMeta,
  computeTimelineLayout,
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

// Small hover card anchored at a given horizontal % within a relative
// container. Clamped away from the edges so it never clips off the card.
function TimelineTooltip({
  active,
  leftPct,
  children,
}: {
  active: boolean;
  leftPct: number;
  children: ReactNode;
}) {
  if (!active) return null;
  const clampedLeft = Math.min(92, Math.max(8, leftPct));
  return (
    <div
      className="absolute bottom-full mb-2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 shadow-lg pointer-events-none"
      style={{ left: `${clampedLeft}%` }}
    >
      {children}
    </div>
  );
}

function SegmentTimeline({
  segmentStartedAtMs,
  segmentDurationSeconds,
  planConsumedSeconds,
  planItems,
  expectedCurrentItemEndMs,
  intentionalOffsetSeconds,
  plannedOvershootSeconds,
  boundaryDriftSeconds,
  planInternalDriftSeconds,
  driftRecoveryCapSeconds,
}: {
  segmentStartedAtMs: number | null;
  segmentDurationSeconds: number | null;
  planConsumedSeconds: number;
  planItems: SupervisorV2PlanItem[];
  expectedCurrentItemEndMs: number | null;
  intentionalOffsetSeconds: number;
  plannedOvershootSeconds: number;
  boundaryDriftSeconds: number;
  planInternalDriftSeconds: number | null;
  driftRecoveryCapSeconds: number;
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

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

  const terminalStatuses = new Set(['played', 'supervisor_skipped', 'operator_skipped', 'dropped']);
  const layout = computeTimelineLayout(
    segmentDurationSeconds,
    intentionalOffsetSeconds,
    planItems.map((item) => {
      const meta = CONTENT_TYPE_META[item.content_type] ?? { barColor: 'bg-zinc-500', label: item.content_type };
      return {
        durationSeconds: item.planned_duration_seconds ?? 0,
        barColor: meta.barColor,
        isTerminal: terminalStatuses.has(item.status),
        isPlaying: item.status === 'playing',
        label: item.media_title ?? item.content_type,
        contentTypeLabel: meta.label,
        statusLabel: item.status.replace(/_/g, ' '),
      };
    }),
    plannedOvershootSeconds,
  );

  const calendarCursorLeft = layout.wallClockToPct(calendarElapsed);
  const planCursorLeft = layout.planPositionToPct(planConsumedSeconds);
  const expectedEndLeft =
    expectedCurrentItemEndMs != null
      ? layout.wallClockToPct((expectedCurrentItemEndMs - segmentStartedAtMs) / 1000)
      : null;
  const trailingLeftPct = layout.scheduledBoundaryPct + layout.contentPct;

  const offsetLabel =
    layout.offsetSide === 'lead'
      ? `Fired ${fmtMmSs(Math.abs(layout.offsetSeconds))} early`
      : layout.offsetSide === 'bite'
        ? `Fired ${fmtMmSs(Math.abs(layout.offsetSeconds))} late`
        : null;

  const hoverHandlers = (key: string) => ({
    onMouseEnter: () => setHoveredKey(key),
    onMouseLeave: () => setHoveredKey((k) => (k === key ? null : k)),
  });

  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">Segment Timeline</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        {/* Header stats */}
        <div className="flex items-center gap-6 mb-3 text-sm text-zinc-400 flex-wrap">
          <span>
            <span className="text-zinc-300 font-mono">{fmtMmSs(calendarElapsed)}</span>
            {' '}elapsed
          </span>
          <span>
            <span className="text-zinc-300 font-mono">{fmtMmSs(remaining)}</span>
            {' '}remaining
          </span>
          <span title="The segment's nominal, scheduled duration">
            scheduled{' '}
            <span className="text-zinc-300 font-mono">{fmtMmSs(segmentDurationSeconds)}</span>
          </span>
          <span title="Sum of the active plan's item durations — what's actually been assembled to fill this segment">
            planned{' '}
            <span className="text-zinc-300 font-mono">{fmtMmSs(layout.totalContentSeconds)}</span>
          </span>
          <span>
            drift{' '}
            <span className={`font-mono font-semibold ${
              absDrift < 5 ? 'text-green-400' : absDrift < 10 ? 'text-amber-400' : 'text-red-400'
            }`}>
              {fmtDriftSign(drift)}
            </span>
          </span>
          {planInternalDriftSeconds != null && Math.abs(planInternalDriftSeconds) >= 0.5 && (
            <span
              className={Math.abs(planInternalDriftSeconds) < 5 ? 'text-zinc-400' : 'text-amber-400'}
              title="Has the plan's own estimated total shifted since it activated (a mid-flight replan/trim/fill) — distinct from wall-clock-vs-consumed drift above"
            >
              plan Δ{' '}
              <span className="font-mono font-semibold">{fmtDriftSign(planInternalDriftSeconds)}</span>
            </span>
          )}
          {Math.abs(boundaryDriftSeconds) >= 0.5 && (
            <span title="Actual measured deviation from the scheduled wall-clock start — may differ from the intentional offset below">
              started{' '}
              <span className="font-mono font-semibold text-zinc-300">{fmtDriftSign(boundaryDriftSeconds)}</span>
            </span>
          )}
          {layout.offsetSeconds !== 0 && (
            <span
              className={layout.offsetSide === 'lead' ? 'text-sky-400' : 'text-amber-400'}
              title={`How much of the measured drift was intentionally corrected for when this segment was sized. Corrections are capped at ±${driftRecoveryCapSeconds}s per transition — the rest carries over to the next one.`}
            >
              offset{' '}
              <span className="font-mono font-semibold">{fmtDriftSign(layout.offsetSeconds)}</span>
            </span>
          )}
          {layout.trailingKind && (
            <span className={layout.trailingKind === 'overshoot' ? 'text-red-400' : 'text-zinc-400'}>
              {layout.trailingKind}{' '}
              <span className="font-mono font-semibold">{fmtMmSs(Math.abs(layout.trailingSeconds))}</span>
            </span>
          )}
        </div>

        {/* Timeline bar — outer wrapper stays unclipped so tooltips can float above it */}
        <div className="relative h-12">
          <div className="absolute inset-0 bg-zinc-800 rounded overflow-hidden">
            {/* Offset region (fired early/late) */}
            {layout.offsetPct > 0 && (
              <div
                className={`absolute top-0 bottom-0 flex items-center justify-center cursor-default ${
                  layout.offsetSide === 'lead' ? 'bg-sky-900/40' : 'bg-amber-900/40'
                }`}
                style={{ left: 0, width: `${layout.offsetPct}%` }}
                {...hoverHandlers('offset')}
              >
                {layout.offsetSide === 'lead' ? (
                  <ChevronsLeft className="w-4 h-4 text-sky-400" />
                ) : (
                  <ChevronsRight className="w-4 h-4 text-amber-400" />
                )}
              </div>
            )}

            {/* Scheduled-boundary reference line — always at the offset/content border */}
            <div
              className="absolute top-0 bottom-0 w-2 -ml-1 cursor-default border-l border-dashed border-zinc-400 opacity-50 z-10"
              style={{ left: `${layout.scheduledBoundaryPct}%` }}
              {...hoverHandlers('boundary')}
            />

            {/* Plan item blocks, chiseled dividers between them */}
            {layout.contentBlocks.map((block, i) => (
              <div
                key={i}
                className="absolute top-1 bottom-1 cursor-default"
                style={{ left: `${block.leftPct}%`, width: `${Math.max(0.3, block.widthPct)}%` }}
                {...hoverHandlers(`content-${i}`)}
              >
                <div
                  className={`absolute inset-0 rounded-sm ${block.barColor} ${block.isTerminal ? 'opacity-30' : 'opacity-70'}`}
                  style={
                    i < layout.contentBlocks.length - 1
                      ? { boxShadow: 'inset -1px 0 0 0 rgba(0,0,0,0.5), inset -2px 0 0 0 rgba(255,255,255,0.08)' }
                      : undefined
                  }
                />
                {block.isPlaying && (
                  <div className="absolute -inset-0.5 border-2 border-white rounded-sm pointer-events-none" />
                )}
              </div>
            ))}

            {/* Trailing region: gap or overshoot */}
            {layout.trailingPct > 0 && (
              <div
                className={`absolute top-0 bottom-0 flex items-center justify-center cursor-default text-xs font-mono uppercase tracking-wide ${
                  layout.trailingKind === 'overshoot' ? 'text-red-300' : 'text-zinc-500'
                }`}
                style={{
                  left: `${trailingLeftPct}%`,
                  width: `${layout.trailingPct}%`,
                  backgroundImage:
                    layout.trailingKind === 'overshoot'
                      ? 'repeating-linear-gradient(45deg, rgba(248,113,113,0.25) 0, rgba(248,113,113,0.25) 4px, transparent 4px, transparent 8px)'
                      : 'repeating-linear-gradient(45deg, rgba(113,113,122,0.2) 0, rgba(113,113,122,0.2) 3px, transparent 3px, transparent 9px)',
                }}
                {...hoverHandlers('trailing')}
              >
                {layout.trailingKind === 'gap' ? 'Gap' : ''}
              </div>
            )}

            {/* Plan cursor (colored by drift) */}
            <div
              className={`absolute top-0 bottom-0 w-1 -ml-0.5 cursor-default z-20 ${driftCursorColor}`}
              style={{ left: `${planCursorLeft}%` }}
              {...hoverHandlers('plan-cursor')}
            />

            {/* Expected end of current item */}
            {expectedEndLeft != null && (
              <div
                className="absolute top-0 bottom-0 w-2 -ml-1 cursor-default bg-zinc-500/0 z-10"
                style={{ left: `${expectedEndLeft}%` }}
                {...hoverHandlers('expected-end')}
              >
                <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-500 opacity-60" />
              </div>
            )}

            {/* Calendar cursor (white, always on top) */}
            <div
              className="absolute top-0 bottom-0 w-1 -ml-0.5 cursor-default z-20"
              style={{ left: `${calendarCursorLeft}%` }}
              {...hoverHandlers('wall-clock')}
            >
              <div className="absolute inset-y-0 left-1/2 w-0.5 bg-white" />
            </div>
          </div>

          {/* Tooltips — rendered outside the clipped inner div so they never get cut off */}
          {layout.offsetPct > 0 && (
            <TimelineTooltip active={hoveredKey === 'offset'} leftPct={layout.offsetPct / 2}>
              <div className="font-semibold">{offsetLabel}</div>
            </TimelineTooltip>
          )}
          <TimelineTooltip active={hoveredKey === 'boundary'} leftPct={layout.scheduledBoundaryPct}>
            Scheduled boundary
          </TimelineTooltip>
          {layout.contentBlocks.map((block, i) => (
            <TimelineTooltip key={i} active={hoveredKey === `content-${i}`} leftPct={block.leftPct + block.widthPct / 2}>
              <div className="font-semibold">{block.label}</div>
              <div className="text-zinc-400 text-xs mt-0.5">
                {block.contentTypeLabel} · {fmtMmSs(block.durationSeconds)} · {block.statusLabel}
              </div>
            </TimelineTooltip>
          ))}
          {layout.trailingPct > 0 && (
            <TimelineTooltip active={hoveredKey === 'trailing'} leftPct={trailingLeftPct + layout.trailingPct / 2}>
              {layout.trailingKind === 'overshoot'
                ? `Overshoot: +${fmtMmSs(Math.abs(layout.trailingSeconds))}`
                : `Gap: ${fmtMmSs(Math.abs(layout.trailingSeconds))}`}
            </TimelineTooltip>
          )}
          <TimelineTooltip active={hoveredKey === 'plan-cursor'} leftPct={planCursorLeft}>
            Plan position: {fmtMmSs(planConsumedSeconds)}
          </TimelineTooltip>
          {expectedEndLeft != null && (
            <TimelineTooltip active={hoveredKey === 'expected-end'} leftPct={expectedEndLeft}>
              Expected end of current item
            </TimelineTooltip>
          )}
          <TimelineTooltip active={hoveredKey === 'wall-clock'} leftPct={calendarCursorLeft}>
            Wall clock: {fmtMmSs(calendarElapsed)} elapsed
          </TimelineTooltip>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500 flex-wrap">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-white inline-block" />wall clock</span>
          <span className="flex items-center gap-1"><span className={`w-2 h-2 rounded-full ${driftCursorColor} inline-block`} />plan position</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 border-l border-dashed border-zinc-400 inline-block" />scheduled boundary</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 border-2 border-white rounded-sm inline-block" />now playing</span>
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

function CurrentSegmentLabel({ segment, nextPlan, nextHardSegment }: {
  segment: SupervisorV2CurrentSegment | null | undefined;
  nextPlan: SupervisorV2NextPlan | null | undefined;
  nextHardSegment: SupervisorV2NextHardSegment | null | undefined;
}) {
  if (!segment) return null;
  const remainingMins = Math.floor(segment.remaining_seconds / 60);
  const remainingSecs = Math.floor(segment.remaining_seconds % 60);
  const source = scheduleSourceMeta(segment.source_type);
  return (
    <div className="flex items-center gap-4 text-sm text-zinc-400 flex-wrap">
      <span>
        <span className="text-zinc-300 font-medium uppercase tracking-wide text-[11px]">{segment.type}</span>
        {' · '}
        <span className="text-zinc-300">{segment.name}</span>
      </span>
      <span className="text-zinc-600">·</span>
      <span>
        {remainingMins}m {remainingSecs.toString().padStart(2, '0')}s remaining
      </span>
      <span className="text-zinc-600">·</span>
      <span className={`font-medium ${source.cls}`} title="Schedule resolution tier — Calendar is normal; Template/Default Clock mean a fallback tier is in effect">
        {source.label}
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
      {nextHardSegment && (
        <>
          <span className="text-zinc-600">·</span>
          <span>
            Next hard: <span className="text-zinc-300">{nextHardSegment.name}</span>
            {' in '}
            <span className="font-mono text-zinc-300">{fmtMmSs(nextHardSegment.seconds_until)}</span>
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
      <CurrentSegmentLabel
        segment={data?.current_segment}
        nextPlan={data?.next_plan}
        nextHardSegment={data?.next_hard_segment}
      />

      <SegmentTimeline
        segmentStartedAtMs={data?.segment_started_at_ms ?? null}
        segmentDurationSeconds={data?.segment_duration_seconds ?? null}
        planConsumedSeconds={data?.plan_consumed_seconds ?? 0}
        planItems={data?.plan_items ?? []}
        expectedCurrentItemEndMs={data?.expected_current_item_end_ms ?? null}
        intentionalOffsetSeconds={data?.current_segment?.intentional_offset_seconds ?? 0}
        plannedOvershootSeconds={data?.current_segment?.planned_overshoot_seconds ?? 0}
        boundaryDriftSeconds={data?.current_segment?.boundary_drift_seconds ?? 0}
        planInternalDriftSeconds={data?.plan_internal_drift_seconds ?? null}
        driftRecoveryCapSeconds={data?.drift_recovery_cap_seconds ?? 300}
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
