import * as Sentry from '@sentry/react';
import type { ErrorEvent } from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN;
const ROW_DATA = /(Failing row contains|Key \([^)]*\)=)\s*\(.*?\)/gs;

/** Errors and stack traces only. No bodies, query strings, headers, local variables or session replay: they can hold PHI. */
function scrub(event: ErrorEvent): ErrorEvent {
  if (event.request) { delete event.request.data; delete event.request.query_string; delete event.request.cookies; delete event.request.headers }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = ex.value.replace(ROW_DATA, '$1 [redacted]');
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter(b => b.category !== 'console' && b.category !== 'ui.input');
  return event;
}

export function initErrorTracking() {
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE,
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      stackFrameVariables: false, databaseQueryData: false, queues: false,
      graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
    },
    beforeSend: scrub,
  });
}

export const setErrorUser = (id: string | null) => { if (dsn) Sentry.setUser(id ? { id } : null) };
export const ErrorBoundary = Sentry.ErrorBoundary;
