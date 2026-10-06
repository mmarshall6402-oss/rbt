import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from './config.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../../db/migrations/', import.meta.url));
const LOCK_ID = 727274; // advisory lock: two deploys never migrate at once

/**
 * Applies db/migrations/*.sql in filename order, each in its own transaction.
 * lock_timeout makes a migration fail fast instead of queueing behind live traffic and blocking it.
 */
export async function migrate(connectionString: string, dir = DEFAULT_DIR, log: (msg: string) => void = () => {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map(r => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('begin');
      try {
        await client.query("set local lock_timeout = '5s'; set local statement_timeout = '5min'");
        await client.query(readFileSync(`${dir}/${file}`, 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const applied = await migrate(databaseUrl(), process.env.MIGRATIONS_DIR ?? DEFAULT_DIR, console.log);
  console.log(applied.length ? `${applied.length} migration(s) applied` : 'Database is up to date');
}
