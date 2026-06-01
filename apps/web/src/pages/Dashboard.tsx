import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Users, Gauge, Radio, Power, Loader, Zap, Mic, Music2, Pause, Play, RotateCw, Lock, Unlock, Headphones, Square, Volume2 } from 'lucide-react';
import {
  fetchIcecastStats,
  fetchIcecastConfig,
  restartIcecast,
  kickIcecastSource,
  fetchSupervisorStatus,
  fetchNowPlaying,
  fetchRecentPlays,
  fetchSimulate,
  supervisorPause,
  supervisorResume,
  supervisorResync,
  supervisorHold,
  supervisorReleaseHold,
} from '../api';
import type { SupervisorStatus } from '@soono/shared';
import { useEffect, useRef, useState } from 'react';

export function Dashboard() {
  const [restartToast, setRestartToast] = useState<string | null>(null);

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['icecast-stats'],
    queryFn: fetchIcecastStats,
    refetchInterval: 3000,
  });

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
  });

  const { data: supStatus } = useQuery({
    queryKey: ['supervisor-status'],
    queryFn: fetchSupervisorStatus,
    refetchInterval: 3000,
  });

  const { data: nowPlaying } = useQuery({
    queryKey: ['supervisor-now-playing'],
    queryFn: fetchNowPlaying,
    refetchInterval: 3000,
  });

  const { data: recentPlays = [] } = useQuery({
    queryKey: ['supervisor-recent-plays'],
    queryFn: () => fetchRecentPlays(10),
    refetchInterval: 5000,
  });

  const restartMutation = useMutation({
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

  const isOnline = !statsError && stats && stats.listener >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Dashboard</h1>
          <p className="text-zinc-400 mt-2">
            {isOnline ? '✓ Streaming Engine is running' : '✗ Streaming Engine is not responding'}
          </p>
        </div>
        <button
          onClick={() => restartMutation.mutate()}
          disabled={restartMutation.isPending}
          title="Restart Streaming Engine"
          className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {restartMutation.isPending ? (
            <>
              <Loader className="w-4 h-4 animate-spin" />
              Restarting...
            </>
          ) : (
            <>
              <Power className="w-4 h-4" />
              Restart Streaming
            </>
          )}
        </button>
      </div>

      {restartToast && (
        <div className="bg-amber-900/20 border border-amber-800 rounded-lg p-3 text-amber-300 text-sm">
          {restartToast}
        </div>
      )}

      {/* Now Playing */}
      <NowPlayingCard
        nowPlaying={nowPlaying ?? null}
        queueDepth={supStatus?.queue_depth ?? 0}
        listenerCount={stats?.listener ?? 0}
        reachable={supStatus?.reachable ?? false}
        onAirSource={supStatus?.on_air_source ?? 'none'}
      />

      {/* Monitor Player */}
      {config && <MonitorPlayer config={config} />}

      {/* Now Running — schedule resolver + supervisor controls */}
      {supStatus && <NowRunningCard status={supStatus} />}

      {/* Live Stream Stats */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">Live Stream</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                <p className="text-zinc-400 text-sm font-medium">Bitrate</p>
                <p className="text-2xl font-bold text-white mt-2">
                  {statsLoading ? '—' : stats?.bitrate ?? 0}
                </p>
                <p className="text-xs text-zinc-500 mt-1">kbps</p>
              </div>
              <Gauge className="w-8 h-8 text-amber-500" />
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-zinc-400 text-sm font-medium">Uptime</p>
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
            href={`http://${config?.server.hostname || 'localhost'}:${config?.network.listen_sockets?.[0]?.port || 8000}/admin/`}
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

      <RecentPlaysSection plays={recentPlays} />

      {/* Info Box */}
      {isOnline && !statsLoading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <p className="text-zinc-300">
            ✓ Streaming Engine is running and configured correctly.
          </p>
          <p className="text-zinc-400 text-sm mt-2">
            To start broadcasting, connect your audio source to one of the mount points above using the source password from Settings.
          </p>
        </div>
      )}
    </div>
  );
}

import type { IcecastConfig, NowPlaying, RecentPlay } from '@soono/shared';

