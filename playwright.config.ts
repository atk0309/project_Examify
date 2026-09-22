import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { requireProductionBuild } from './tests/e2e/require-production-build';

requireProductionBuild();

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Use `127.0.0.1` rather than `localhost` so the Playwright healthcheck and
// the test browser always speak IPv4. On some runners `localhost` resolves
// to `::1` first while Next.js's `next start` binds to `0.0.0.0` (IPv4
// only); the result is a healthcheck that never connects and a Playwright
// webServer that times out despite the server actually being up.
const baseURL = `http://127.0.0.1:${PORT}`;

const E2E_DB = path.join(process.cwd(), 'tests', '.tmp', 'e2e.db');
const E2E_OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-outbox');
process.env.MAIL_OUTBOX_DIR = E2E_OUTBOX;

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: /fresh\.(spec|test)\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: { timeout: 5_000 },
  timeout: 30_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Note: no `globalSetup`. Playwright invokes globalSetup AFTER waiting for
  // `webServer.url` to return 2xx, and `/api/health` queries the DB — so
  // DB-state initialisation has to run *before* the webServer starts. That
  // lives in `tests/e2e/setup-db.ts`, run from `pnpm test:e2e:prepare`.
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
    // IMPORTANT: spread process.env first. Playwright passes `env` as the
    // full child-process environment — without inheriting PATH, `pnpm exec`
    // can't find pnpm in CI.
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'production',
      PORT: String(PORT),
      SITE_URL: baseURL,
      DATABASE_URL: `file:${E2E_DB}`,
      AUTH_SECRET: 'e2e-secret-must-be-at-least-32-chars-long-yes',
      // Pin empty so a leftover host FAMILIES cannot auto-import into the
      // prepared DB (seeded suite already has a household; still isolate).
      FAMILIES: '',
      RESEND_API_KEY: 'test',
      ALLOW_LOCAL_OUTBOX: '1',
      RESEND_FROM: 'WhatATime <test@example.com>',
      MAIL_OUTBOX_DIR: E2E_OUTBOX,
      ANTHROPIC_API_KEY: 'test',
      // next start runs NODE_ENV=production, where the `test` sentinel no
      // longer stubs grading unless this explicit opt-in is set.
      GRADING_STUB: '1',
      SETUP_BOOTSTRAP_SECRET: 'e2e-setup-bootstrap-secret',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      TURNSTILE_ENABLED: '1',
      RATE_LIMIT_SIGNIN_MAX: '3',
      RATE_LIMIT_SIGNIN_WINDOW_MS: '60000',
      // Specs pick a rate-limit bucket with an `x-real-ip` header. The app
      // ignores that header unless the host opts in (default is the last
      // X-Forwarded-For hop), so opt in here — there is no proxy in front.
      CLIENT_IP_HEADER: 'x-real-ip',
    },
  },
});
