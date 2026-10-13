import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { call, seedPair, signInAs } from './helpers';

// WCAG 2.1 AA, checked in both color schemes.
const audit = async (page: Page) => {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
};

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${colorScheme})`, () => {
    test.use({ colorScheme });
    test('landing, signup and login', async ({ page }) => {
      for (const path of ['/', '/signup', '/signup?role=supervisor', '/login', '/help']) {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        await audit(page);
      }
    });
    test('trainee and supervisor dashboards', async ({ page }) => {
      const { sup, trainee } = await seedPair();
      const [s] = await call(trainee, '/supervisors');
      await call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId: s.id, workDate: '2026-09-02', startTime: '09:00', endTime: '10:00', kind: 'supervised', contact: 'observation', format: 'in_person' });
      await signInAs(page, trainee, '/app?month=2026-09');
      await expect(page.locator('.sync')).toHaveText('✓ Synced');
      await audit(page);
      await signInAs(page, sup, '/supervise?month=2026-09');
      await expect(page.getByText('Pat Trainee')).toBeVisible();
      await audit(page);
      await page.getByRole('link', { name: 'Review' }).click();
      await expect(page.getByRole('heading', { name: 'Requirements' })).toBeVisible();
      await audit(page);
    });
  });
}
