import { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { Menu, X, Radio } from 'lucide-react';

const navItems = [
  { label: 'Dashboard', path: '/' },
  { label: 'Settings', path: '/settings/icecast' },
  { label: 'LiquidSoap', path: '/liquidsoup' },
  { label: 'Playlists', path: '/playlists' },
  { label: 'Jingles', path: '/jingles' },
];

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? 'w-64' : 'w-20'
        } bg-zinc-900 border-r border-zinc-800 transition-all duration-200 flex flex-col`}
      >
        {/* Logo */}
        <div className="p-4 flex items-center gap-3 border-b border-zinc-800">
          <Radio className="w-6 h-6 text-indigo-500" />
          {sidebarOpen && <h1 className="font-bold text-lg">RADIO</h1>}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <div className="w-5 h-5" />
                {sidebarOpen && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Toggle Button */}
        <div className="p-4 border-t border-zinc-800">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="w-full p-2 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            {sidebarOpen ? (
              <X className="w-5 h-5 text-zinc-400" />
            ) : (
              <Menu className="w-5 h-5 text-zinc-400" />
            )}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Bar */}
        <header className="bg-zinc-900 border-b border-zinc-800 px-6 py-4">
          <h2 className="text-xl font-semibold text-zinc-100">Radio Automation System</h2>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
