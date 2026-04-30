import { Outlet } from 'react-router-dom';

export function CustomersLayout() {
  return (
    <div className="space-y-6 h-full flex flex-col">
      <div>
        <h1 className="text-3xl font-bold text-white">Customers & Contracts</h1>
        <p className="text-zinc-400 mt-2">Manage advertisers and their ad contracts.</p>
      </div>
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
