import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AppLayout } from './layouts/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { IcecastSettings } from './pages/settings/IcecastSettings';
import { ComingSoon } from './pages/ComingSoon';

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings/icecast" element={<IcecastSettings />} />
            <Route path="/liquidsoup" element={<ComingSoon page="LiquidSoap" />} />
            <Route path="/playlists" element={<ComingSoon page="Playlists" />} />
            <Route path="/jingles" element={<ComingSoon page="Jingles" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
