import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { FIXTURE_MODEL, FIXTURE_SUBJECTS, startFixtureProvider } from './fixture-http-provider.mjs';

async function openContent(page) {
  await page.getByRole('link', { name: 'Create your question bank' }).click();
  await expect(page.getByTestId('wizard-welcome')).toBeVisible();
  await page.getByTestId('wizard-get-started').click();
  await expect(page.getByTestId('wizard-subjects')).toBeVisible();
}

async function configureLocalProvider(page, provider) {
  await page.getByTestId('wizard-configure-local').click();
  await expect(page.getByTestId('ai-settings')).toBeVisible();
  await page.getByTestId('ai-settings-mode').selectOption('local-agent');
  await page.getByTestId('ai-settings-save').click();
  await expect(page.getByTestId('ai-settings-status')).toContainText(
    'Saved provider: Local endpoint',
  );
  const model = page.getByTestId('ai-settings-config-EXAMIFY_LLM_MODEL');
  await model.getByRole('textbox').fill(FIXTURE_MODEL);
  await model.getByRole('button', { name: 'Save model', exact: true }).click();
  await expect(model).toContainText('Configured (value hidden)');
  const endpoint = page.getByTestId('ai-settings-config-EXAMIFY_LLM_BASE_URL');
  await endpoint.getByRole('textbox').fill(provider.origin + '/v1');
  await endpoint.getByRole('button', { name: 'Save local endpoint url', exact: true }).click();
  await expect(endpoint).toContainText('Configured (value hidden)');
  await page.reload();
  await expect(page.getByTestId('ai-settings-mode')).toHaveValue('local-agent');
  await expect(endpoint).toContainText('Configured (value hidden)');
  await page.getByRole('link', { name: 'Back to dashboard', exact: true }).first().click();
  await openContent(page);
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
}

/** Real mutations and real local HTTP provider; no route/action/persistence interception. */
async function authorAndStudy(page, provider, fixture, index, origin) {
  await openContent(page);
  if (!(await page.getByTestId('wizard-add-subject').count())) {
    await page.getByRole('button', { name: 'Add a subject', exact: true }).click();
  }
  await page.getByTestId('wizard-subject-label').fill(fixture.label);
  await expect(page.getByTestId('wizard-subject-id')).toHaveValue(fixture.id);
  await page.getByTestId('wizard-add-subject-submit').click();
  await expect(page.getByTestId('wizard-subjects')).toContainText(fixture.label);
  await page.getByTestId('wizard-next').click();
  if (index > 0) await page.getByTestId(`wizard-file-tab-${fixture.id}`).click();
  await page.getByTestId(`wizard-file-${fixture.id}`).setInputFiles({
    name: fixture.filename,
    mimeType: fixture.filename.endsWith('.md') ? 'text/markdown' : 'text/plain',
    buffer: Buffer.from(fixture.text, 'utf8'),
  });
  await expect(page.getByTestId(`wizard-file-sources-${fixture.id}`)).toContainText(
    fixture.filename,
  );
  await expect(page.getByTestId(`wizard-detach-${fixture.id}-${fixture.filename}`)).toBeVisible();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-ai-local-agent').click();
  if (index === 0) await configureLocalProvider(page, provider);
  await expect(page.getByTestId('wizard-ai-local-agent')).toContainText('Configured');
  await page.getByTestId(`wizard-generate-${fixture.id}`).click();
  await expect(page.getByTestId(`wizard-generate-run-${fixture.id}`)).toBeVisible({
    timeout: 30000,
  });
  assert.equal(
    provider.calls.at(-1),
    fixture.id,
    'Real generate delivered the uploaded notes to the offline endpoint',
  );
  await page.getByTestId('wizard-generate-to-validate').click();
  await page.getByTestId('wizard-validate').click();
  await expect(page.getByTestId('wizard-validate-ok')).toBeVisible();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-preview').click();
  await expect(page.getByTestId('wizard-dry-run-summary')).toBeVisible();
  await page.getByTestId('wizard-to-apply').click();
  await page.getByTestId('wizard-apply-confirm').click();
  await expect(page.getByTestId('wizard-applied')).toBeVisible();
  await page.getByTestId('wizard-to-ready').click();
  await expect(page.getByTestId(`wizard-ready-subject-${fixture.id}`)).toBeVisible();
  await page.getByTestId('wizard-finish').click();
  await expect(page).toHaveURL(`${origin}/`);
  for (const prior of FIXTURE_SUBJECTS.slice(0, index + 1)) {
    await expect(page.getByTestId(`subject-card-${prior.id}`)).toBeVisible();
  }
  await page.getByTestId(`subject-card-${fixture.id}`).click();
  await page.getByTestId('start-exam').click();
  for (let question = 1; question <= 2; question += 1) {
    await expect(page.getByTestId('exam-progress')).toHaveText(`Question ${question} of 2`);
    await page.getByTestId('exam-choice').nth(1).click();
    await page.getByTestId('exam-next').click();
  }
  await expect(page.getByTestId('results-score')).toContainText('2/2');
  await page.getByTestId('results-home').click();
  await page.reload();
  await expect(page.getByTestId('progress-link')).toContainText(`${index + 2} done`);
}

/** Real packaged app acceptance; offline fixture only, no paid calls or real credentials. */
export async function verifyBrowser({ origin, browserUrl, reopen }) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.EXAMIFY_ACCEPTANCE_CHROMIUM
      ? { executablePath: process.env.EXAMIFY_ACCEPTANCE_CHROMIUM }
      : {}),
  });
  let provider;
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
    assert.equal(
      (await context.request.get(`${origin}/_next/image?url=%2Ffavicon.ico&w=64&q=75`)).status(),
      404,
      'Authenticated portable image optimization is disabled',
    );
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
    await expect(page.getByTestId('results-score')).toContainText('0/5');
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

    provider = await startFixtureProvider();
    for (let index = 0; index < FIXTURE_SUBJECTS.length; index += 1) {
      await authorAndStudy(page, provider, FIXTURE_SUBJECTS[index], index, origin);
    }
    assert.deepEqual(
      provider.calls,
      FIXTURE_SUBJECTS.map((subject) => subject.id),
    );

    // Browser-cookie loss has a working launcher recovery, and earlier tokens
    // stay consumed even after another browser capability has been redeemed.
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    const nextUrl = await reopen();
    assert.equal(new URL(nextUrl).origin, origin);
    await freshPage.goto(nextUrl);
    await expect(freshPage).toHaveURL(`${origin}/`);
    await expect(freshPage.getByTestId('progress-link')).toContainText('3 done');
    for (const subject of FIXTURE_SUBJECTS) {
      await expect(freshPage.getByTestId(`subject-card-${subject.id}`)).toBeVisible();
    }
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
    if (provider) await provider.close();
    await browser.close();
  }
}
