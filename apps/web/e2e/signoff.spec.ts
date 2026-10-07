import { readFile } from 'node:fs/promises';
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

  // A compliant concentrated month under the 2027 rules (the default): 18 h independent, 90 observed minutes, 7.5%+ supervision
  await page.getByLabel('Previous month').click();
  await logEntry(page, '2026-09-01', '08:00', '17:00');
  await logEntry(page, '2026-09-02', '08:00', '17:00');
  await logEntry(page, '2026-09-03', '09:00', '10:30', 'Supervised', 'observation');
  for (const d of ['04', '05', '06', '07', '08']) await logEntry(page, `2026-09-${d}`, '09:00', '09:30', 'Supervised', 'contact');
  await expect(page.locator('.sync')).toHaveText('✓ Synced');
  await expect(page.locator('.checklist li.no')).toHaveCount(0);
  await expect(page.getByText('BCBA · Concentrated · 2027 rules')).toBeVisible();
  await expect(page.locator('.ring', { hasText: 'Contacts' })).toHaveCount(0); // not required under 2027

  // Switching to the 2022 standard re-checks the same month: contacts and the 10% target come back
  await page.getByLabel('When will you apply for certification?').selectOption('2022');
  await expect(page.locator('.ring', { hasText: 'Contacts' })).toHaveCount(1);
  await expect(page.locator('.ring', { hasText: 'Supervision (10%)' })).toHaveCount(1);
  await page.getByLabel('When will you apply for certification?').selectOption('2027');
  await expect(page.locator('.ring', { hasText: 'Supervision (7.5%)' })).toHaveCount(1);

  await expect(page.locator('.people').getByText(/Sign by|Due in|Past the BACB deadline/)).toBeVisible();
  await page.getByRole('button', { name: /^Sign Sep/ }).click();
  const sign = page.getByRole('button', { name: /for Lorinda Otto/ });
  await page.getByLabel('Type your full name to sign electronically').fill('Pat Traine');
  await expect(sign).toBeDisabled(); // must match your name
  await page.getByLabel('Type your full name to sign electronically').fill('pat trainee');
  await sign.click();
  await expect(page.getByText('waiting on supervisor')).toBeVisible();

  await supPage.goto('/supervise?month=2026-09');
  await expect(supPage.getByText('Ready for your signature')).toBeVisible();
  await supPage.getByRole('link', { name: 'Review' }).click();
  await supPage.getByRole('button', { name: /^Sign September/ }).click();
  await expect(supPage.getByText('The trainee completed the fieldwork in compliance')).toBeVisible(); // 2027 attestation
  await supPage.getByLabel('Type your full name to sign electronically').fill('Lorinda Otto');
  await supPage.getByRole('button', { name: 'Sign & lock month' }).click();
  await expect(supPage.getByText('✓ Signed', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText('✓ Signed & locked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

  // The prefilled official BACB form downloads, signed and locked
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'BACB form (PDF)' }).click()]);
  expect(file.suggestedFilename()).toBe('BACB monthly form 2026-09 Lorinda Otto.pdf');
  expect((await readFile(await file.path())).subarray(0, 5).toString()).toBe('%PDF-');

  // End of fieldwork: the supervisor signs the final form, totalled from the signed month
  await supPage.getByRole('button', { name: 'Sign final form…' }).click();
  await expect(supPage.getByText('I am the supervisor designated in the signed supervision contract')).toBeVisible();
  await supPage.getByLabel('Type your full name to sign electronically').fill('Lorinda Otto');
  await supPage.getByRole('button', { name: 'Sign final form', exact: true }).click();
  await expect(supPage.getByText(/✓ Signed .*Signing more months afterward/)).toBeVisible();
  await page.reload();
  await expect(page.getByText('✓ Final form signed')).toBeVisible();
  const [final] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Final form (PDF)' }).click()]);
  expect(final.suggestedFilename()).toBe('BACB final fieldwork verification Lorinda Otto.pdf');
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

test('each supervisor’s form is checked on its own', async ({ page }) => {
  const { trainee } = await seedPair();
  const second = await seedPair(); // borrow its supervisor
  await call(trainee, '/supervisions', 'POST', { inviteCode: second.inviteCode, startsOn: '2026-01-01' });
  const [a, b] = await call(trainee, '/supervisors');
  const put = (supervisorId: string, workDate: string, endTime: string) =>
    call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId, workDate, startTime: '08:00', endTime, kind: 'independent' });
  await put(a.id, '2026-09-01', '20:00');
  await put(a.id, '2026-09-02', '20:00'); // 24 h under A
  await put(b.id, '2026-09-03', '10:00'); // 2 h under B: below the 20 h minimum on B's form
  await signInAs(page, trainee, '/app?month=2026-09');
  const tabs = page.getByRole('radiogroup', { name: 'Verification form' }).getByRole('radio');
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).click();
  await expect(page.locator('.checklist li.no', { hasText: 'Minimum 20 hours' })).toHaveCount(1);
  await tabs.nth(0).click();
  await expect(page.locator('.checklist li.no', { hasText: 'Minimum 20 hours' })).toHaveCount(0);

  // Finish-by planner: next month is impossible for a whole program
  const ym = (add: number) => { const d = new Date(); d.setMonth(d.getMonth() + add, 1); return d.toLocaleDateString('en-CA').slice(0, 7) };
  await page.getByLabel('Want to finish by').fill(ym(1));
  await expect(page.getByText('not possible')).toBeVisible();
  await page.getByLabel('Want to finish by').fill(ym(40));
  await expect(page.getByText(/h\/week/)).toBeVisible();
});

test('Repeat copies an entry to today in one click', async ({ page }) => {
  const { trainee } = await seedPair();
  const [s] = await call(trainee, '/supervisors');
  const today = new Date().toLocaleDateString('en-CA');
  const earlier = `${today.slice(0, 7)}-01`;
  await call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId: s.id, workDate: earlier, startTime: '13:15', endTime: '16:45', kind: 'independent' });
  await signInAs(page, trainee, '/app');
  await page.getByRole('button', { name: 'Repeat' }).click();
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue(today);
  await expect(page.locator('input[type=time]').nth(0)).toHaveValue('13:15');
  await page.getByRole('button', { name: 'Save entry' }).click();
  await expect(page.locator('.sync')).toHaveText('✓ Synced');
  await expect(page.getByRole('button', { name: 'Repeat' })).toHaveCount(2);
});

test('supervisor leaves a review comment; trainee sees it and resolves it', async ({ browser }) => {
  const { sup, trainee } = await seedPair();
  const [s] = await call(trainee, '/supervisors');
  await call(trainee, `/entries/${crypto.randomUUID()}`, 'PUT', { supervisorId: s.id, workDate: '2026-09-04', startTime: '09:00', endTime: '11:00', kind: 'independent' });
  const supPage = await (await browser.newContext()).newPage();
  await signInAs(supPage, sup, '/supervise?month=2026-09');
  await supPage.getByRole('link', { name: 'Review' }).click();
  await supPage.getByRole('button', { name: 'Comment' }).click();
  await supPage.getByLabel('New comment').fill('End time should be 11:30');
  await supPage.getByRole('button', { name: 'Add comment' }).click();
  await expect(supPage.getByRole('button', { name: 'Comment (1)' })).toBeVisible();

  const page = await (await browser.newContext()).newPage();
  await signInAs(page, trainee, '/app?month=2026-09');
  await expect(page.getByText('End time should be 11:30')).toBeVisible(); // open comments always show
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('End time should be 11:30')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();
});
