# Database

- `migrations/` — applied in filename order by `pnpm db:migrate` (`apps/api/src/migrate.ts`). Each file runs in one transaction with a 5 s lock timeout, so a migration fails fast instead of blocking live traffic.
- `migrations/.frozen` — migrations that have run in production, one filename per line. CI fails if a frozen file changes; write a new migration instead. Add files here after each production deploy.
- `seed/sample.sql` — realistic data CI loads onto `main`'s schema before applying a PR's new migrations.
- `docker-init/` — local Docker only (creates the test database).
