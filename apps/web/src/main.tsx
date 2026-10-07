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
import { persistOptions, queryClient } from './query';
import { ErrorBoundary, initErrorTracking, setErrorUser } from './observability';
import './styles.css';


function RequireUser({ role, children }: { role: Me['role']; children: (me: Me) => ReactElement }) {
  const me = useMe(), loc = useLocation();
  const authStatus = me.error instanceof ApiError ? me.error.status : 0;
  if (authStatus === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (authStatus === 403) return <Navigate to="/signup" replace />;
  if (!me.data) return me.error ? <main className="center error">Couldn't load your account. {me.error.message}</main> : <main className="center muted">Loading…</main>;
  setErrorUser(me.data.id); // opaque id only, never name or email
  if (me.data.role !== role) return <Navigate to={homeFor(me.data.role)} replace />;
  return children(me.data);
}

initErrorTracking();

function Crash() {
  return (
    <main className="center stack">
      <h1>Something went wrong</h1>
      <p className="muted">Your saved hours are safe on this device and on our servers. The error was reported automatically.</p>
      <button className="primary" onClick={() => location.reload()}>Reload</button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={<Crash />}>
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
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
    </ErrorBoundary>
  </StrictMode>,
);
