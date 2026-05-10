import { useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  Menu, X, Radio,
  LayoutDashboard, Music2, Users, Calendar,
  Settings, ListMusic, ShieldCheck, Timer, Mic2, UserCog, Repeat,
} from 'lucide-react';

const navItems = [
  { label: 'Dashboard',    path: '/',             icon: LayoutDashboard },
  { label: 'Schedule',     path: '/schedule',     icon: Calendar        },
  { label: 'Clocks',       path: '/clocks',       icon: Timer           },
  { label: 'Shows',        path: '/shows',        icon: Mic2            },
  { label: 'Library',      path: '/library',      icon: Music2          },
  { label: 'Customers',    path: '/customers',    icon: Users           },
  { label: 'Playlists',    path: '/playlists',    icon: ListMusic       },
  { label: 'Rotations',    path: '/rotations',    icon: Repeat          },
  { label: 'Settings',     path: '/settings',     icon: Settings        },
  { label: 'Users',        path: '/users',        icon: UserCog         },
  { label: 'Certificates', path: '/certificates', icon: ShieldCheck     },
];

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const location = useLocation();

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
            return (
              <Link
                key={path}
                to={path}
                title={sidebarOpen ? undefined : label}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {sidebarOpen && <span className="text-sm font-medium">{label}</span>}
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
        {/* Top Bar */}
        <header className="bg-zinc-900 border-b border-zinc-800 px-6 py-4 flex-shrink-0">
          <h2 className="text-xl font-semibold text-zinc-100">Radio Automation System</h2>
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
