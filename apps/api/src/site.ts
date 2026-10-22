import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Single-service hosting without Cognito (e.g. a free test deploy): one shared site password guards
 * everything, and the API also serves the built web app. Identity inside is the dev header, so anyone
 * with the password can act as any account: for a small private test with no client data only.
 */
export interface SiteOptions { password: string; webDir: string }

export function siteFromEnv(env = process.env): SiteOptions | undefined {
  if (env.AUTH_MODE !== 'site') return undefined;
  const password = env.SITE_PASSWORD ?? '';
  if (password.length < 12) throw new Error('AUTH_MODE=site needs SITE_PASSWORD of at least 12 characters');
  return { password, webDir: env.WEB_DIR ?? '/app/web' };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Call before any routes are added: Fastify applies hooks to routes registered after them. */
export function registerSite(app: FastifyInstance, { password, webDir }: SiteOptions) {
  const expected = digest(password);
  // Browser Basic auth: the browser asks once, then sends it with every same-origin request (including the app's API calls).
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/api/health') return; // the host's health check
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    const given = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':').slice(1).join(':') : '';
    if (!timingSafeEqual(digest(given), expected)) {
      return reply.code(401).header('www-authenticate', 'Basic realm="Fieldtrack", charset="UTF-8"').send({ error: 'Site password required' });
    }
  });

  // Same security headers CloudFront sends in AWS (apps/web/security-headers.json).
  const h = JSON.parse(readFileSync(join(webDir, 'security-headers.json'), 'utf8')) as { csp: string[]; referrerPolicy: string; permissionsPolicy: string };
  const csp = h.csp.join('; ').replace(' {connect}', '').replace(' {auth}', '');
  app.addHook('onSend', async (req, reply) => {
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains').header('x-content-type-options', 'nosniff');
    if (req.url.startsWith('/api/')) return;
    reply.header('content-security-policy', csp).header('x-frame-options', 'DENY')
      .header('referrer-policy', h.referrerPolicy).header('permissions-policy', h.permissionsPolicy);
  });

  if (!existsSync(join(webDir, 'index.html'))) throw new Error(`No web build at ${webDir}`);
  void app.register(fastifyStatic, {
    root: webDir, wildcard: false, index: false, cacheControl: false,
    setHeaders: (res, path) => res.setHeader('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  // Client-side routes (/app, /supervise/...) get the app shell; unknown API paths stay JSON 404s.
  app.setNotFoundHandler((req, reply) =>
    req.method === 'GET' && !req.url.startsWith('/api/') ? reply.header('cache-control', 'no-cache').sendFile('index.html') : reply.code(404).send({ error: 'Not found' }));
}
