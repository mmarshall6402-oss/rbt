import type { Page } from '@playwright/test';

const API = 'http://localhost:3000/api';
export const call = async (sub: string, path: string, method = 'GET', body?: unknown) =>
  (await fetch(API + path, { method, headers: { 'x-dev-sub': sub, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();

/** Fresh supervisor + linked concentrated trainee, created through the API. */
export async function seedPair(supervisorName = 'Lorinda Otto') {
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const sup = `sup${run}@e2e.test`, trainee = `trainee${run}@e2e.test`;
  const s = await call(sup, '/signup', 'POST', { role: 'supervisor', fullName: supervisorName, bacbId: '1-11-11111' });
  await call(trainee, '/signup', 'POST', { role: 'trainee', fullName: 'Pat Trainee', fieldworkType: 'concentrated' });
  await call(trainee, '/supervisions', 'POST', { inviteCode: s.inviteCode, startsOn: '2026-01-01' });
  return { sup, trainee, inviteCode: s.inviteCode as string };
}

export async function signInAs(page: Page, email: string, path: string) {
  await page.goto('/');
  await page.evaluate(e => localStorage.setItem('ft.devSub', e), email);
  await page.goto(path);
}

export async function logEntry(page: Page, date: string, start: string, end: string, kind: 'Independent' | 'Supervised' = 'Independent', contact?: 'contact' | 'observation') {
  await page.getByLabel('Date', { exact: true }).fill(date);
  await page.locator('input[type=time]').nth(0).fill(start);
  await page.locator('input[type=time]').nth(1).fill(end);
  await page.locator(`.seg button:has-text("${kind}")`).click();
  if (contact) await page.getByLabel('Contact type').selectOption(contact);
  await page.getByRole('button', { name: 'Save entry' }).click();
}
