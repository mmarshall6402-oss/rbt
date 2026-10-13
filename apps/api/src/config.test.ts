import { describe, expect, it } from 'vitest';
import { apiPoolConfig, databaseUrl } from './config.js';

describe('databaseUrl', () => {
  it('prefers DATABASE_URL', () => expect(databaseUrl({ DATABASE_URL: 'postgres://x' })).toBe('postgres://x'));
  it('builds a verified-TLS URL from ECS pieces, escaping the password', () =>
    expect(databaseUrl({ DB_HOST: 'db.aws', DB_USER: 'app', DB_PASSWORD: 'p@ss/w:rd', DB_SSLROOTCERT: '/app/rds-ca.pem' }))
      .toBe('postgres://app:p%40ss%2Fw%3Ard@db.aws:5432/fieldtrack?sslmode=verify-full&sslrootcert=%2Fapp%2Frds-ca.pem'));
  it('fails loudly when misconfigured', () => expect(() => databaseUrl({})).toThrow(/DATABASE_URL/));
});

describe('apiPoolConfig', () => {
  it('uses DATABASE_URL unless IAM auth is on', () => expect(apiPoolConfig({ DATABASE_URL: 'postgres://x' })).toEqual({ connectionString: 'postgres://x' }));
  it('signs in with an IAM token over verified TLS, never a static password', async () => {
    const c = apiPoolConfig({ DB_IAM_AUTH: 'true', DB_HOST: 'db.example.us-east-1.rds.amazonaws.com', DB_USER: 'fieldtrack_api', DB_SSLROOTCERT: new URL('../package.json', import.meta.url).pathname, AWS_REGION: 'us-east-1' });
    expect(c).toMatchObject({ user: 'fieldtrack_api', ssl: { rejectUnauthorized: true } });
    expect(typeof c.password).toBe('function');
  });
  it('refuses IAM auth without a CA bundle', () => expect(() => apiPoolConfig({ DB_IAM_AUTH: 'true', DB_HOST: 'h', DB_USER: 'u' })).toThrow(/SSLROOTCERT/));
});
