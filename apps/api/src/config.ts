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
