import { Outlet } from 'react-router-dom';

export function CustomersLayout() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
