import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AppLayout } from './layouts/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { IcecastSettings } from './pages/settings/IcecastSettings';
import { CertificatesSettings } from './pages/settings/CertificatesSettings';
import { UsersSettings } from './pages/settings/UsersSettings';
import { LiquidSoapSettings } from './pages/settings/LiquidSoapSettings';
import { ComingSoon } from './pages/ComingSoon';

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/certificates" element={<CertificatesSettings />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="icecast" replace />} />
              <Route path="icecast" element={<IcecastSettings />} />
              <Route path="users" element={<UsersSettings />} />
              <Route path="liquidsoap" element={<LiquidSoapSettings />} />
            </Route>
            <Route path="/liquidsoup" element={<ComingSoon page="LiquidSoap" />} />
            <Route path="/playlists" element={<ComingSoon page="Playlists" />} />
            <Route path="/jingles" element={<ComingSoon page="Jingles" />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
