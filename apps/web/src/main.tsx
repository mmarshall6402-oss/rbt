import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, homeFor, useMe, type Me } from './api';
import { Landing } from './pages/Landing';
import { Login, AuthCallback } from './pages/Login';
import { Signup } from './pages/Signup';
import { TraineeDashboard } from './pages/Trainee';
import { SupervisorDashboard, TraineeReview } from './pages/Supervisor';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
});

function RequireUser({ role, children }: { role: Me['role']; children: (me: Me) => ReactElement }) {
  const me = useMe(), loc = useLocation();
  if (me.isPending) return <main className="center muted">Loading…</main>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.error instanceof ApiError && me.error.status === 403) return <Navigate to="/signup" replace />;
  if (me.error) return <main className="center error">Couldn't load your account. {me.error.message}</main>;
  if (me.data.role !== role) return <Navigate to={homeFor(me.data.role)} replace />;
  return children(me.data);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/app" element={<RequireUser role="trainee">{me => <TraineeDashboard me={me} />}</RequireUser>} />
          <Route path="/supervise" element={<RequireUser role="supervisor">{me => <SupervisorDashboard me={me} />}</RequireUser>} />
          <Route path="/supervise/:traineeId" element={<RequireUser role="supervisor">{me => <TraineeReview me={me} />}</RequireUser>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
