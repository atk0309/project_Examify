import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_FRESH_PORT ?? 3101);
const baseURL = `http://127.0.0.1:${PORT}`;
const E2E_DB = path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh.db');
const E2E_OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh-outbox');
process.env.MAIL_OUTBOX_DIR = E2E_OUTBOX;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /fresh\.(spec|test)\.ts/,
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
      AUTH_SECRET: 'e2e-secret-must-be-at-least-32-chars-long-yes',
      RESEND_API_KEY: 'test',
      RESEND_FROM: 'WhatATime <test@example.com>',
      MAIL_OUTBOX_DIR: E2E_OUTBOX,
      ANTHROPIC_API_KEY: 'test',
      SETUP_BOOTSTRAP_SECRET: 'e2e-setup-bootstrap-secret',
      RATE_LIMIT_SIGNIN_MAX: '10',
      RATE_LIMIT_SIGNIN_WINDOW_MS: '60000',
    },
  },
});
