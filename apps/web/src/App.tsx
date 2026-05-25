import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AppLayout } from './layouts/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { IcecastSettings } from './pages/settings/IcecastSettings';
import { CertificatesSettings } from './pages/settings/CertificatesSettings';
import { UsersSettings } from './pages/settings/UsersSettings';
import { LiquidSoapSettings } from './pages/settings/LiquidSoapSettings';
import { SupervisorSettings } from './pages/settings/SupervisorSettings';
import { IntegrationsSettings } from './pages/settings/IntegrationsSettings';
import { SchedulingSettings } from './pages/settings/SchedulingSettings';
import { LibraryLayout } from './pages/library/LibraryLayout';
import { LibraryBrowse } from './pages/library/LibraryBrowse';
import { LibraryUpload } from './pages/library/LibraryUpload';
import { ComingSoon } from './pages/ComingSoon';
import { CustomersLayout } from './pages/customers/CustomersLayout';
import { CustomersList } from './pages/customers/CustomersList';
import { SchedulePage } from './pages/schedule/SchedulePage';
import { SchedulePreviewPage } from './pages/schedule/SchedulePreviewPage';
import { ClocksPage } from './pages/clocks/ClocksPage';
import { ShowsPage } from './pages/shows/ShowsPage';
import { ShowDetailPage } from './pages/shows/ShowDetailPage';
import { RotationsPage } from './pages/rotations/RotationsPage';
import { PlaylistsPage } from './pages/playlists/PlaylistsPage';
import { ActivityPage } from './pages/activity/ActivityPage';
import { PromoPage } from './pages/promo/PromoPage';

const queryClient = new QueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="icecast" replace />} />
              <Route path="icecast" element={<IcecastSettings />} />
              <Route path="liquidsoap" element={<LiquidSoapSettings />} />
              <Route path="supervisor" element={<SupervisorSettings />} />
              <Route path="integrations" element={<IntegrationsSettings />} />
              <Route path="scheduling" element={<SchedulingSettings />} />
            </Route>
            <Route path="/library" element={<LibraryLayout />}>
              <Route index element={<LibraryBrowse />} />
              <Route path="upload" element={<LibraryUpload />} />
              <Route path="activity" element={<ActivityPage />} />
            </Route>
            <Route path="/customers" element={<CustomersLayout />}>
              <Route index element={<CustomersList />} />
            </Route>
            <Route path="/certificates" element={<CertificatesSettings />} />
            <Route path="/users" element={<UsersSettings />} />
            <Route path="/schedule" element={<SchedulePage />} />
            <Route path="/schedule/preview" element={<SchedulePreviewPage />} />
            <Route path="/clocks" element={<ClocksPage />} />
            <Route path="/clocks/:id" element={<ClocksPage />} />
            <Route path="/shows" element={<ShowsPage />} />
            <Route path="/shows/:id" element={<ShowDetailPage />} />
            <Route path="/promo" element={<PromoPage />} />
            <Route path="/playlists" element={<PlaylistsPage />} />
            <Route path="/rotations" element={<RotationsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
