import { useQuery } from '@tanstack/react-query';
import { Activity, Users, Gauge, Radio } from 'lucide-react';
import { fetchIcecastStats, fetchIcecastConfig } from '../api';

export function Dashboard() {
  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['icecast-stats'],
    queryFn: fetchIcecastStats,
    refetchInterval: 3000,
  });

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ['icecast-config'],
    queryFn: fetchIcecastConfig,
  });

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
      <div>
        <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        <p className="text-zinc-400 mt-2">
          {isOnline ? '✓ Icecast is running' : '✗ Icecast is not responding'}
        </p>
      </div>

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
            href={`http://${config?.server.hostname || 'localhost'}:${config?.network.port || 8000}/admin/`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 hover:border-indigo-600 transition-colors cursor-pointer"
          >
            <p className="text-zinc-400 text-sm font-medium">Server (Admin)</p>
            <p className="text-sm text-indigo-400 mt-2 font-mono underline">
              {config?.server.hostname || 'localhost'}:{config?.network.port || 8000}/admin
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
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-white">{mount.name}</p>
                    <p className="text-xs text-zinc-500 mt-1">
                      Max {mount.max_listeners === -1 ? 'unlimited' : mount.max_listeners} listeners
                      {mount.fallback_mount && ` • Fallback: ${mount.fallback_mount}`}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Error State */}
      {statsError && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-6 text-red-300">
          <p className="font-medium">Icecast Not Responding</p>
          <p className="text-sm mt-1">
            Start Icecast in another terminal: <code className="bg-red-950 px-2 py-1 rounded text-xs">./start-icecast.sh</code>
          </p>
        </div>
      )}

      {/* Info Box */}
      {isOnline && !statsLoading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <p className="text-zinc-300">
            ✓ Icecast is running and configured correctly.
          </p>
          <p className="text-zinc-400 text-sm mt-2">
            To start broadcasting, connect your audio source to one of the mount points above using the source password from Settings.
          </p>
        </div>
      )}
    </div>
  );
}
