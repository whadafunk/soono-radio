import { NavLink, Outlet, useLocation } from 'react-router-dom';

const TABS = [
  { to: '/customers', label: 'Customers & Spot Campaigns', end: true },
  { to: '/customers/music-campaigns', label: 'Music Campaigns', end: false },
];

export function CustomersLayout() {
  const location = useLocation();
  // Subtitle adapts to which tab is active — keeps the existing "advertisers"
  // phrasing on the main tab while signalling the heavy-rotation focus on the
  // music tab.
  const onMusic = location.pathname.startsWith('/customers/music-campaigns');

  return (
    <div className="space-y-6 h-full flex flex-col">
      <div>
        <h1 className="text-3xl font-bold text-white">Customers</h1>
        <p className="text-zinc-400 mt-2">
          {onMusic
            ? 'Promote contracted songs across heavy-rotation music segments.'
            : 'Manage advertisers and their campaigns.'}
        </p>
      </div>
      <div className="border-b border-zinc-800 flex gap-1">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `px-4 py-2 text-sm border-b-2 transition-colors -mb-px ${
                isActive
                  ? 'text-white border-indigo-500'
                  : 'text-zinc-400 border-transparent hover:text-zinc-200'
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
