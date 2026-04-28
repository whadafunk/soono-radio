import { NavLink, Outlet } from 'react-router-dom';

const tabs = [
  { label: 'Browse', path: '/library' },
  { label: 'Upload', path: '/library/upload' },
];

export function LibraryLayout() {
  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800">
        <nav className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.path === '/library'}
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
