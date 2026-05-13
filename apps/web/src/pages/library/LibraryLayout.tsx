import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader } from 'lucide-react';
import { fetchActivityStats } from '../../api';

export function LibraryLayout() {
  const { data: activityStats } = useQuery({
    queryKey: ['activity-stats'],
    queryFn: fetchActivityStats,
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const tabs = [
    { label: 'Browse',   path: '/library',          end: true  },
    { label: 'Upload',   path: '/library/upload',   end: false },
    { label: 'Activity', path: '/library/activity', end: false },
  ];

  return (
    <div className="space-y-6">
      <div className="border-b border-zinc-800">
        <nav className="flex gap-1 -mb-px">
          {tabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.end}
              className={({ isActive }) =>
                `flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-indigo-500 text-white'
                    : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
                }`
              }
            >
              {tab.label}
              {tab.label === 'Activity' && (activityStats?.running ?? 0) > 0 && (
                <Loader className="w-3 h-3 animate-spin text-blue-400" />
              )}
              {tab.label === 'Activity' && !(activityStats?.running) && (activityStats?.review_pending ?? 0) > 0 && (
                <span className="bg-amber-500 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                  {activityStats!.review_pending}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>

      <Outlet />
    </div>
  );
}
