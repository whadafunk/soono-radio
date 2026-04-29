import { useQuery, useMutation } from '@tanstack/react-query';
import { Activity, Users, Gauge, Radio, Power, Loader, Zap, Mic, Music2 } from 'lucide-react';
import {
  fetchIcecastStats,
  fetchIcecastConfig,
  restartIcecast,
  kickIcecastSource,
  fetchSupervisorStatus,
  fetchNowPlaying,
  fetchRecentPlays,
} from '../api';
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
              <Users className="w-8 h-8 text-indigo-500" />
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

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <p className="text-zinc-400 text-sm font-medium">Mount Points</p>
            <p className="text-3xl font-bold text-white mt-2">
              {configLoading ? '—' : config?.mounts.length ?? 1}
            </p>
            <p className="text-xs text-zinc-500 mt-2">configured</p>
          </div>

          <a
            href={`http://${config?.server.hostname || 'localhost'}:${config?.network.listen_sockets?.[0]?.port || 8000}/admin/`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-indigo-600 transition-colors cursor-pointer"
          >
            <p className="text-zinc-400 text-sm font-medium">Server (Admin)</p>
            <p className="text-sm text-indigo-400 mt-2 font-mono underline">
              {config?.server.hostname || 'localhost'}:{config?.network.listen_sockets?.[0]?.port || 8000}/admin
            </p>
            <p className="text-xs text-zinc-500 mt-2">{config?.server.location || 'no location'}</p>
          </a>
        </div>
      </section>

      {/* Mount Points Info */}
      {config && config.mounts.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-4">Mount Points</h2>
          <div className="grid grid-cols-1 gap-3">
            {config.mounts.map((mount) => (
              <div key={mount.name} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-white">{mount.name}</p>
                    <p className="text-xs text-zinc-500 mt-1">
                      Max {mount.max_listeners === -1 ? 'unlimited' : mount.max_listeners} listeners
                      {mount.fallback_mount && ` • Fallback: ${mount.fallback_mount}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleKick(mount.name)}
                    disabled={kickingMount === mount.name}
                    title="Force-disconnect any source on this mount (workaround for the Icecast 2.4 SSL stale-source bug). Click twice to confirm."
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0 ${
                      armedMount === mount.name
                        ? 'bg-red-600/20 border-red-600 text-red-300 hover:bg-red-600/30'
                        : 'bg-zinc-800 hover:bg-red-900/30 border-zinc-700 hover:border-red-800 text-zinc-300 hover:text-red-300'
                    }`}
                  >
                    {kickingMount === mount.name ? (
                      <Loader className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    {armedMount === mount.name ? 'Click again to kick' : 'Kick source'}
                  </button>
                </div>
              </div>
            ))}
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

import type { NowPlaying, RecentPlay } from '@radio/shared';

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
                  className={`h-full ${sourceLive ? 'bg-red-500' : 'bg-indigo-500'} transition-all`}
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