function NowPlayingCard({
  nowPlaying,
  queueDepth,
  listenerCount,
  reachable,
  onAirSource,
}: {
  nowPlaying: NowPlaying;
  queueDepth: number;
  listenerCount: number;
  reachable: boolean;
  onAirSource: 'live' | 'auto' | 'none';
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!reachable) {
    return (
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex items-center gap-4">
        <Mic className="w-10 h-10 text-zinc-700" />
        <div>
          <p className="text-zinc-400 text-sm font-medium">Now Playing</p>
          <p className="text-xl font-bold text-zinc-500 mt-1">● MIX ENGINE OFFLINE</p>
          <p className="text-xs text-zinc-600 mt-1">
            Start the Mix Engine to begin broadcasting:{' '}
            <code className="bg-zinc-950 px-1.5 py-0.5 rounded">./start-liquidsoap.sh</code>
          </p>
        </div>
      </section>
    );
  }

  if (!nowPlaying) {
    return (
      <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 flex items-center gap-4">
        <Mic className="w-10 h-10 text-zinc-700" />
        <div className="flex-1">
          <p className="text-zinc-400 text-sm font-medium">Now Playing</p>
          <p className="text-xl font-bold text-zinc-500 mt-1">● SILENCE</p>
          <p className="text-xs text-zinc-600 mt-1">
            Nothing in the queue. The Supervisor is waiting for an eligible track (separation cooldown or empty library).
          </p>
        </div>
        <div className="text-right text-xs text-zinc-500">
          <div>queue: {queueDepth}</div>
          <div>listeners: {listenerCount}</div>
        </div>
      </section>
    );
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(nowPlaying.started_at).getTime()) / 1000),
  );
  const totalSeconds = nowPlaying.duration_seconds ?? 0;
  const progress = totalSeconds > 0 ? Math.min(1, elapsedSeconds / totalSeconds) : 0;
  const sourceLive = onAirSource === 'live' || nowPlaying.source === 'live';
  const display = nowPlaying.title || nowPlaying.original_filename || '(unknown)';
  const artist = nowPlaying.artist;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
      <div className="flex items-start gap-4">
        <Music2 className={`w-10 h-10 flex-shrink-0 ${sourceLive ? 'text-red-500' : 'text-green-500'}`} />
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
          {artist && <p className="text-sm text-zinc-400 truncate">{artist}</p>}
          {totalSeconds > 0 && (
            <div className="mt-3">
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full ${sourceLive ? 'bg-red-500' : 'bg-brand-500'} transition-all`}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-zinc-500 mt-1 font-mono">
                <span>{formatMmSs(elapsedSeconds)}</span>
                <span>{formatMmSs(totalSeconds)}</span>
              </div>
            </div>
          )}
        </div>
        <div className="text-right text-xs text-zinc-500 space-y-1 flex-shrink-0">
          <div>queue: <span className="text-zinc-300 font-mono">{queueDepth}</span></div>
          <div>listeners: <span className="text-zinc-300 font-mono">{listenerCount}</span></div>
          {nowPlaying.live_listener_count !== null && (
            <div className="text-zinc-600">at start: {nowPlaying.live_listener_count}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function NowRunningCard({ status }: { status: SupervisorStatus }) {
  const qc = useQueryClient();
  const [pendingError, setPendingError] = useState<string | null>(null);

  const onMutate = (label: string) => ({
    onSuccess: () => qc.invalidateQueries({ queryKey: ['supervisor-status'] }),
    onError: (e: Error) => setPendingError(`${label}: ${e.message}`),
  });

  const pauseM = useMutation({ mutationFn: supervisorPause, ...onMutate('Pause') });
  const resumeM = useMutation({ mutationFn: supervisorResume, ...onMutate('Resume') });
  const resyncM = useMutation({ mutationFn: supervisorResync, ...onMutate('Resync') });
  const holdM = useMutation({ mutationFn: supervisorHold, ...onMutate('Hold') });
  const releaseM = useMutation({ mutationFn: supervisorReleaseHold, ...onMutate('Release hold') });
  const pending =
    pauseM.isPending ||
    resumeM.isPending ||
    resyncM.isPending ||
    holdM.isPending ||
    releaseM.isPending;

  const scheduled = status.scheduled;
  const paused = status.paused;
  const held = status.held != null;

  const progressPct = scheduled
    ? (scheduled.segment_elapsed_seconds /
        Math.max(1, scheduled.segment_elapsed_seconds + scheduled.segment_remaining_seconds)) *
      100
    : 0;

  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2 flex-wrap">
            Now running
            {paused && (
              <span className="text-amber-300 bg-amber-900/30 border border-amber-800/50 px-1.5 py-0.5 rounded font-mono text-[10px]">
                PAUSED
              </span>
            )}
            {held && (
              <span className="text-brand-300 bg-brand-900/30 border border-brand-800/50 px-1.5 py-0.5 rounded font-mono text-[10px]">
                HELD
              </span>
            )}
            {scheduled?.hard_cut_warning && (
              <span
                className="text-rose-300 bg-rose-900/30 border border-rose-800/50 px-1.5 py-0.5 rounded font-mono text-[10px]"
                title="Next segment has a fixed start — the current segment can't be shortened, so an audible cut is coming."
              >
                HARD CUT IN ~{formatHms(scheduled.segment_remaining_seconds)}
              </span>
            )}
            {scheduled && scheduled.drift_seconds !== 0 && (
              <span
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] border ${
                  scheduled.drift_seconds > 5
                    ? 'text-amber-300 bg-amber-900/30 border-amber-800/50'
                    : scheduled.drift_seconds < -5
                      ? 'text-cyan-300 bg-cyan-900/30 border-cyan-800/50'
                      : 'text-zinc-400 bg-zinc-800/50 border-zinc-700/50'
                }`}
                title={
                  scheduled.drift_seconds > 0
                    ? 'Music has played fewer seconds than the segment has elapsed — running behind.'
                    : 'Music has played more seconds than the segment has elapsed — segment will overrun.'
                }
              >
                {scheduled.drift_seconds > 0
                  ? `+${scheduled.drift_seconds}s BEHIND`
                  : `${scheduled.drift_seconds}s AHEAD`}
              </span>
            )}
          </div>
          {scheduled ? (
            <>
              <h2 className="text-lg font-semibold text-white flex items-center gap-2 flex-wrap">
                <span>{scheduled.clock_name}</span>
                <span className="text-zinc-500">·</span>
                <span className="text-brand-300">{scheduled.segment_name}</span>
                <span className="text-xs text-zinc-500 font-mono lowercase">
                  {scheduled.segment_type}
                </span>
              </h2>
              {scheduled.show_name && (
                <p className="text-xs text-zinc-500 mt-1">
                  Show: <span className="text-zinc-400">{scheduled.show_name}</span>
                </p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <span className="text-xs font-mono text-zinc-400 w-12 text-right">
                  {formatHms(scheduled.segment_elapsed_seconds)}
                </span>
                <div className="flex-1 h-2 bg-zinc-800 rounded overflow-hidden">
                  <div
                    className="h-full bg-brand-500 transition-all"
                    style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-zinc-500 w-12">
                  {held ? '—' : formatHms(scheduled.segment_remaining_seconds)}
                </span>
              </div>
            </>
          ) : (
            <p className="text-zinc-500 italic text-sm">No segment resolves to this moment.</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {paused ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => resumeM.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-sm transition disabled:opacity-40"
            >
              <Play className="w-4 h-4" />
              Resume
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || !status.running}
              onClick={() => pauseM.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white rounded text-sm transition disabled:opacity-40"
            >
              <Pause className="w-4 h-4" />
              Pause
            </button>
          )}
          <button
            type="button"
            disabled={pending || !status.running}
            onClick={() => {
              if (confirm('Resync triggers an immediate scheduler tick — push a new pick now. Continue?')) {
                resyncM.mutate();
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm transition disabled:opacity-40"
            title="Trigger an immediate pick. Does not flush LS's existing queue."
          >
            <RotateCw className="w-4 h-4" />
            Resync
          </button>
          {held ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => releaseM.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm transition disabled:opacity-40"
            >
              <Unlock className="w-4 h-4" />
              Release hold
            </button>
          ) : (
            <button
              type="button"
              disabled={pending || !scheduled || !status.running}
              onClick={() => holdM.mutate()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-white rounded text-sm transition disabled:opacity-40"
              title="Pin the current segment — schedule resolver stops advancing"
            >
              <Lock className="w-4 h-4" />
              Hold
            </button>
          )}
        </div>
      </div>
      {pendingError && (
        <p className="text-xs text-rose-400 mt-3">{pendingError}</p>
      )}
    </section>
  );
}

function formatHms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
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
                    {p.media ? formatMmSs(p.media.duration_seconds) : '—'}
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

function RecentPlaysSection({ plays }: { plays: RecentPlay[] }) {
  if (plays.length === 0) return null;
  // Drop the very first row if it matches the currently-playing one
  // (no ended_at) — the Now Playing card already shows that.
  const visible = plays.filter((p) => p.ended_at !== null).slice(0, 8);
  if (visible.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">Recent Plays</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-950/50 border-b border-zinc-800">
            <tr>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Time</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Track</th>
              <th className="text-left text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Source</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Duration</th>
              <th className="text-right text-xs font-medium text-zinc-400 uppercase tracking-wider px-3 py-2">Listeners</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const playedSeconds =
                p.ended_at && p.started_at
                  ? Math.max(0, Math.floor((new Date(p.ended_at).getTime() - new Date(p.started_at).getTime()) / 1000))
                  : 0;
              const display = p.title || p.original_filename || (p.source === 'live' ? '(live broadcast)' : '—');
              return (
                <tr key={p.id} className="border-t border-zinc-800/60">
                  <td className="px-3 py-2 text-zinc-400 font-mono text-xs whitespace-nowrap">
                    {formatTimeAgo(p.started_at)}
                  </td>
                  <td className="px-3 py-2 text-zinc-200 truncate max-w-md">
                    {display}
                    {p.artist && <span className="text-zinc-500"> — {p.artist}</span>}
                    {p.aborted && (
                      <span className="ml-2 text-[10px] text-amber-400 font-mono uppercase">aborted</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                        p.source === 'live'
                          ? 'bg-red-900/40 text-red-300'
                          : p.source === 'manual'
                            ? 'bg-amber-900/40 text-amber-300'
                            : 'bg-green-900/40 text-green-300'
                      }`}
                    >
                      {p.source}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-400">
                    {formatMmSs(playedSeconds)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">
                    {p.live_listener_count ?? '—'}
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

function MonitorPlayer({ config }: { config: IcecastConfig }) {
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.8);
  const audioRef = useRef<HTMLAudioElement>(null);

  const socket = config.network.listen_sockets[0];
  const port = socket?.port ?? 8000;
  const proto = socket?.ssl ? 'https' : 'http';
  const streamUrl = `${proto}://localhost:${port}${config.mount.name}`;

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
    <section className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
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
    </section>
  );
}

function formatMmSs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimeAgo(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  const ago = Math.floor((Date.now() - t) / 1000);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
