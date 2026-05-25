import { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Menu, X, Radio,
  LayoutDashboard, Music2, Users, Calendar,
  Settings, ListMusic, ShieldCheck, Timer, Mic2, UserCog, Repeat, Loader, Megaphone,
} from 'lucide-react';
import { fetchActivityStats } from '../api';

const navItems = [
  { label: 'Dashboard',    path: '/',             icon: LayoutDashboard },
  { label: 'Schedule',     path: '/schedule',     icon: Calendar        },
  { label: 'Clocks',       path: '/clocks',       icon: Timer           },
  { label: 'Shows',        path: '/shows',        icon: Mic2            },
  { label: 'Library',      path: '/library',      icon: Music2          },
  { label: 'Playlists',    path: '/playlists',    icon: ListMusic       },
  { label: 'Rotations',    path: '/rotations',    icon: Repeat          },
  { label: 'Advertising',  path: '/customers',    icon: Users           },
  { label: 'Promos',       path: '/promo',        icon: Megaphone       },
  { label: 'Settings',     path: '/settings',     icon: Settings        },
  { label: 'Users',        path: '/users',        icon: UserCog         },
  { label: 'Certificates', path: '/certificates', icon: ShieldCheck     },
];

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

  const { data: activityStats } = useQuery({
    queryKey: ['activity-stats'],
    queryFn: fetchActivityStats,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-56' : 'w-16'} bg-zinc-900 border-r border-zinc-800 transition-all duration-200 flex flex-col flex-shrink-0`}>
        {/* Logo */}
        <div className="h-14 px-4 flex items-center gap-3 border-b border-zinc-800">
          <Radio className="w-5 h-5 text-indigo-500 flex-shrink-0" />
          {sidebarOpen && <span className="font-bold text-base tracking-wide text-white">RADIO</span>}
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 py-3 space-y-0.5">
          {navItems.map(({ label, path, icon: Icon }) => {
            const isActive =
              path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
            const isLibrary = path === '/library';
            const showRunning = isLibrary && (activityStats?.running ?? 0) > 0;
            const showPending = isLibrary && !showRunning && (activityStats?.review_pending ?? 0) > 0;
            return (
              <Link
                key={path}
                to={path}
                title={sidebarOpen ? undefined : label}
                className={`relative flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {sidebarOpen ? (
                  <>
                    <span className="text-sm font-medium flex-1">{label}</span>
                    {showRunning && <Loader className="w-3.5 h-3.5 animate-spin opacity-70" />}
                    {showPending && (
                      <span className="bg-amber-500 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                        {activityStats!.review_pending}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    {showRunning && (
                      <span className="absolute right-2 top-2">
                        <Loader className="w-2.5 h-2.5 animate-spin text-blue-400" />
                      </span>
                    )}
                    {showPending && (
                      <span className="absolute right-1.5 top-1 bg-amber-500 text-black text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center leading-none">
                        {activityStats!.review_pending > 9 ? '9+' : activityStats!.review_pending}
                      </span>
                    )}
                  </>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Toggle */}
        <div className="px-2 py-3 border-t border-zinc-800">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="w-full flex items-center justify-center p-2 hover:bg-zinc-800 rounded-lg transition-colors text-zinc-500 hover:text-zinc-300"
          >
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
