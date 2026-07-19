import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Users, Gauge, Radio, Power, Loader, Zap, Mic, Music2, Clock, Headphones, Square, Volume2, TrendingUp, Wifi, RotateCcw } from 'lucide-react';
import {
  fetchIcecastStats,
  fetchIcecastConfig,
  restartIcecast,
  restartLiquidsoap,
  resetPeakListeners,
  kickIcecastSource,
  fetchSupervisorV2Status,
  fetchLiquidsoapStatus,
  fetchLiquidsoapConfig,
  fetchSimulate,
  postSupervisorAlignToWallClock,
  postSupervisorAlignToClock,
} from '../api';
import type { SupervisorV2Status, LiquidsoapConfig } from '@soono/shared';
import { LUFS_PRESETS, FADE_SHAPES, matchMasterBusPreset } from '@soono/shared';
import { useEffect, useRef, useState } from 'react';
import { getIcecastBaseUrl } from '../lib/icecastUrl';
import { fmtMmSs, fmtDriftSign, fmtRelativeTime, CONTENT_TYPE_META, ContentTypeCell, heartbeatStatus, scheduleSourceMeta } from '../lib/supervisorV2Ui';

export function Dashboard() {
  const [restartToast, setRestartToast] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['icecast-stats'],
    queryFn: fetchIcecastStats,
    refetchInterval: 3000,
  });

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
  });

  const { data: lsConfig } = useQuery({
    queryKey: ['liquidsoap-config'],
    queryFn: fetchLiquidsoapConfig,
    staleTime: 60_000,
  });

  const { data: v2Status } = useQuery({
    queryKey: ['supervisor-v2-status'],
    queryFn: fetchSupervisorV2Status,
    refetchInterval: 3000,
  });

  const { data: lsStatus } = useQuery({
    queryKey: ['liquidsoap-status'],
    queryFn: fetchLiquidsoapStatus,
    refetchInterval: 3000,
  });

  const restartIcecastM = useMutation({
    mutationFn: restartIcecast,
    onSuccess: (data) => {
      setRestartToast(`✓ Streaming Engine restarted successfully! Uptime: ${data.uptime}s`);
      setTimeout(() => setRestartToast(null), 5000);
    },
    onError: (err) => {
      setRestartToast(`✗ Error: ${(err as Error).message}`);
      setTimeout(() => setRestartToast(null), 5000);
    },
  });

  const restartLiquidsoapM = useMutation({
    mutationFn: restartLiquidsoap,
    onSuccess: () => {
      setRestartToast('✓ Mix Engine restarted successfully!');
      setTimeout(() => setRestartToast(null), 5000);
    },
    onError: (err) => {
      setRestartToast(`✗ Error: ${(err as Error).message}`);
      setTimeout(() => setRestartToast(null), 5000);
    },
  });

  const restartSupervisorM = useMutation({
    mutationFn: postSupervisorAlignToClock,
    onSuccess: () => {
      setRestartToast('✓ Supervisor realigned to wall clock.');
      setTimeout(() => setRestartToast(null), 5000);
      qc.invalidateQueries({ queryKey: ['supervisor-v2-status'] });
    },
    onError: (err) => {
      setRestartToast(`✗ Error: ${(err as Error).message}`);
      setTimeout(() => setRestartToast(null), 5000);
    },
  });

  const resetPeakM = useMutation({
    mutationFn: resetPeakListeners,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['icecast-stats'] });
    },
  });

  const [kickingMount, setKickingMount] = useState<string | null>(null);
  const [armedMount, setArmedMount] = useState<string | null>(null);
  const armTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const kickMutation = useMutation({
    mutationFn: kickIcecastSource,
    onMutate: (mount) => setKickingMount(mount),
    onSettled: () => setKickingMount(null),
    onSuccess: (_, mount) => {
      setRestartToast(`✓ Source kicked on ${mount}. The broadcaster can reconnect now.`);
      setTimeout(() => setRestartToast(null), 5000);
    },
    onError: (err) => {
      setRestartToast(`✗ Kick failed: ${(err as Error).message}`);
      setTimeout(() => setRestartToast(null), 5000);
    },
  });

  const handleKick = (mount: string) => {
    if (armedMount === mount) {
      if (armTimeout.current) clearTimeout(armTimeout.current);
      setArmedMount(null);
      kickMutation.mutate(mount);
      return;
    }
    setArmedMount(mount);
    if (armTimeout.current) clearTimeout(armTimeout.current);
    armTimeout.current = setTimeout(() => setArmedMount(null), 3000);
  };

  const formatUptime = (seconds: number): string => {
    if (!seconds) return '—';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m`;
    return `${seconds}s`;
  };

  const formatBandwidth = (totalKbps: number): string => {
    if (totalKbps >= 1000) return `${(totalKbps / 1000).toFixed(1)} Mbps`;
    return `${totalKbps} kbps`;
  };

  const isOnline = !statsError && stats && stats.listener >= 0;
  const icecastBaseUrl = config ? getIcecastBaseUrl(config) : 'https://localhost:8000';
  const supervisorHb = heartbeatStatus(v2Status?.last_heartbeat_at ?? null);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        </div>
      </div>

      {restartToast && (
        <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-3 text-amber-300 text-sm">
          {restartToast}
        </div>
      )}

      {!isOnline && (
        <p className="text-red-400 text-sm">✗ Streaming Engine is not responding</p>
      )}

      <section>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <HealthPill
            label="Streaming Engine"
            detail="Icecast"
            ok={isOnline ?? null}
            state={isOnline ? 'ONLINE' : 'OFFLINE'}
            onRestart={() => restartIcecastM.mutate()}
            restarting={restartIcecastM.isPending}
          />
          <HealthPill
            label="Mix Engine"
            detail="LiquidSoap"
            ok={lsStatus?.reachable ?? null}
            state={lsStatus?.reachable ? (lsStatus.on_air === 'live' ? 'LIVE' : 'AUTOMATION') : 'OFFLINE'}
            onRestart={() => restartLiquidsoapM.mutate()}
            restarting={restartLiquidsoapM.isPending}
          />
          <HealthPill
            label="Supervisor"
            detail={fmtRelativeTime(v2Status?.last_heartbeat_at ?? null)}
            ok={supervisorHb.label === 'ok' ? true : supervisorHb.label === 'offline' ? false : null}
            state={supervisorHb.label.toUpperCase()}
            onRestart={() => {
              if (confirm('Align to Clock discards the active plan and rebuilds it from the wall clock. Content already queued but not yet aired will be dropped. Continue?')) {
                restartSupervisorM.mutate();
              }
            }}
            restarting={restartSupervisorM.isPending}
          />
        </div>
      </section>

      {/* Now Playing — includes the live monitor player */}
      <NowPlayingCard status={v2Status} icecastConfig={config} />

      {/* Now Running — schedule resolver + supervisor controls */}
      {v2Status && <NowRunningCard status={v2Status} />}

      {/* Audio Processing — mix engine loudness/crossfade/limiter status */}
      {lsConfig && <AudioProcessingCard config={lsConfig} />}

      {/* Ducking — live input mode + duck settings */}
      {lsConfig && <DuckingCard config={lsConfig} />}

      {/* Live Stream Stats */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">Live Stream</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Status</p>
                <p className={`text-2xl font-bold mt-2 flex items-center gap-1 ${isOnline ? 'text-green-400' : 'text-red-400'}`}>
                  {isOnline ? '● LIVE' : '● OFFLINE'}
                </p>
                <p className="text-xs text-zinc-500 mt-1">Streaming Engine</p>
              </div>
              <Activity className={`w-8 h-8 ${isOnline ? 'text-green-500' : 'text-red-500'}`} />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Current Listeners</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : stats?.listener ?? 0}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  max {configLoading ? '—' : config?.limits.max_clients ?? 500}
                </p>
              </div>
              <Users className="w-8 h-8 text-brand-500" />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Peak Listeners</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : stats?.peak_listener ?? 0}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  since {fmtRelativeTime(stats?.peak_since ? new Date(stats.peak_since).getTime() : null)}
                </p>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <TrendingUp className="w-8 h-8 text-violet-500" />
                <button
                  type="button"
                  onClick={() => resetPeakM.mutate()}
                  disabled={resetPeakM.isPending}
                  title="Reset peak listener count"
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                >
                  <RotateCcw className="w-3 h-3" />
                  reset
                </button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Bitrate</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : stats?.bitrate ?? 0}
                </p>
                <p className="text-xs text-zinc-500 mt-1">kbps per listener</p>
              </div>
              <Gauge className="w-8 h-8 text-amber-500" />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Bandwidth</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : formatBandwidth((stats?.bitrate ?? 0) * (stats?.listener ?? 0))}
                </p>
                <p className="text-xs text-zinc-500 mt-1">outbound, all listeners</p>
              </div>
              <Wifi className="w-8 h-8 text-sky-500" />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Uptime (Icecast)</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : formatUptime(stats?.uptime ?? 0)}
                </p>
                <p className="text-xs text-zinc-500 mt-1">running</p>
              </div>
              <Radio className="w-8 h-8 text-cyan-500" />
            </div>
          </div>
        </div>
      </section>

      {/* Server Capacity */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">Server Capacity</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <p className="text-zinc-400 text-sm font-medium">Max Sources</p>
            <p className="text-3xl font-bold text-white mt-2">
              {configLoading ? '—' : config?.limits.max_sources ?? 10}
            </p>
            <p className="text-xs text-zinc-500 mt-2">broadcasters</p>
          </div>

          <a
            href={`${icecastBaseUrl}/admin/`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-brand-600 transition-colors cursor-pointer"
          >
            <p className="text-zinc-400 text-sm font-medium">Server (Admin)</p>
            <p className="text-sm text-brand-400 mt-2 font-mono underline">
              {config?.server.hostname || 'localhost'}:{config?.network.listen_sockets?.[0]?.port || 8000}/admin
            </p>
            <p className="text-xs text-zinc-500 mt-2">{config?.server.location || 'no location'}</p>
          </a>

          <a
            href={`${icecastBaseUrl}/status.xsl`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-brand-600 transition-colors cursor-pointer"
          >
            <p className="text-zinc-400 text-sm font-medium">Server (Status)</p>
            <p className="text-sm text-brand-400 mt-2 font-mono underline">
              {config?.server.hostname || 'localhost'}:{config?.network.listen_sockets?.[0]?.port || 8000}/status.xsl
            </p>
            <p className="text-xs text-zinc-500 mt-2">Public stream status page</p>
          </a>
        </div>
      </section>

      {/* Mount Point Info */}
      {config && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-4">Mount Point</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium text-white">{config.mount.name}</p>
                <p className="text-xs text-zinc-500 mt-1">
                  Max {config.mount.max_listeners === -1 ? 'unlimited' : config.mount.max_listeners} listeners
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleKick(config.mount.name)}
                disabled={kickingMount === config.mount.name}
                title="Force-disconnect any source on this mount (workaround for the Icecast 2.4 SSL stale-source bug). Click twice to confirm."
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 ${
                  armedMount === config.mount.name
                    ? 'bg-red-600/20 border-red-600 text-red-300 hover:bg-red-600/30'
                    : 'bg-zinc-800 hover:bg-red-900/30 border-zinc-700 hover:border-red-800 text-zinc-300 hover:text-red-300'
                }`}
              >
                {kickingMount === config.mount.name ? (
                  <Loader className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                {armedMount === config.mount.name ? 'Click again to kick' : 'Kick source'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Error State */}
      {statsError && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-6 text-red-300">
          <p className="font-medium">Streaming Engine Not Responding</p>
          <p className="text-sm mt-1">
            Start Icecast in another terminal: <code className="bg-red-950 px-2 py-1 rounded text-xs">./start-icecast.sh</code>
          </p>
        </div>
      )}

      <NextUpSection />

      <RecentPlaysSection plays={v2Status?.recent_plays ?? []} />
    </div>
  );
}

