import path from 'node:path';
import { defineConfig } from '@playwright/test';
const root = process.cwd();
const baseURL = 'http://127.0.0.1:3115';
const live = process.env.DEMO_MODE === 'live';
export default defineConfig({
  testDir: '.',
  testMatch: 'walkthrough.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 360_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  outputDir: 'demo-recording/output',
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    video: { mode: 'on', size: { width: 1440, height: 1000 } },
    trace: 'off',
    screenshot: 'off',
    launchOptions: { slowMo: 350 },
  },
  webServer: {
    command:
      'node --import ./demo-recording/budget-preload.mjs node_modules/next/dist/bin/next start --port 3115',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      NODE_ENV: 'production',
      SITE_URL: baseURL,
      DATABASE_URL: 'file:./tests/.tmp/demo.db',
      EXAMIFY_DATA_DIR: 'tests/.tmp/demo-data',
      AUTH_SECRET: 'synthetic-demo-only-not-a-production-auth-secret',
      SETUP_BOOTSTRAP_SECRET: 'synthetic-demo-bootstrap',
      AUTH_MODE: 'password',
      FAMILIES: '',
      RESEND_API_KEY: 'test',
      ALLOW_LOCAL_OUTBOX: '1',
      RESEND_FROM: 'Demo <demo@example.com>',
      MAIL_OUTBOX_DIR: 'tests/.tmp/demo-outbox',
      DEMO_MODE: live ? 'live' : 'stub',
      DEMO_BUDGET_DIR: path.join(root, 'tests/.tmp/demo-budget'),
      ANTHROPIC_API_KEY: live ? (process.env.ANTHROPIC_API_KEY ?? '') : 'test',
      OPENAI_API_KEY: live ? (process.env.OPENAI_API_KEY ?? '') : '',
      GRADING_STUB: live ? '' : '1',
      EXAMIFY_CLAUDE_BIN: path.join(root, 'tests/.tmp/no-cli/claude'),
      EXAMIFY_CODEX_BIN: path.join(root, 'tests/.tmp/no-cli/codex'),
      TURNSTILE_ENABLED: '',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: '',
    },
  },
});
