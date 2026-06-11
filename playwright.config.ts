import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Use `127.0.0.1` rather than `localhost` so the Playwright healthcheck and
// the test browser always speak IPv4. On some runners `localhost` resolves
// to `::1` first while Next.js's `next start` binds to `0.0.0.0` (IPv4
// only); the result is a healthcheck that never connects and a Playwright
// webServer that times out despite the server actually being up.
const baseURL = `http://127.0.0.1:${PORT}`;

const E2E_DB = path.join(process.cwd(), 'tests', '.tmp', 'e2e.db');

export default defineConfig({
  testDir: './tests/e2e',
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
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'e2e-admin-password-CorrectHorse42',
      RESEND_API_KEY: 'test',
      RESEND_FROM: 'WhatATime <test@example.com>',
      ANTHROPIC_API_KEY: 'test',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      RATE_LIMIT_SIGNUP_MAX: '3',
      RATE_LIMIT_SIGNUP_WINDOW_MS: '60000',
      RATE_LIMIT_LOGIN_MAX: '5',
      RATE_LIMIT_LOGIN_WINDOW_MS: '60000',
      RATE_LIMIT_ADMIN_MAX: '20',
      RATE_LIMIT_ADMIN_WINDOW_MS: '60000',
    },
  },
});
