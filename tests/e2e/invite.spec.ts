import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const OUTBOX = path.join(process.cwd(), 'tests', '.tmp', 'outbox');

async function pollOutbox(email: string, since: number, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(OUTBOX).catch(() => []);
    for (const file of entries) {
      const fullPath = path.join(OUTBOX, file);
      const stat = await fs.stat(fullPath);
      if (stat.mtimeMs < since) continue;
      const raw = await fs.readFile(fullPath, 'utf8');
      const payload = JSON.parse(raw) as { to: string; html: string };
      if (payload.to === email) return payload.html;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`outbox empty for ${email} after ${timeoutMs}ms`);
}

function extractSignInUrl(html: string): string {
  const match = html.match(/href="([^"]*\/signin\/verify\?token=[^"]+)"/);
  if (!match) throw new Error('no signin link in outbox email');
  return match[1]!.replace(/&amp;/g, '&');
}

async function submitSignin(
  page: import('@playwright/test').Page,
  email: string,
  role: 'Student' | 'Parent',
) {
  await page.goto('/signin');
  await page.getByTestId('signin-form').waitFor();
  await page.getByRole('radio', { name: role }).click();
  await page.getByTestId('email-input').fill(email);
  await expect(page.getByTestId('signin-submit')).toBeEnabled();
  const hasTurnstile = (await page.getByTestId('turnstile').count()) > 0;
  if (hasTurnstile) {
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
      form.requestSubmit();
    });
  } else {
    await page.getByTestId('signin-submit').click();
  }
}

test('parent can create an invite that a new student accepts', async ({ page }) => {
  const startedAt = Date.now();
  await submitSignin(page, 'parent@example.com', 'Parent');
  await expect(page.getByText('Check your inbox')).toBeVisible();
  const html = await pollOutbox('parent@example.com', startedAt);
  await page.goto(extractSignInUrl(html));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('household-invites')).toBeVisible();

  await page.getByTestId('create-invite').click();
  await expect(page.getByTestId('invite-created')).toBeVisible();
  const inviteUrl = await page.getByTestId('invite-url').inputValue();
  expect(inviteUrl).toContain('/invite/');

  await page
    .locator('form[action] button[aria-label="Sign out"], button[aria-label="Sign out"]')
    .first()
    .click();
  await expect(page).toHaveURL(/\/signin/);

  const joinStarted = Date.now();
  await page.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, ''));
  await page.getByTestId('invite-form').waitFor();
  await page.getByTestId('invite-email-input').fill('newkid@example.com');
  if ((await page.getByTestId('turnstile').count()) > 0) {
    await page.getByTestId('invite-form').evaluate((node) => {
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
      form.requestSubmit();
    });
  } else {
    await page.getByTestId('invite-submit').click();
  }
  await expect(page.getByText('Check your inbox')).toBeVisible();

  const kidHtml = await pollOutbox('newkid@example.com', joinStarted);
  await page.goto(extractSignInUrl(kidHtml));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: /Pick a subject to practise/i })).toBeVisible();
});
