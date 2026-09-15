import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh-outbox');

test.describe.configure({ mode: 'serial' });

test('first-run bootstrap creates the admin without Turnstile', async ({ page }) => {
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByTestId('setup-form')).toBeVisible();
  await expect(page.getByTestId('turnstile')).toHaveCount(0);

  await page.getByTestId('household-name-input').fill('Fresh family');
  await page.getByTestId('setup-email-input').fill('host@example.com');
  await page.getByTestId('setup-secret-input').fill('e2e-setup-bootstrap-secret');
  await page.getByTestId('setup-submit').click();
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByTestId('onboarding-wizard')).toBeVisible();
  await expect(page.getByTestId('wizard-welcome')).toBeVisible();
  await page.getByTestId('wizard-skip').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('finish-content-setup')).toBeVisible();
  await expect(page.getByTestId('household-invites')).toBeVisible();
});

test('unknown emails still show Check your inbox and send nothing', async ({ page }) => {
  const before = await fs.readdir(OUTBOX).catch(() => []);
  await page.goto('/signin');
  await page.getByTestId('signin-form').waitFor();
  await expect(page.getByTestId('turnstile')).toHaveCount(0);
  await page.getByTestId('email-input').fill('ghost@example.com');
  await page.getByTestId('signin-submit').click();
  await expect(page.getByText('Check your inbox')).toBeVisible();
  const after = await fs.readdir(OUTBOX).catch(() => []);
  expect(after.length).toBe(before.length);
});

test('household admin can sign in again without a captcha widget', async ({ page }) => {
  const startedAt = Date.now();
  await page.goto('/signin');
  await page.getByRole('radio', { name: 'Parent' }).click();
  await page.getByTestId('email-input').fill('host@example.com');
  await page.getByTestId('signin-submit').click();
  await expect(page.getByText('Check your inbox')).toBeVisible();

  const deadline = Date.now() + 5_000;
  let html: string | null = null;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(OUTBOX).catch(() => []);
    for (const file of entries) {
      const fullPath = path.join(OUTBOX, file);
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < startedAt) continue;
      const raw = await fs.readFile(fullPath, 'utf8');
      const payload = JSON.parse(raw) as { to: string; html: string };
      if (payload.to === 'host@example.com') {
        html = payload.html;
        break;
      }
    }
    if (html) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(html, 'expected a magic-link email for the admin').toBeTruthy();
  const match = html!.match(/href="([^"]*\/signin\/verify\?token=[^"]+)"/);
  expect(match).toBeTruthy();
  await page.goto(match![1]!.replace(/&amp;/g, '&'));
  await expect(page).toHaveURL(/\/$/);
});
