import { expect, test, type Locator } from '@playwright/test';
import fs from 'node:fs/promises';
const live = process.env.DEMO_MODE === 'live';
// Recorded app interaction; no browser response mocks. Rehearsal-only fixtures
// are installed explicitly by prepare-rehearsal.mjs before the disposable build.
test('cell biology: install, generate, review, practise, feedback, progress', async ({ page }) => {
  const scenes: Array<{ name: string; at: number }> = [];
  const holds: Array<{ purpose: string; seconds: number; at: number }> = [];
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
  await page.setContent(
    '<main style="font:28px system-ui;padding:80px;background:#f5f1e8;color:#173c2b;height:1000px;box-sizing:border-box"><p>OUR ORIGINAL DEMO NOTES</p><h1>How plant cells work</h1><p>Chloroplasts use light to make sugar.</p><p>Mitochondria release energy from food.</p><p>Plant cells have a cell wall; animal cells do not.</p><p style="margin-top:90px;font-size:22px">These notes are the source for the practice pack.</p><p style="font-size:22px">No-key rehearsal: generation and feedback are scripted.</p></main>',
  );
  await scene('The source: three clear cell-biology ideas');
  await read(8, 'Read the three original source facts');
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
  await click('wizard-generate-demo');
  await expect(page.getByTestId('wizard-generate-run-demo')).toBeVisible({ timeout: 190_000 });
  await expect(page.getByTestId('wizard-error')).toHaveCount(0);
  await read(2, 'Read successful generation summary');
  // Select the marking provider while this supported settings screen is open.
  // Once setup is finished, this app intentionally closes the wizard.
  if (live) {
    await click('wizard-ai-cloud');
    await scene('Choose Anthropic for written-answer marking');
    await read(3, 'Read the explicit marking provider selection');
  }
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
  for (let n = 1; n <= total; n++) {
    const question = (await page.locator('.question-text').textContent()) ?? '';
    await scene(`Question ${n}: ${question}`);
    await read(4, 'Read the actual question and choices');
    const free = page.getByTestId('exam-free-answer');
    if (await free.isVisible()) {
      written++;
      // A coherent answer grounded in the source; never a hash or test assertion.
      await type(
        free,
        'Chloroplasts use light to make sugar. Mitochondria release energy from food for the cell.',
      );
      await read(2, 'Read the completed written explanation');
    } else {
      const choice = /cell walls/i.test(question)
        ? 'Plant cells have a cell wall; animal cells do not.'
        : 'Chloroplasts';
      await page.getByTestId('exam-choice').filter({ hasText: choice }).click();
      await read(2, 'Read the selected answer');
    }
    await click('exam-next');
  }
  expect(written).toBeGreaterThan(0);
  await expect(page.getByTestId('results-score')).toBeVisible({ timeout: 60_000 });
  await scene(
    live
      ? 'Server-side marking returns the actual result'
      : 'Scripted rehearsal result, calculated from the answers',
  );
  await read(4, 'Read the exam score');
  const feedback = page.getByTestId('review-row-free').first();
  await expect(feedback).toContainText(/Score: \d+\/\d+/);
  if (!live) {
    await expect(feedback).toContainText('Scripted rehearsal feedback');
    await expect(feedback).toContainText('Chloroplasts use light to make sugar.');
    await expect(feedback).toContainText('Mitochondria release energy from food.');
  }
  await feedback.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await scene('Written feedback: light makes sugar; food releases energy');
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
      },
      null,
      2,
    ),
  );
});
