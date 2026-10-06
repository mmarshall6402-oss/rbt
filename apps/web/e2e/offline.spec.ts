import { expect, test } from '@playwright/test';
import { call, logEntry, seedPair, signInAs } from './helpers';

test('offline-first: instant save, survives offline reload, syncs once, retries without duplicates', async ({ page, context }) => {
  const { trainee } = await seedPair();
  const serverCount = async () => (await call(trainee, '/entries?month=2026-10')).length;
  await signInAs(page, trainee, '/app?month=2026-10');
  await expect(page.getByRole('heading', { name: 'Log hours' })).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForTimeout(1500); // first visit: let the service worker finish caching the app shell

  const hours = page.locator('.ring', { hasText: 'Hours this month' }).locator('.ring-value');
  await logEntry(page, '2026-10-05', '08:00', '10:00');
  await expect.poll(serverCount).toBe(1);

  await context.setOffline(true);
  await logEntry(page, '2026-10-05', '11:00', '14:00');
  await expect(hours).toHaveText('5.00'); // rings update instantly from the shared rules engine
  await expect(page.locator('.sync')).toHaveText('☁ Saved on this device · 1 waiting');

  await page.waitForTimeout(1000);
  await page.reload(); // app shell from the service worker, data from IndexedDB
  await expect(hours).toHaveText('5.00');
  await expect(page.locator('td [title^="Saved on this device"]')).toHaveCount(1);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.sync')).toHaveText('✓ Synced', { timeout: 15_000 });
  expect(await serverCount()).toBe(2);

  // The server saves the upload but the response is lost; the client retries the same UUID.
  let dropped = false;
  await page.route('**/api/entries/*', async route => {
    if (route.request().method() === 'PUT' && !dropped) { dropped = true; await route.fetch(); return route.abort('connectionreset'); }
    return route.continue();
  });
  await logEntry(page, '2026-10-05', '15:00', '16:00');
  await expect(page.locator('.sync')).toHaveText('✓ Synced', { timeout: 20_000 });
  expect(dropped).toBe(true);
  expect(await serverCount()).toBe(3); // not 4

  // Sign-out wipes unsent and cached data from the device
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('/');
  const outbox = await page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('fieldtrack-sync');
    r.onsuccess = () => { const g = r.result.transaction('outbox').objectStore('outbox').get('queue'); g.onsuccess = () => res(g.result ?? null) };
  }));
  expect(outbox).toBeNull();
});
