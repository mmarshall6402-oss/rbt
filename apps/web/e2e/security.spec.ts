import { expect, test } from '@playwright/test';
import { call, seedPair, signInAs } from './helpers';

// The preview server sends the same headers as CloudFront (security-headers.json), so this is the production policy.
test('production security headers are served and no page violates the CSP', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()) });
  const res = await page.goto('/');
  const h = res!.headers();
  expect(h['content-security-policy']).toContain("script-src 'self'");
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect([h['x-frame-options'], h['x-content-type-options']]).toEqual(['DENY', 'nosniff']);

  const { sup, trainee } = await seedPair();
  const [s] = await call(trainee, '/supervisors');
  await call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId: s.id, workDate: '2026-09-02', startTime: '09:00', endTime: '10:00', kind: 'independent' });
  for (const [who, path] of [[trainee, '/app?month=2026-09'], [sup, '/supervise?month=2026-09'], [trainee, '/signup'], [trainee, '/login']] as const) {
    await signInAs(page, who, path);
    await page.waitForLoadState('networkidle');
  }
  expect(violations).toEqual([]);
});
