import { expect, test } from '@playwright/test';
import { call, logEntry, seedPair, signInAs } from './helpers';

test('signup through UI, link by code, log a full month, both sign, month locks', async ({ browser }) => {
  // Supervisor signs up in the UI
  const supPage = await (await browser.newContext()).newPage();
  const run = Date.now();
  await supPage.goto('/signup?role=supervisor');
  await supPage.getByLabel('Email').fill(`ui-sup${run}@e2e.test`);
  await supPage.getByLabel('Full name').fill('Lorinda Otto');
  await supPage.getByLabel('BACB certification number').fill('1-11-11111');
  await supPage.getByRole('button', { name: 'Create account' }).click();
  await supPage.waitForURL('**/supervise');
  const code = (await supPage.locator('code.invite').textContent())!.trim();

  // Trainee signs up and links with the code (lowercase on purpose)
  const page = await (await browser.newContext()).newPage();
  await page.goto('/signup?role=trainee');
  await page.getByLabel('Email').fill(`ui-trainee${run}@e2e.test`);
  await page.getByLabel('Full name').fill('Pat Trainee');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/app');
  await page.locator('.highlight input[placeholder=ABCD2345]').fill(code.toLowerCase());
  await page.locator('.highlight input[type=date]').fill('2026-09-01');
  await page.locator('.highlight').getByRole('button', { name: 'Add supervisor' }).click();
  await expect(page.getByRole('heading', { name: 'Log hours' })).toBeVisible();

  // A compliant concentrated month: 18 h independent + 6 supervised contacts incl. one observation
  await page.getByLabel('Previous month').click();
  await logEntry(page, '2026-09-01', '08:00', '17:00');
  await logEntry(page, '2026-09-02', '08:00', '17:00');
  await logEntry(page, '2026-09-03', '09:00', '10:00', 'Supervised', 'observation');
  for (const d of ['04', '05', '06', '07', '08']) await logEntry(page, `2026-09-${d}`, '09:00', '09:30', 'Supervised', 'contact');
  await expect(page.locator('.sync')).toHaveText('✓ Synced');
  await expect(page.locator('.checklist li.no')).toHaveCount(0);

  await page.getByRole('button', { name: /Sign Sep/ }).click();
  await expect(page.getByText('waiting on supervisor')).toBeVisible();

  await supPage.goto('/supervise?month=2026-09');
  await expect(supPage.getByText('Ready for your signature')).toBeVisible();
  await supPage.getByRole('link', { name: 'Review' }).click();
  supPage.on('dialog', d => d.accept());
  await supPage.getByRole('button', { name: 'Sign & lock month' }).click();
  await expect(supPage.getByText('✓ Signed', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('✓ Signed & locked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('supervisor only sees hours logged under them', async ({ page }) => {
  const { sup, trainee } = await seedPair();
  await call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId: (await call(trainee, '/supervisors'))[0].id, workDate: '2026-09-10', startTime: '08:00', endTime: '10:00', kind: 'independent' });
  const other = await seedPair();
  await signInAs(page, other.sup, '/supervise?month=2026-09');
  await expect(page.getByText('Pat Trainee')).toHaveCount(1); // only their own trainee
  const res = await call(other.sup, `/entries?month=2026-09&traineeId=${(await call(trainee, '/me')).id}`);
  expect(res.error).toBe('Not found');
  void sup;
});
