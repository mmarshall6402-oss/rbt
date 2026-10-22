import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { devVerify } from './auth.js';
import { createDb } from './db.js';
import { siteFromEnv } from './site.js';

// No database needed: these requests never reach a query.
const web = mkdtempSync(join(tmpdir(), 'web-'));
writeFileSync(join(web, 'index.html'), '<!doctype html><title>Fieldtrack</title>');
mkdirSync(join(web, 'assets'));
writeFileSync(join(web, 'assets', 'app-abc123.js'), 'console.log(1)');
copyFileSync(new URL('../../web/security-headers.json', import.meta.url), join(web, 'security-headers.json'));
const password = 'correct horse battery';
const app = buildApp({ db: createDb('postgres://invalid'), verify: devVerify(), logger: false, site: { password, webDir: web } });
const basic = (p: string) => ({ authorization: `Basic ${Buffer.from(`anyone:${p}`).toString('base64')}` });

describe('site mode (shared password, serves the web app)', () => {
  it('needs a long password and only turns on with AUTH_MODE=site', () => {
    expect(siteFromEnv({})).toBeUndefined();
    expect(() => siteFromEnv({ AUTH_MODE: 'site', SITE_PASSWORD: 'short' })).toThrow(/12 characters/);
    expect(siteFromEnv({ AUTH_MODE: 'site', SITE_PASSWORD: password, WEB_DIR: web })).toEqual({ password, webDir: web });
  });

  it('asks for the password on every page and API route', async () => {
    for (const url of ['/', '/app', '/assets/app-abc123.js', '/api/me']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic /);
    }
    expect((await app.inject({ url: '/', headers: basic('wrong password!!') })).statusCode).toBe(401);
  });

  it('serves the app shell for client routes, assets with long caching, and keeps API 404s as JSON', async () => {
    const page = await app.inject({ url: '/supervise/123', headers: basic(password) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Fieldtrack</title>');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    const asset = await app.inject({ url: '/assets/app-abc123.js', headers: basic(password) });
    expect(asset.headers['cache-control']).toContain('immutable');
    const missing = await app.inject({ url: '/api/nope', headers: basic(password) });
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: 'Not found' }]);
  });

  it('leaves the health check open for the host', async () => {
    expect((await app.inject({ url: '/api/health' })).statusCode).not.toBe(401);
  });
});
