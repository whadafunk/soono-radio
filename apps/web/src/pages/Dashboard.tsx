import { useQuery } from '@tanstack/react-query';
import { Activity, Radio, Users, Gauge, ExternalLink } from 'lucide-react';
import { fetchIcecastStats } from '../api';

export function Dashboard() {
  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['icecast-stats'],
    queryFn: fetchIcecastStats,
    refetchInterval: 3000, // Refresh every 3 seconds
  });

  const formatUptime = (seconds: number): string => {
    if (!seconds) return '0s';
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const isOnline = !error && stats && stats.listener >= 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Dashboard</h1>
          <p className="text-zinc-400 mt-2">Monitor your radio stream in real-time</p>
        </div>
        <a
          href="http://localhost:8000"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
        >
          <ExternalLink className="w-4 h-4" />
          Icecast Web
        </a>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Status</p>
              <p className={`text-2xl font-bold mt-2 flex items-center gap-1 ${isOnline ? 'text-green-400' : 'text-red-400'}`}>
                ● {isOnline ? 'LIVE' : 'OFFLINE'}
              </p>
            </div>
            <Activity className={`w-8 h-8 ${isOnline ? 'text-green-500' : 'text-red-500'}`} />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Listeners</p>
              <p className="text-2xl font-bold text-white mt-2">
                {isLoading ? '...' : stats?.listener ?? 0}
              </p>
              <p className="text-xs text-zinc-500 mt-1">current</p>
            </div>
            <Users className="w-8 h-8 text-indigo-500" />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Bitrate</p>
              <p className="text-2xl font-bold text-white mt-2">
                {isLoading ? '...' : stats?.bitrate ?? 0}
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
                {isLoading ? '...' : formatUptime(stats?.uptime ?? 0)}
              </p>
              <p className="text-xs text-zinc-500 mt-1">since start</p>
            </div>
            <Radio className="w-8 h-8 text-cyan-500" />
          </div>
        </div>
      </div>

      {/* Info Section */}
      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-6 text-red-300">
          <p className="font-medium">Icecast Unreachable</p>
          <p className="text-sm mt-1">Make sure Icecast is running: <code className="bg-red-950 px-2 py-1 rounded text-xs">./start-icecast.sh</code></p>
        </div>
      )}

      {isOnline && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <p className="text-zinc-300">
            ✓ Icecast is running and streaming to listeners.
          </p>
          <p className="text-zinc-400 text-sm mt-2">
            Access the Icecast web interface at{' '}
            <a
              href="http://localhost:8000"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-400 hover:text-indigo-300 underline"
            >
              http://localhost:8000
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
