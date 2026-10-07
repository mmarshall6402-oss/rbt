import { readFileSync } from 'node:fs';
import { Signer } from '@aws-sdk/rds-signer';
import type { PoolConfig } from 'pg';

/**
 * DATABASE_URL for local/dev/CI. In AWS the pieces come from ECS (credentials from Secrets Manager)
 * and TLS is verified against the RDS certificate bundle baked into the image.
 */
export function databaseUrl(env = process.env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST, DB_PORT = '5432', DB_NAME = 'fieldtrack', DB_USER, DB_PASSWORD, DB_SSLROOTCERT } = env;
  if (!DB_HOST || !DB_USER || !DB_PASSWORD) throw new Error('Set DATABASE_URL, or DB_HOST, DB_USER and DB_PASSWORD');
  const tls = DB_SSLROOTCERT ? `?sslmode=verify-full&sslrootcert=${encodeURIComponent(DB_SSLROOTCERT)}` : '?sslmode=require';
  return `postgres://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}${tls}`;
}

/**
 * Connection for the API server. With DB_IAM_AUTH=true (AWS) it signs in as its least-privilege login
 * with a fresh 15-minute IAM token per connection, over TLS verified against the RDS CA. No password exists.
 */
export function apiPoolConfig(env = process.env): PoolConfig {
  if (env.DB_IAM_AUTH !== 'true') return { connectionString: databaseUrl(env) };
  const { DB_HOST, DB_PORT = '5432', DB_NAME = 'fieldtrack', DB_USER, DB_SSLROOTCERT } = env;
  if (!DB_HOST || !DB_USER || !DB_SSLROOTCERT) throw new Error('DB_IAM_AUTH needs DB_HOST, DB_USER and DB_SSLROOTCERT');
  const signer = new Signer({ hostname: DB_HOST, port: Number(DB_PORT), username: DB_USER });
  return {
    host: DB_HOST, port: Number(DB_PORT), database: DB_NAME, user: DB_USER,
    password: () => signer.getAuthToken(),
    ssl: { ca: readFileSync(DB_SSLROOTCERT, 'utf8'), rejectUnauthorized: true },
  };
}
