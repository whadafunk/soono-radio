import { Activity, Radio, Users, Gauge } from 'lucide-react';

export function Dashboard() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Dashboard</h1>
        <p className="text-zinc-400 mt-2">Monitor your radio stream in real-time</p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Status</p>
              <p className="text-2xl font-bold text-green-400 mt-2">● LIVE</p>
            </div>
            <Activity className="w-8 h-8 text-green-500" />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Listeners</p>
              <p className="text-2xl font-bold text-white mt-2">42</p>
              <p className="text-xs text-zinc-500 mt-1">/ 500 max</p>
            </div>
            <Users className="w-8 h-8 text-indigo-500" />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Bitrate</p>
              <p className="text-2xl font-bold text-white mt-2">128</p>
              <p className="text-xs text-zinc-500 mt-1">kbps</p>
            </div>
            <Gauge className="w-8 h-8 text-amber-500" />
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-zinc-400 text-sm font-medium">Mount Point</p>
              <p className="text-2xl font-bold text-white mt-2">/stream</p>
              <p className="text-xs text-zinc-500 mt-1">MP3</p>
            </div>
            <Radio className="w-8 h-8 text-cyan-500" />
          </div>
        </div>
      </div>

      {/* Placeholder Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
        <p className="text-zinc-400">
          Icecast connection will display live statistics here once the server is running.
        </p>
      </div>
    </div>
  );
}
