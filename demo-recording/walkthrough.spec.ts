import { expect, test, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
import { makeSnapshot, waitForAnswerPlan, findAnswer } from './checkpoint/public-plan.mjs';
import { classifyGenerationError } from './checkpoint/generation-status.mjs';
const live = process.env.DEMO_MODE === 'live';
const checkpoint = process.env.DEMO_CHECKPOINT === '1';
// Recorded app interaction; no browser response mocks. Rehearsal-only fixtures
// are installed explicitly by prepare-rehearsal.mjs before the disposable build.
test('cell biology: install, generate, review, practise, feedback, progress', async ({ page }) => {
  const scenes: Array<{ name: string; at: number }> = [];
  const holds: Array<{ purpose: string; seconds: number; at: number }> = [];
  const cuts: Array<{ start: number; end: number; label: string }> = [];
  const started = Date.now();
  const elapsed = () => (Date.now() - started) / 1000;
  async function scene(name: string) {
    scenes.push({ name, at: elapsed() });
    console.log(`Scene: ${name}`);
  }
  async function read(seconds: number, purpose: string) {
    holds.push({ purpose, seconds, at: elapsed() });
    await page.waitForTimeout(seconds * 1000);
  }
  async function click(id: string) {
    await page.getByTestId(id).click();
    await read(0.9, `Transition after ${id}`);
  }
  async function type(locator: Locator, text: string) {
    await locator.fill('');
    await locator.click();
    await locator.pressSequentially(text, { delay: 38 });
  }
  const installLog = await fs.readFile('demo-recording/evidence/install-excerpt.txt', 'utf8');
  await page.setContent(
    '<main style="font:27px system-ui;padding:70px;background:#10251c;color:#f0f7ef;height:1000px;box-sizing:border-box"><h1>Examify: from install to practice</h1><p>Actual installation excerpt · sanitized · time compressed</p><pre style="font:22px monospace;white-space:pre-wrap"></pre><p>Installation completed before this browser recording.</p></main>',
  );
  await page.locator('pre').evaluate((el, text) => {
    el.textContent = text;
  }, installLog);
  await scene('Clean installation: actual command and results, time compressed');
  await read(5, 'Read the short installation excerpt');
  const facts = live
    ? [
        'Chloroplasts use light to make sugar.',
        'Mitochondria release energy from food.',
        'Plant cells have a supporting cell wall.',
        'The cell membrane controls what enters and leaves.',
        'The nucleus stores genetic information.',
      ]
    : [
        'Chloroplasts use light to make sugar.',
        'Mitochondria release energy from food.',
        'Plant cells have a cell wall; animal cells do not.',
      ];
  await page.setContent(
    `<main style="font:28px system-ui;padding:80px;background:#f5f1e8;color:#173c2b;height:1000px;box-sizing:border-box"><p>OUR ORIGINAL DEMO NOTES</p><h1>How plant cells work</h1>${facts.map((fact) => `<p>${fact}</p>`).join('')}<p style="margin-top:50px;font-size:22px">These notes are the source for the practice pack.</p><p style="font-size:22px">${live ? 'Live demonstration with original synthetic study notes.' : 'No-key rehearsal: generation and feedback are scripted.'}</p></main>`,
  );
  await scene(
    live
      ? 'The source: five clear cell-biology ideas'
      : 'The source: three clear cell-biology ideas',
  );
  await read(live ? 10 : 8, 'Read the original source facts');
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/setup/);
  await scene('Create a synthetic household on the fresh installation');
  await type(page.getByTestId('household-name-input'), 'Cell Biology Demo');
  await page.getByTestId('setup-email-input').fill('demo-admin@example.com');
  await page.getByTestId('setup-secret-input').fill('synthetic-demo-bootstrap');
  await page.getByTestId('setup-password-input').fill('Synthetic-demo-passphrase-42');
  await page.getByTestId('setup-confirm-password-input').fill('Synthetic-demo-passphrase-42');
  await read(1.5, 'Review completed synthetic household form');
  await click('setup-submit');
  await expect(page.getByTestId('wizard-welcome')).toBeVisible();
  await read(1.5, 'Read the setup welcome');
  await click('wizard-get-started');
  await expect(page.getByTestId('wizard-subjects')).toContainText('Cell biology');
  await scene('Load the Cell biology pack and its original notes');
  await read(2, 'Read the subject name');
  await click('wizard-next');
  await expect(page.getByTestId('wizard-file-sources-demo')).toContainText('notes.txt');
  await read(3, 'See the attached source notes');
  await click('wizard-next');
  await click(live ? 'wizard-ai-cloud-openai' : 'wizard-ai-skip-stub');
  await scene(
    live
      ? 'Generate questions from these notes with OpenAI'
      : 'Scripted generation rehearsal: no AI request is made',
  );
  await read(2, 'Read the clearly labelled provider choice');
  const generationStarted = elapsed();
  await click('wizard-generate-demo');
  const generationResult = page.getByTestId('wizard-generate-run-demo');
  const generationError = page.getByTestId('wizard-error');
  let generationFailure = 'generation_timeout';
  try {
    await expect(generationResult.or(generationError)).toBeVisible({ timeout: 190_000 });
    if (await generationError.count()) {
      generationFailure = classifyGenerationError(await generationError.textContent());
      if (generationFailure !== 'unclassified_failure') {
        await generationError.scrollIntoViewIfNeeded();
        await read(4, 'Read the application’s generation failure');
      }
      throw Error(generationFailure);
    }
  } catch {
    await fs.mkdir('demo-recording/evidence', { recursive: true });
    await fs.writeFile('demo-recording/evidence/generation-status.json', JSON.stringify({ stage: 'generation', status: 'failed', reason: generationFailure }));
    await fs.writeFile('demo-recording/evidence/chapters.json', JSON.stringify({ mode: live ? 'live' : 'rehearsal', synthetic: true, completed: false, duration: elapsed(), scenes, holds, cuts }));
    throw Error(`Demo stopped: ${generationFailure}`);
  }
  if (live && elapsed() - generationStarted > 8)
    cuts.push({
      start: generationStarted,
      end: elapsed(),
      label: 'Provider generation wait shortened',
    });
  await page
    .getByTestId('wizard-generate-run-demo')
    .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await read(3, 'Read successful generation summary');
  await click('wizard-generate-to-validate');
  await scene('Check the generated pack, then review before applying');
  await click('wizard-validate');
  await expect(page.getByTestId('wizard-validate-ok')).toBeVisible();
  await read(2, 'Read validation success');
  await click('wizard-next');
  await click('wizard-preview');
  await expect(page.getByTestId('wizard-dry-run-summary')).toBeVisible();
  await read(4, 'Read the review summary before applying');
  await click('wizard-to-apply');
  await click('wizard-apply-confirm');
  await expect(page.getByTestId('wizard-applied')).toBeVisible();
  await read(2, 'Confirm the pack was applied');
  await click('wizard-to-ready');
  await click('wizard-finish');
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('manage-ai-settings').click();
  await expect(page).toHaveURL(/\/settings\/ai$/);
  await scene(
    live
      ? 'After setup: choose Anthropic for written marking'
      : 'After setup: change the saved provider without a paid call',
  );
  await page.getByTestId('ai-settings-mode').selectOption('cloud');
  await click('ai-settings-save');
  await expect(page.getByTestId('ai-settings-status')).toContainText('Saved provider: Anthropic');
  await read(4, 'Read the saved provider and configuration-only readiness');
  await page.getByRole('link', { name: 'Back to dashboard' }).click();
  await expect(page).toHaveURL(/\/$/);
  let checkpointReceipt: object | undefined;
  const ledgerPath = 'tests/.tmp/demo-budget';
  async function ledgerIdentity() {
    const names = (await fs.readdir(ledgerPath))
      .filter((name) => /^server-process-\d+\.json$/.test(name))
      .sort();
    return Promise.all(names.map((name) => fs.readFile(`${ledgerPath}/${name}`, 'utf8')));
  }
  let publicSnapshot: ReturnType<typeof makeSnapshot> | undefined;
  let reviewedAnswers: ReturnType<typeof findAnswer>[] | undefined;
  if (checkpoint) {
    publicSnapshot = makeSnapshot({
      bank: JSON.parse(
        await fs.readFile('tests/.tmp/demo-data/content/generated/questions/demo.json', 'utf8'),
      ),
      run: process.env.GITHUB_RUN_ID,
      sourceNotes: await fs.readFile('demo-recording/fixtures/notes.txt', 'utf8'),
    });
    await fs.writeFile(
      'demo-recording/evidence/public-questions.tmp',
      JSON.stringify(publicSnapshot, null, 2),
    );
    await fs.rename(
      'demo-recording/evidence/public-questions.tmp',
      'demo-recording/evidence/public-questions.json',
    );
    await fs.writeFile('tests/.tmp/demo-checkpoint-ready', 'ready');
    const pauseStart = elapsed();
    const ledgerBefore = await ledgerIdentity();
    expect(ledgerBefore.length).toBeGreaterThan(0);
    const expiryBefore = process.env.DEMO_EXPIRES_AT;
    reviewedAnswers = await waitForAnswerPlan(publicSnapshot, {
      expiresAt: Date.parse(process.env.DEMO_EXPIRES_AT ?? ''),
    });
    expect(await ledgerIdentity()).toEqual(ledgerBefore);
    expect(process.env.DEMO_EXPIRES_AT).toBe(expiryBefore);
    checkpointReceipt = {
      runId: publicSnapshot.runId,
      questionHash: publicSnapshot.questionHash,
      sameServerIdentities: true,
      sameExpiry: true,
      answerCount: reviewedAnswers.length,
    };
    cuts.push({
      start: pauseStart,
      end: elapsed(),
      label: 'Source-grounded answer review wait shortened',
    });
  }
  await page.getByRole('button', { name: /Are you smarter than your kid/ }).click();
  await read(1, 'Enter this synthetic adult account’s practice mode');
  await scene('Launch an Easy mini exam from the new Cell biology pack');
  await click('subject-card-demo');
  await click('difficulty-easy');
  await read(3, 'Read the mini-exam and written-marking description');
  await click('start-exam');
  const progress = await page.getByTestId('exam-progress').textContent();
  const total = Number(/of (\d+)/.exec(progress ?? '')?.[1]);
  if (!live) expect(total).toBe(3);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(12);
  let written = 0;
  let gradingStarted: number | undefined;
  for (let n = 1; n <= total; n++) {
    const question = (await page.locator('.question-text').textContent()) ?? '';
    await scene(`Question ${n}: ${question}`);
    await read(4, 'Read the actual question and choices');
    const visibleChoices = await page.locator('.choice-label').allTextContents();
    const reviewed =
      publicSnapshot && reviewedAnswers
        ? findAnswer(publicSnapshot, reviewedAnswers, { question, choices: visibleChoices })
        : undefined;
    const free = page.getByTestId('exam-free-answer');
    if (await free.isVisible()) {
      written++;
      // A coherent answer grounded in the source; never a hash or test assertion.
      await type(
        free,
        reviewed?.type === 'free'
          ? reviewed.response
          : 'Chloroplasts use light to make sugar. Mitochondria release energy from food for the cell.',
      );
      await read(2, 'Read the completed written explanation');
    } else {
      const choice =
        reviewed?.type === 'mcq'
          ? reviewed.chosenText
          : /cell walls/i.test(question)
            ? 'Plant cells have a cell wall; animal cells do not.'
            : 'Chloroplasts';
      await page.getByTestId('exam-choice').filter({ hasText: choice }).click();
      await read(2, 'Read the selected answer');
    }
    if (n === total) gradingStarted = elapsed();
    await page.getByTestId('exam-next').click();
    if (n < total)
      await expect(page.getByTestId('exam-progress')).toHaveText(`Question ${n + 1} of ${total}`);
  }
  expect(written).toBeGreaterThan(0);
  await expect(page.getByTestId('results-score')).toBeVisible({ timeout: 60_000 });
  if (live && gradingStarted !== undefined && elapsed() - gradingStarted > 8)
    cuts.push({ start: gradingStarted, end: elapsed(), label: 'Provider marking wait shortened' });
  await scene(
    live
      ? 'Server-side marking returns the actual result'
      : 'Scripted rehearsal result, calculated from the answers',
  );
  await read(4, 'Read the exam score');
  const writtenReviews = page.getByTestId('review-row-free');
  await expect(writtenReviews).toHaveCount(written);
  for (let i = 0; i < written; i++)
    await expect(writtenReviews.nth(i)).toContainText(/Score: \d+\/\d+/);
  const feedback = writtenReviews.first();
  await expect(feedback).toContainText(/Score: \d+\/\d+/);
  if (!live) {
    await expect(feedback).toContainText('Scripted rehearsal feedback');
    await expect(feedback).toContainText('Chloroplasts use light to make sugar.');
    await expect(feedback).toContainText('Mitochondria release energy from food.');
  }
  await feedback.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await scene(
    live
      ? 'Read the actual written-answer feedback'
      : 'Written feedback: light makes sugar; food releases energy',
  );
  await read(7, 'Read the written-answer feedback');
  await click('results-home');
  await click('progress-link');
  await expect(page.getByTestId('attempt-row').first()).toContainText('Cell biology');
  await scene('The completed attempt is saved in progress');
  await read(5, 'Read saved subject progress');
  await fs.mkdir('demo-recording/evidence', { recursive: true });
  await fs.writeFile(
    'demo-recording/evidence/chapters.json',
    JSON.stringify(
      {
        mode: live ? 'live' : 'rehearsal',
        synthetic: true,
        total,
        written,
        duration: elapsed(),
        scenes,
        holds,
        cuts,
        checkpointReceipt,
      },
      null,
      2,
    ),
  );
});
