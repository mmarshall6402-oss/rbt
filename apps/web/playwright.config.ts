import { defineConfig, devices } from '@playwright/test';

// Runs against the production build (service worker included) and a real API + Postgres.
// Needs E2E_DATABASE_URL pointing at a migrated database.
const db = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/fieldtrack';
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  webServer: [
    { command: 'pnpm --dir ../api exec tsx src/server.ts', url: 'http://localhost:3000/api/health', env: { AUTH_MODE: 'dev', DATABASE_URL: db, PORT: '3000' }, reuseExistingServer: !process.env.CI },
    { command: 'pnpm build && pnpm exec vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  ],
});
