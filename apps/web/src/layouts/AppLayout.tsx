import { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Menu, X,
  LayoutDashboard, Music2, Users, Calendar,
  Settings, ListMusic, ShieldCheck, Timer, Mic2, UserCog, Repeat, Loader, Megaphone, Activity,
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
  { label: 'Supervisor',   path: '/supervisor',   icon: Activity        },
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
        <div className="h-14 px-3 flex items-center border-b border-zinc-800 overflow-hidden">
          {sidebarOpen ? (
            /* Full logo: icon + wordmark */
            <svg width="108" height="31" viewBox="0 0 240 68" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0">
              <defs>
                <linearGradient id="sl" x1="34" y1="60" x2="45.8" y2="10.8" gradientUnits="userSpaceOnUse">
                  <stop offset="0%"   stopColor="#36c8c8" stopOpacity="0"/>
                  <stop offset="100%" stopColor="#36c8c8" stopOpacity="0.88"/>
                </linearGradient>
              </defs>
              <path d="M 34,60 A 26,26 0 1,1 45.8,10.8" stroke="url(#sl)" strokeWidth="3.6" strokeLinecap="butt" fill="none"/>
              <path d="M 38.85,27.1 A 8.45,8.45 0 0,1 38.85,40.9"   stroke="#36c8c8" strokeWidth="1.6" strokeLinecap="round"/>
              <path d="M 43.7,20.2  A 16.9,16.9 0 0,1 43.7,47.8"    stroke="#36c8c8" strokeWidth="1.3" strokeLinecap="round" opacity="0.65"/>
              <path d="M 48.55,13.2 A 25.35,25.35 0 0,1 48.55,54.8" stroke="#36c8c8" strokeWidth="1.0" strokeLinecap="round" opacity="0.4"/>
              <line x1="34" y1="34" x2="22.7" y2="27.5" stroke="#36c8c8" strokeWidth="2.6" strokeLinecap="round"/>
              <line x1="34" y1="34" x2="34"   y2="13.2" stroke="#36c8c8" strokeWidth="1.4" strokeLinecap="round"/>
              <circle cx="34" cy="34" r="2.6" stroke="#36c8c8" strokeWidth="1.3" fill="#18181b"/>
              <circle cx="34" cy="34" r="1"   fill="#36c8c8"/>
              <text x="74" y="48" fontFamily="Inter, sans-serif" fontWeight="500" fontSize="40" letterSpacing="-1.2" fill="#36c8c8">Soono</text>
            </svg>
          ) : (
            /* Icon mark only */
            <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className="flex-shrink-0 mx-auto">
              <defs>
                <linearGradient id="si" x1="50" y1="90" x2="68.15" y2="14.35" gradientUnits="userSpaceOnUse">
                  <stop offset="0%"   stopColor="#36c8c8" stopOpacity="0"/>
                  <stop offset="100%" stopColor="#36c8c8" stopOpacity="0.88"/>
                </linearGradient>
              </defs>
              <path d="M 50,90 A 40,40 0 1,1 68.15,14.35" stroke="url(#si)" strokeWidth="5.5" strokeLinecap="butt" fill="none"/>
              <path d="M 57.5,39.3 A 13,13 0 0,1 57.5,60.7" stroke="#36c8c8" strokeWidth="2.5" strokeLinecap="round"/>
              <path d="M 64.9,28.7 A 26,26 0 0,1 64.9,71.3" stroke="#36c8c8" strokeWidth="2"   strokeLinecap="round" opacity="0.65"/>
              <path d="M 72.4,18.1 A 39,39 0 0,1 72.4,81.9" stroke="#36c8c8" strokeWidth="1.6" strokeLinecap="round" opacity="0.4"/>
              <line x1="50" y1="50" x2="32.7" y2="40" stroke="#36c8c8" strokeWidth="4"   strokeLinecap="round"/>
              <line x1="50" y1="50" x2="50"   y2="18" stroke="#36c8c8" strokeWidth="2.2" strokeLinecap="round"/>
              <circle cx="50" cy="50" r="4"   stroke="#36c8c8" strokeWidth="2" fill="#18181b"/>
              <circle cx="50" cy="50" r="1.5" fill="#36c8c8"/>
            </svg>
          )}
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
                    ? 'bg-brand-600 text-white'
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
                        <Loader className="w-2.5 h-2.5 animate-spin text-brand-400" />
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
