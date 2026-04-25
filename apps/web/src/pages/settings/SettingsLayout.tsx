import { NavLink, Outlet } from 'react-router-dom';

const tabs = [
  { label: 'Icecast', path: '/settings/icecast' },
  { label: 'Certificates', path: '/settings/certificates' },
  { label: 'Users', path: '/settings/users' },
  { label: 'LiquidSoap', path: '/settings/liquidsoap' },
];

export function SettingsLayout() {
  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800">
        <nav className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              className={({ isActive }) =>
                `px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}
