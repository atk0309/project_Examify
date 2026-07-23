import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const OUTBOX = path.join(process.cwd(), 'tests', '.tmp', 'outbox');

async function readLatestOutboxFor(email: string, since: number): Promise<string | null> {
  const entries = await fs.readdir(OUTBOX).catch(() => []);
  for (const file of entries) {
    const fullPath = path.join(OUTBOX, file);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < since) continue;
    const raw = await fs.readFile(fullPath, 'utf8');
    const payload = JSON.parse(raw) as { to: string; html: string };
    if (payload.to === email) return payload.html;
  }
  return null;
}

async function pollOutbox(email: string, since: number, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const html = await readLatestOutboxFor(email, since);
    if (html) return html;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`outbox empty for ${email} after ${timeoutMs}ms`);
}

function extractSignInUrl(html: string): string {
  const match = html.match(/href="([^"]*\/signin\/verify\?token=[^"]+)"/);
  if (!match) throw new Error('no signin link in outbox email');
  return match[1]!.replace(/&amp;/g, '&');
}

async function submitSignin(page: import('@playwright/test').Page, email: string) {
  await page.goto('/signin');
  await page.getByTestId('signin-form').waitFor();
  await page.getByTestId('email-input').fill(email);
  await expect(page.getByTestId('signin-submit')).toBeEnabled();

  // The real widget injects this named input. If its CDN is unavailable in a
  // test runner, create the same field inside the widget container. Set every
  // matching field and submit in one browser task so React's pending-state
  // reconciliation cannot clear the value before FormData is captured.
  await page.getByTestId('signin-form').evaluate((node) => {
    const form = node as HTMLFormElement;
    let inputs = Array.from(
      form.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]'),
    );
    if (inputs.length === 0) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'cf-turnstile-response';
      form.querySelector('[data-testid="turnstile"]')?.append(input);
      inputs = [input];
    }
    for (const input of inputs) {
      input.defaultValue = 'test-bypass-token';
      input.value = 'test-bypass-token';
    }

    const submitter = form.querySelector<HTMLButtonElement>('[data-testid="signin-submit"]');
    if (submitter) form.requestSubmit(submitter);
    else form.requestSubmit();
  });
}

test('signin happy path sends a magic link and the link logs the user in', async ({ page }) => {
  const email = 'student@example.com';
  const startedAt = Date.now();
  await submitSignin(page, email);
  await expect(page.getByText('Check your inbox')).toBeVisible();

  const html = await pollOutbox(email, startedAt);
  const url = extractSignInUrl(html);
  expect(url).toContain('/signin/verify?token=');

  // Visit the magic link
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
});

test('signin rate-limits requests per IP', async ({ page }) => {
  // All sign-in requests share one per-IP 'signin' bucket regardless of email
  // (uniform threshold — no existing-user enumeration). Assumes the cap is set
  // low (RATE_LIMIT_SIGNIN_MAX) for the test run; the default is 10/hour.
  await page.setExtraHTTPHeaders({ 'x-real-ip': '198.51.100.42' });
  for (let i = 0; i < 3; i++) {
    await submitSignin(page, `rl-${i}-${Date.now()}@example.com`);
    await expect(page.getByText('Check your inbox')).toBeVisible();
  }
  await submitSignin(page, `rl-4-${Date.now()}@example.com`);
  await expect(page.getByTestId('signin-error-rate_limited')).toBeVisible();
});

test('signin rejects empty Turnstile token', async ({ page }) => {
  await page.goto('/signin');
  await page.getByTestId('signin-form').waitFor();
  await page.getByTestId('email-input').fill(`nocaptcha-${Date.now()}@example.com`);
  // No injected cf-turnstile-response → Zod rejects with reason='invalid'.
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('signin-error-invalid')).toBeVisible();
});