import type { IcecastConfig, SupervisorV2RecentPlay } from '@soono/shared';

function HealthPill({
  label,
  detail,
  ok,
  state,
  onRestart,
  restarting,
}: {
  label: string;
  detail: string;
  ok: boolean | null;
  state: string;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const dotCls = ok === null ? 'bg-zinc-600' : ok ? 'bg-green-500' : 'bg-red-500';
  const textCls = ok === null ? 'text-zinc-400' : ok ? 'text-green-400' : 'text-red-400';
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 flex items-center gap-3">
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotCls}`} />
      <div className="min-w-0 flex-1">
        <p className="text-zinc-400 text-xs font-medium">{label}</p>
        <p className={`text-sm font-bold ${textCls}`}>{state}</p>
        <p className="text-[10px] text-zinc-500">{detail}</p>
      </div>
      {onRestart && (
        <button
          type="button"
          onClick={onRestart}
          disabled={restarting}
          title={`Restart ${label}`}
          className="p-1.5 text-zinc-500 hover:text-white hover:bg-zinc-800 rounded transition-colors disabled:opacity-40 flex-shrink-0"
        >
          {restarting ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
        </button>
      )}
    </div>
  );
}

function NowPlayingCard({ status, icecastConfig }: { status: SupervisorV2Status | undefined; icecastConfig: IcecastConfig | undefined }) {
  const monitor = icecastConfig && <MonitorPlayer config={icecastConfig} />;

  if (!status || status.active_plan_id == null) {
    return (
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-4">
          <Mic className="w-10 h-10 text-zinc-700" />
          <div className="flex-1">
            <p className="text-zinc-400 text-sm font-medium">Now Playing</p>
            <p className="text-xl font-bold text-zinc-500 mt-1">● SILENCE</p>
            <p className="text-xs text-zinc-600 mt-1">
              No active plan — the Supervisor is idle or between segments.
            </p>
          </div>
        </div>
        {monitor}
      </section>
    );
  }

  const playing = status.plan_items.find((i) => i.status === 'playing');

  if (!playing) {
    return (
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
        <div className="flex items-center gap-4">
          <Mic className="w-10 h-10 text-zinc-700" />
          <div className="flex-1">
            <p className="text-zinc-400 text-sm font-medium">Now Playing</p>
            <p className="text-xl font-bold text-zinc-500 mt-1">● TRANSITIONING</p>
          </div>
        </div>
        {monitor}
      </section>
    );
  }

  const sourceLive = status.live_takeover_active;
  const meta = CONTENT_TYPE_META[playing.content_type];
  const Icon = meta?.Icon ?? Music2;
  const display = playing.media_title ?? '(untitled)';

  // Clip-level progress: how far into THIS item we are, distinct from Now
  // Running's segment-level progress. expected_current_item_end_ms is
  // anchored to this item's real on-air timestamp (play_history.started_at,
  // set by the actual LS_TRACK_STARTED webhook) — immune to drift
  // accumulated by earlier items, unlike reconstructing it from a sum of
  // planned durations (which broke whenever a prior track's real play time
  // didn't match its planned_duration_seconds).
  const clipTotal = playing.planned_duration_seconds ?? 0;
  const clipRemaining =
    status.expected_current_item_end_ms != null
      ? Math.max(0, (status.expected_current_item_end_ms - Date.now()) / 1000)
      : null;
  const clipElapsed = clipRemaining != null ? Math.max(0, clipTotal - clipRemaining) : null;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
      <div className="flex items-start gap-4">
        <Icon className={`w-10 h-10 flex-shrink-0 ${sourceLive ? 'text-red-500' : (meta?.color ?? 'text-green-500')}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-zinc-400 text-sm font-medium">Now Playing</p>
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                sourceLive ? 'bg-red-900/40 text-red-300' : 'bg-green-900/40 text-green-300'
              }`}
            >
              ● {sourceLive ? 'LIVE' : 'AUTO'}
            </span>
          </div>
          <p className="text-2xl font-bold text-white mt-1 truncate">{display}</p>
          {clipTotal > 0 && clipElapsed != null && (
            <div className="mt-3">
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${sourceLive ? 'bg-red-500' : 'bg-brand-500'} transition-all`}
                  style={{ width: `${(clipElapsed / clipTotal) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-zinc-500 mt-1 font-mono">
                <span>{fmtMmSs(clipElapsed)}</span>
                <span>{fmtMmSs(clipTotal)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      {monitor}
    </section>
  );
}

function NowRunningCard({ status }: { status: SupervisorV2Status }) {
  const qc = useQueryClient();
  const [pendingError, setPendingError] = useState<string | null>(null);

  const onMutate = (label: string) => ({
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supervisor-v2-status'] }),
    onError: (e: Error) => setPendingError(`${label}: ${e.message}`),
  });

  const reconcileM = useMutation({ mutationFn: postSupervisorAlignToWallClock, ...onMutate('Reconcile') });
  const alignM = useMutation({ mutationFn: postSupervisorAlignToClock, ...onMutate('Align to Clock') });
  const pending = reconcileM.isPending || alignM.isPending;

  const segment = status.current_segment;
  const nextPlan = status.next_plan;
  const liveTakeover = status.live_takeover_active;
  const hasActivePlan = status.active_plan_id != null;

  const liveDriftSeconds = (() => {
    const startMs = status.segment_started_at_ms;
    const consumed = status.plan_consumed_seconds ?? 0;
    if (startMs == null) return 0;
    const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
    return elapsed - consumed;
  })();

  const progressPct = segment
    ? (segment.elapsed_seconds / Math.max(1, segment.elapsed_seconds + segment.remaining_seconds)) * 100
    : 0;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 flex-wrap">
            Now running
            {segment && (() => {
              const source = scheduleSourceMeta(segment.source_type);
              return (
                <span
                  className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${source.badgeCls}`}
                  title="Schedule resolution tier — Calendar is normal; the fallback tiers mean the calendar/template didn't cover this moment"
                >
                  {source.label}
                </span>
              );
            })()}
            {liveTakeover && (
              <span className="text-red-300 bg-red-900/30 border border-red-800/50 px-1.5 py-0.5 rounded font-mono text-[10px]">
                LIVE TAKEOVER
              </span>
            )}
            {Math.abs(liveDriftSeconds) > 5 && (
              <span
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                  liveDriftSeconds > 10 || liveDriftSeconds < -10
                    ? 'text-red-300 bg-red-900/30 border-red-800/50'
                    : 'text-amber-300 bg-amber-900/30 border-amber-800/50'
                }`}
                title={
                  liveDriftSeconds > 0
                    ? 'Wall clock is ahead of plan consumption — running behind.'
                    : 'Plan consumption is ahead of the wall clock — running ahead.'
                }
              >
                {fmtDriftSign(liveDriftSeconds)} {liveDriftSeconds > 0 ? 'BEHIND' : 'AHEAD'}
              </span>
            )}
          </div>
          {segment ? (
            <>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2 flex-wrap">
                <span className="text-xs text-zinc-500 font-mono uppercase">{segment.type}</span>
                <span className="text-brand-300">{segment.name}</span>
              </h2>
              {segment.show_name && (
                <p className="text-xs text-zinc-500 mt-1">
                  Show: <span className="text-zinc-400">{segment.show_name}</span>
                </p>
              )}
              {nextPlan && (
                <p className="text-xs text-zinc-500 mt-1">
                  Next: <span className="text-zinc-300">{nextPlan.segment_type} · {nextPlan.segment_name}</span>
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <span className="text-xs font-mono text-zinc-400 w-12 text-right">
                  {fmtMmSs(segment.elapsed_seconds)}
                </span>
                <div className="flex-1 h-2 bg-zinc-800 rounded overflow-hidden">
                  <div
                    className="h-full bg-brand-500 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-zinc-500 w-12">
                  {fmtMmSs(segment.remaining_seconds)}
                </span>
              </div>
            </>
          ) : (
            <p className="text-zinc-500 italic text-sm">No segment resolves to this moment.</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            disabled={pending || !hasActivePlan || liveTakeover || Math.abs(liveDriftSeconds) < 5}
            onClick={() => reconcileM.mutate()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm transition disabled:opacity-40"
            title="Safely re-check the schedule and correct anything stale — never disturbs a plan that's already trustworthy"
          >
            <Clock className="w-4 h-4" />
            Reconcile
          </button>
          <button
            type="button"
            disabled={pending || !hasActivePlan || liveTakeover}
            onClick={() => {
              if (confirm('Align to Clock discards the active plan and rebuilds it from the wall clock. Content already queued but not yet aired will be dropped. Continue?')) {
                alignM.mutate();
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-900/20 text-amber-400 border border-amber-800 rounded text-sm transition hover:bg-amber-900/40 hover:text-amber-300 disabled:opacity-40"
            title="Forcefully discard the active plan and rebuild from wall clock. Forward-only — a no-op if the plan is already at or ahead of the clock."
          >
            <AlertTriangle className="w-4 h-4" />
            Align to Clock
          </button>
        </div>
      </div>
      {pendingError && (
        <p className="text-xs text-rose-400 mt-3">{pendingError}</p>
      )}
    </section>
  );
}

function AudioProcessingCard({ config }: { config: LiquidsoapConfig }) {
  const { loudness_normalization, crossfade, master_bus } = config;
  const lufsPreset = LUFS_PRESETS.find((p) => p.value === loudness_normalization.target_lufs);
  const fadeShape = FADE_SHAPES.find((s) => s.key === crossfade.fade_shape);
  const limiterPreset = matchMasterBusPreset(master_bus);

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Audio Processing</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <p className="text-sm text-zinc-300">Loudness Normalization</p>
          {loudness_normalization.enabled ? (
            <p className="text-sm mt-1">
              <span className="text-green-400 font-mono">{loudness_normalization.target_lufs} LUFS</span>
              {lufsPreset && <span className="text-zinc-500 text-xs ml-2">{lufsPreset.label.replace(/ — .*/, '')}</span>}
            </p>
          ) : (
            <p className="text-sm text-zinc-500 mt-1">Off</p>
          )}
        </div>
        <div>
          <p className="text-sm text-zinc-300">Crossfade</p>
          {crossfade.duration_seconds > 0 ? (
            <p className="text-sm mt-1">
              <span className="text-sky-400 font-mono">{crossfade.duration_seconds}s</span>
              <span className="text-zinc-500 text-xs ml-2">{crossfade.smart ? 'Smart' : fadeShape?.label ?? crossfade.fade_shape}</span>
            </p>
          ) : (
            <p className="text-sm text-zinc-500 mt-1">Off</p>
          )}
        </div>
        <div>
          <p className="text-sm text-zinc-300">Master Bus Limiter</p>
          {master_bus.soft_limiter ? (
            <p className="text-sm mt-1">
              <span className="text-amber-400 font-mono">{limiterPreset?.label ?? 'Custom'}</span>
              <span className="text-zinc-500 text-xs ml-2 font-mono">
                {master_bus.threshold_db.toFixed(1)} dBFS · {master_bus.ratio.toFixed(0)}:1 · {master_bus.attack_ms.toFixed(0)}/{master_bus.release_ms.toFixed(0)} ms
              </span>
            </p>
          ) : (
            <p className="text-sm text-zinc-500 mt-1">Off</p>
          )}
        </div>
      </div>
    </section>
  );
}

function DuckingCard({ config }: { config: LiquidsoapConfig }) {
  const { harbor, ducking } = config;
  const mixMode = harbor.enabled && harbor.live_mode === 'mix';

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <h2 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Ducking</h2>
      {mixMode ? (
        <p className="text-sm">
          <span className="text-violet-400 font-mono">{ducking.depth_db.toFixed(1)} dB</span>
          <span className="text-zinc-500 text-xs ml-2 font-mono">{ducking.duration_seconds.toFixed(2)}s speed</span>
          <span className="text-zinc-500 text-xs ml-2">Mix with Segment Audio</span>
        </p>
      ) : (
        <p className="text-sm text-zinc-500">
          Off <span className="text-xs">— Live Input Mode: Take Over</span>
        </p>
      )}
    </section>
  );
}

function NextUpSection() {
  const { data: plays = [], isLoading } = useQuery({
    queryKey: ['supervisor-next-up'],
    queryFn: () => {
      const now = new Date();
      // 30-minute window is plenty for "next ~5 tracks". We slice to 5 client-side.
      const end = new Date(now.getTime() + 30 * 60 * 1000);
      return fetchSimulate(now, end);
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const visible = plays.slice(0, 5);
  if (isLoading && visible.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">Next Up</h2>
        <p className="text-sm text-zinc-500 italic">Simulating…</p>
      </section>
    );
  }
  if (visible.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">
        Next Up <span className="text-xs font-normal text-zinc-500">simulated · won't perfectly match live picks</span>
      </h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950/50 border-b border-zinc-800">
            <tr>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Time</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Track</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Segment</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => {
              const display = p.media
                ? p.media.title ?? p.media.original_filename
                : p.segment_type === 'stop_set'
                  ? '(commercial break)'
                  : `(${p.segment_type})`;
              return (
                <tr key={i} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-400 font-mono text-xs whitespace-nowrap">
                    {formatHourMin(p.at)}
                  </td>
                  <td className="px-3 py-2 text-zinc-200 truncate max-w-md">
                    {display}
                    {p.media?.artist && <span className="text-zinc-500"> — {p.media.artist}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500 truncate max-w-xs">
                    {p.clock_name} · {p.segment_name}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                    {p.media ? fmtMmSs(p.media.duration_seconds) : '—'}
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

function formatHourMin(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function RecentPlaysSection({ plays }: { plays: SupervisorV2RecentPlay[] }) {
  const [open, setOpen] = useState(false);
  if (plays.length === 0) return null;
  const visible = plays.slice(0, 8);
  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-lg font-semibold text-white mb-3 hover:text-zinc-300 transition-colors"
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
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Type</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Track</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Artist</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Duration</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => (
              <tr key={i} className="border-t border-zinc-800/60">
                <td className="px-3 py-2">
                  {p.content_type ? <ContentTypeCell type={p.content_type} /> : <span className="text-zinc-500 text-xs italic">—</span>}
                </td>
                <td className="px-3 py-2 text-zinc-200 truncate max-w-md">
                  {p.title ?? <span className="text-zinc-500 italic">untitled</span>}
                </td>
                <td className="px-3 py-2 text-zinc-400 truncate max-w-xs text-xs">
                  {p.artist ?? <span className="text-zinc-600">—</span>}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                  {p.duration_seconds != null ? fmtMmSs(p.duration_seconds) : '—'}
                </td>
                <td className="px-3 py-2 text-right text-xs text-zinc-500">
                  {fmtRelativeTime(p.started_at_ms)}
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

function MonitorPlayer({ config }: { config: IcecastConfig }) {
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.8);
  const audioRef = useRef<HTMLAudioElement>(null);

  const streamUrl = `${getIcecastBaseUrl(config)}${config.mount.name}`;

  // Sync volume without restarting stream
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Cleanup on unmount
  useEffect(() => {
    const audio = audioRef.current;
    return () => { if (audio) { audio.pause(); audio.src = ''; } };
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing || buffering) {
      audio.pause();
      audio.src = '';
      setPlaying(false);
      setBuffering(false);
      setError(null);
    } else {
      setError(null);
      setBuffering(true);
      // Append a cache-buster so the browser doesn't serve a stale response
      audio.src = `${streamUrl}?t=${Date.now()}`;
      audio.volume = volume;
      audio.play().catch((e: Error) => {
        setBuffering(false);
        setError(e.message);
      });
    }
  };

  return (
    <div className="border-t border-zinc-800 pt-4">
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          title={playing || buffering ? 'Stop monitoring' : 'Listen live'}
          className={`flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full transition-colors ${
            playing
              ? 'bg-zinc-700 hover:bg-zinc-600 text-white'
              : buffering
                ? 'bg-zinc-700 text-zinc-400'
                : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white'
          }`}
        >
          {buffering ? (
            <Loader className="w-3.5 h-3.5 animate-spin" />
          ) : playing ? (
            <Square className="w-3.5 h-3.5 fill-current" />
          ) : (
            <Headphones className="w-3.5 h-3.5" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-zinc-300">Monitor</span>
            {playing && <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />}
          </div>
          <p className="text-xs font-mono text-zinc-500 truncate">{config.mount.name}</p>
        </div>

        {error && (
          <span className="text-xs text-red-400 truncate max-w-[160px]" title={error}>
            {error}
          </span>
        )}

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Volume2 className="w-3.5 h-3.5 text-zinc-500" />
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-20 accent-brand-500"
          />
        </div>
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audioRef}
        onPlaying={() => { setBuffering(false); setPlaying(true); }}
        onWaiting={() => setBuffering(true)}
        onError={() => { setBuffering(false); setPlaying(false); setError('Stream unavailable — is Icecast running?'); }}
        onEnded={() => { setPlaying(false); setBuffering(false); }}
      />
    </div>
  );
}
