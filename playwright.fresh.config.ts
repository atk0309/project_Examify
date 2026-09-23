import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { requireProductionBuild } from './tests/e2e/require-production-build';
import { FRESH_SPEC } from './tests/e2e/suites';

requireProductionBuild();

const PORT = Number(process.env.E2E_FRESH_PORT ?? 3101);
const baseURL = `http://127.0.0.1:${PORT}`;
const E2E_DB = path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh.db');
// Family data folder (uploads, wizard subjects, generated JSON). Always the
// suite's own folder under tests/.tmp, never a developer's EXAMIFY_DATA_DIR;
// `pnpm test:e2e:prepare:fresh` wipes it (E2E_DATA_DIR).
const E2E_DATA_DIR = path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh-data');
process.env.EXAMIFY_DATA_DIR = E2E_DATA_DIR;
const E2E_OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh-outbox');
process.env.MAIL_OUTBOX_DIR = E2E_OUTBOX;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: FRESH_SPEC,
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
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'production',
      PORT: String(PORT),
      SITE_URL: baseURL,
      DATABASE_URL: `file:${E2E_DB}`,
      EXAMIFY_DATA_DIR: E2E_DATA_DIR,
      AUTH_SECRET: 'e2e-secret-must-be-at-least-32-chars-long-yes',
      // Fresh suite expects /setup. A leftover host FAMILIES would import a
      // household on first request and skip the bootstrap screen.
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
      // Pin captcha off. Spreading process.env (or a host .env loaded by
      // next start) must not re-enable Turnstile — this suite asserts no widget.
      TURNSTILE_ENABLED: '',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: '',
      RATE_LIMIT_SIGNIN_MAX: '10',
      RATE_LIMIT_SIGNIN_WINDOW_MS: '60000',
      // Match the seeded suite: a spec can pick a rate-limit bucket with an
      // `x-real-ip` header, which the app ignores unless the host opts in.
      CLIENT_IP_HEADER: 'x-real-ip',
    },
  },
});
