import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

/** Real packaged app acceptance; no provider calls, credentials or capability logging. */
export async function verifyBrowser({ origin, browserUrl, reopen }) {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const requests = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => requests.push(request.url()));

    // Public local route is a useful recovery page, not household setup.
    const response = await page.goto(`${origin}/solo/start`);
    assert.equal(response?.status(), 200);
    await expect(page).toHaveTitle(/Open your learning space/);
    await expect(page.getByRole('status')).toContainText('Open Examify from its launcher');
    await page.goto(browserUrl);
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.getByRole('heading', { name: 'Pick a subject to practise.' })).toBeVisible();
    assert.equal(new URL(page.url()).hash, '');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Create your question bank' })).toBeVisible();

    // Sample paper uses existing own-user persistence and local MCQ scoring.
    await page.getByTestId('solo-quick-start').click();
    // CSS uppercases innerText; assert source text and the fixture's exact size.
    await expect(page.getByTestId('exam-progress')).toHaveText('Question 1 of 5');
    const total = 5;
    for (let index = 1; index <= total; index += 1) {
      await expect(page.getByTestId('exam-progress')).toContainText(
        `Question ${index} of ${total}`,
      );
      await expect(page.getByTestId('exam-free-answer')).toHaveCount(0);
      await page.getByTestId('exam-choice').first().click();
      await page.getByTestId('exam-next').click();
    }
    await expect(page.getByTestId('results-score')).toBeVisible();
    await page.getByTestId('results-home').click();
    await expect(page.getByTestId('progress-link')).toContainText('1 done');
    await page.reload();
    await expect(page.getByTestId('progress-link')).toContainText('1 done');

    // Link crawl stays in the authorized local app, with no login ceremony.
    for (const href of ['/onboarding', '/settings/ai']) {
      const linked = await page.goto(origin + href);
      assert.equal(linked?.status(), 200);
      assert.equal(new URL(page.url()).pathname, href);
      await expect(
        page.getByTestId(href === '/onboarding' ? 'wizard-welcome' : 'ai-settings'),
      ).toBeVisible();
    }
    for (const alias of ['/signin', '/%73ignin', '/setup']) {
      await page.goto(origin + alias);
      await expect(page).toHaveURL(`${origin}/`);
    }

    // Browser-cookie loss has a working launcher recovery, and earlier tokens
    // stay consumed even after another browser capability has been redeemed.
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    const nextUrl = await reopen();
    assert.equal(new URL(nextUrl).origin, origin);
    await freshPage.goto(nextUrl);
    await expect(freshPage).toHaveURL(`${origin}/`);
    await expect(freshPage.getByTestId('progress-link')).toContainText('1 done');
    const replay = await freshContext.request.post(`${origin}/api/solo/session`, {
      headers: { Origin: origin },
      data: { token: new URL(browserUrl).hash.slice(1) },
    });
    assert.equal(replay.status(), 409, 'Previously consumed capability must remain rejected');
    assert.deepEqual(errors, [], 'No browser exceptions');
    assert.ok(
      requests.every((url) => new URL(url).origin === origin),
      'Solo must not fetch third-party scripts/fonts/providers',
    );
    assert.ok(
      requests.every((url) => !/[a-f0-9]{64}\.[a-f0-9]{64}/.test(url)),
      'Launch capability must never enter a network URL',
    );
  } catch (error) {
    // Playwright failures can include the navigation URL. Never emit fragments.
    const message = error instanceof Error ? error.message : 'Browser acceptance failed';
    throw new Error(
      message
        .replace(/#[^\s"')]+/g, '#[redacted]')
        .replace(/[a-f0-9]{64}\.[a-f0-9]{64}/g, '[redacted capability]'),
    );
  } finally {
    await browser.close();
  }
}
