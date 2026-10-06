import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

// Postgres puts whole rows (client notes included) into some messages; never let them leave the server.
const ROW_DATA = /(Failing row contains|Key \([^)]*\)=)\s*\(.*?\)/gs;
const redact = (s: string) => s.replace(ROW_DATA, '$1 [redacted]');

/** Strips anything that could carry PHI or credentials: bodies, query strings, auth headers, user email, row data. */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) for (const h of ['authorization', 'x-dev-sub', 'cookie']) delete event.request.headers[h];
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  for (const ex of event.exception?.values ?? []) if (ex.value) ex.value = redact(ex.value);
  if (event.message) event.message = redact(event.message);
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.filter(b => b.category !== 'console');
  return event;
}

/** Collect stack traces and error types only. Shared shape with the web app's config. */
export const SAFE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ['user-agent', 'content-type'] }, response: false },
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
  queues: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
} satisfies NonNullable<Parameters<typeof Sentry.init>[0]>['dataCollection'];

export const errorTracking = {
  enabled: false,
  init() {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;
    Sentry.init({
      dsn,
      environment: process.env.APP_ENV ?? 'development',
      release: process.env.RELEASE,
      tracesSampleRate: 0,
      // Sentry v11 collects bodies, headers, query strings and local variables by default. All of those can hold PHI.
      dataCollection: SAFE_DATA_COLLECTION,
      beforeSend: scrubEvent,
    });
    this.enabled = true;
  },
  capture(err: unknown, context: { userId?: string | undefined; route?: string | undefined; code?: string | undefined }) {
    if (!this.enabled) return;
    Sentry.withScope(scope => {
      if (context.userId) scope.setUser({ id: context.userId }); // opaque id only
      if (context.route) scope.setTag('route', context.route);
      if (context.code) scope.setTag('pg_code', context.code);
      Sentry.captureException(err);
    });
  },
};
