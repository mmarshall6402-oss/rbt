import { describe, expect, it } from 'vitest';
import { databaseUrl } from './config.js';

describe('databaseUrl', () => {
  it('prefers DATABASE_URL', () => expect(databaseUrl({ DATABASE_URL: 'postgres://x' })).toBe('postgres://x'));
  it('builds a verified-TLS URL from ECS pieces, escaping the password', () =>
    expect(databaseUrl({ DB_HOST: 'db.aws', DB_USER: 'app', DB_PASSWORD: 'p@ss/w:rd', DB_SSLROOTCERT: '/app/rds-ca.pem' }))
      .toBe('postgres://app:p%40ss%2Fw%3Ard@db.aws:5432/fieldtrack?sslmode=verify-full&sslrootcert=%2Fapp%2Frds-ca.pem'));
  it('fails loudly when misconfigured', () => expect(() => databaseUrl({})).toThrow(/DATABASE_URL/));
});
