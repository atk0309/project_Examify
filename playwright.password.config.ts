import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { requireProductionBuild } from './tests/e2e/require-production-build';
import { PASSWORD_SPEC } from './tests/e2e/suites';

requireProductionBuild();

// AUTH_MODE=password — the `install.sh` default — against a seeded household
// with known passwords (`pnpm test:e2e:prepare:password`). Also the suite that
// takes a real exam end to end (MCQ + free-text, results, resume, progress).
const PORT = Number(process.env.E2E_PASSWORD_PORT ?? 3102);
const baseURL = `http://127.0.0.1:${PORT}`;
const E2E_DB = path.join(process.cwd(), 'tests', '.tmp', 'e2e-password.db');
// Family data folder (uploads, wizard subjects, generated JSON). Always the
// suite's own folder under tests/.tmp, never a developer's EXAMIFY_DATA_DIR;
// `pnpm test:e2e:prepare:password` wipes it (E2E_DATA_DIR).
const E2E_DATA_DIR = path.join(process.cwd(), 'tests', '.tmp', 'e2e-password-data');
process.env.EXAMIFY_DATA_DIR = E2E_DATA_DIR;
const E2E_OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-password-outbox');
process.env.MAIL_OUTBOX_DIR = E2E_OUTBOX;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: PASSWORD_SPEC,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: { timeout: 5_000 },
  timeout: 60_000,
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
      AUTH_MODE: 'password',
      // The seed already has the household. A leftover host FAMILIES must not
      // import a second one into the prepared DB.
      FAMILIES: '',
      // Password sign-in needs no mail; invite accept / reset would use the
      // local outbox. Pin it so a host SMTP_HOST / Resend key is never used.
      MAIL_TRANSPORT: 'outbox',
      ALLOW_LOCAL_OUTBOX: '1',
      MAIL_OUTBOX_DIR: E2E_OUTBOX,
      // Deterministic free-text grading stub, no network. Production only
      // stubs with both the `test` sentinel and the explicit GRADING_STUB=1.
      ANTHROPIC_API_KEY: 'test',
      GRADING_STUB: '1',
      // Never the developer's own Claude Code / Codex: the wizard asks a found
      // CLI whether it is signed in. No spec needs one.
      EXAMIFY_CLAUDE_BIN: path.join(process.cwd(), 'tests', '.tmp', 'no-agent-cli', 'claude'),
      EXAMIFY_CODEX_BIN: path.join(process.cwd(), 'tests', '.tmp', 'no-agent-cli', 'codex'),
      SETUP_BOOTSTRAP_SECRET: 'e2e-setup-bootstrap-secret',
      // Pin captcha off (as `install.sh` leaves it). Spreading process.env
      // (or a host .env loaded by next start) must not re-enable Turnstile.
      TURNSTILE_ENABLED: '',
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: '',
      // Several sign-ins per run (plus a CI retry) share the one per-IP bucket.
      RATE_LIMIT_SIGNIN_MAX: '100',
      RATE_LIMIT_SIGNIN_WINDOW_MS: '60000',
    },
  },
});
