import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { scrubEvent } from './observability.js';

describe('scrubEvent', () => {
  it('removes bodies, credentials, query strings, email and Postgres row data', () => {
    const event = {
      type: undefined,
      request: { data: '{"description":"client J.D. tantrum"}', query_string: 'month=2026-09', cookies: { a: 'b' }, headers: { authorization: 'Bearer x', 'x-dev-sub': 'mom@x', 'user-agent': 'ua' } },
      user: { id: 'u1', email: 'mom@x', ip_address: '1.2.3.4' },
      exception: { values: [{ type: 'error', value: 'new row violates check constraint "entries_check" Failing row contains (abc, 2026-09-01, client J.D. tantrum).' }] },
      breadcrumbs: [{ category: 'console', message: 'J.D.' }, { category: 'fetch', message: 'GET /api/me' }],
    } as unknown as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.request).toEqual({ headers: { 'user-agent': 'ua' } });
    expect(out.user).toEqual({ id: 'u1' });
    expect(out.exception!.values![0]!.value).toBe('new row violates check constraint "entries_check" Failing row contains [redacted].');
    expect(JSON.stringify(out)).not.toMatch(/J\.D\.|mom@x|Bearer/);
  });
});
