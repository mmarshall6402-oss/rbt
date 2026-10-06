import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { ApiError, homeFor, useMe, type Me } from './api';
import { Landing } from './pages/Landing';
import { Login, AuthCallback } from './pages/Login';
import { Signup } from './pages/Signup';
import { TraineeDashboard } from './pages/Trainee';
import { SupervisorDashboard, TraineeReview } from './pages/Supervisor';
import { persister, queryClient } from './query';
import './styles.css';


function RequireUser({ role, children }: { role: Me['role']; children: (me: Me) => ReactElement }) {
  const me = useMe(), loc = useLocation();
  const authStatus = me.error instanceof ApiError ? me.error.status : 0;
  if (authStatus === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (authStatus === 403) return <Navigate to="/signup" replace />;
  if (!me.data) return me.error ? <main className="center error">Couldn't load your account. {me.error.message}</main> : <main className="center muted">Loading…</main>;
  if (me.data.role !== role) return <Navigate to={homeFor(me.data.role)} replace />;
  return children(me.data);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 7 * 24 * 3600_000, buster: 'v1' }}>
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
    </PersistQueryClientProvider>
  </StrictMode>,
);
