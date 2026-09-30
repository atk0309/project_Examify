import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
const live = process.env.DEMO_MODE === 'live';
// Only synthetic people/content. No browser routes or response mocks.
test('fresh household → source pack → generate → apply → sit exam → progress', async ({ page }) => {
  const chapters: Array<{ name: string; elapsedSeconds: number }> = [];
  const start = Date.now();
  async function chapter(name: string) {
    chapters.push({ name, elapsedSeconds: (Date.now() - start) / 1000 });
    console.log(`Chapter: ${name}`);
    await page.waitForTimeout(13_000);
  }
  const installLog = await fs.readFile('demo-recording/evidence/install-excerpt.txt', 'utf8');
  // Honest edited chapter: these are the real prior command results, not a
  // pretend interactive terminal. The full browser recording starts here.
  await page.setContent(
    '<main style="font:24px monospace;padding:50px;background:#101828;color:#e9efff;height:900px"><h1>Examify: clean runner installation</h1><p>Actual installation output excerpt. Installation completed before this browser recording.</p><pre style="white-space:pre-wrap;font-size:18px"></pre><p>Synthetic household and source notes only.</p></main>',
  );
  await page.locator('pre').textContent();
  await page.locator('pre').evaluate((el, text) => {
    el.textContent = text;
  }, installLog);
  await chapter('Actual clean-install output excerpt; time compressed');
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/setup/);
  await chapter('Fresh installation: create a synthetic household');
  await page.getByTestId('household-name-input').fill('Examify Demo Household');
  await page.getByTestId('setup-email-input').fill('demo-admin@example.com');
  await page.getByTestId('setup-secret-input').fill('synthetic-demo-bootstrap');
  await page.getByTestId('setup-password-input').fill('Synthetic-demo-passphrase-42');
  await page.getByTestId('setup-confirm-password-input').fill('Synthetic-demo-passphrase-42');
  await page.getByTestId('setup-submit').click();
  await expect(page.getByTestId('wizard-welcome')).toBeVisible();
  await page.getByTestId('wizard-get-started').click();
  await expect(page.getByTestId('wizard-subjects')).toContainText('Generate demo');
  await chapter('Demo source pack copied into the isolated family data folder');
  await page.getByTestId('wizard-next').click();
  const demoTab = page.getByTestId('wizard-file-tab-demo');
  if (await demoTab.count()) await demoTab.click();
  await expect(page.getByTestId('wizard-file-sources-demo')).toContainText('notes.txt');
  await page.getByTestId('wizard-next').click();
  // The main clip uses OpenAI for generation and grading. A second short pass
  // can exercise Anthropic after the first recording is verified; never silently
  // switches providers or presents fixture results as real AI.
  await page.getByTestId(live ? 'wizard-ai-cloud-openai' : 'wizard-ai-skip-stub').click();
  await chapter(
    live
      ? 'Generate BankIR with real OpenAI'
      : 'REHEARSAL: deterministic test provider, no API calls',
  );
  await page.getByTestId('wizard-generate-demo').click();
  await expect(page.getByTestId('wizard-generate-run-demo')).toBeVisible({ timeout: 190_000 });
  await expect(page.getByTestId('wizard-error')).toHaveCount(0);
  await page.getByTestId('wizard-generate-to-validate').click();
  await page.getByTestId('wizard-validate').click();
  await expect(page.getByTestId('wizard-validate-ok')).toBeVisible();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-preview').click();
  await expect(page.getByTestId('wizard-dry-run-summary')).toBeVisible();
  await chapter('Review the actual generated pack before applying');
  await page.getByTestId('wizard-to-apply').click();
  await page.getByTestId('wizard-apply-confirm').click();
  await expect(page.getByTestId('wizard-applied')).toBeVisible();
  await page.getByTestId('wizard-to-ready').click();
  await page.getByTestId('wizard-finish').click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/onboarding');
  await page.getByTestId('wizard-get-started').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-next').click();
  await page.getByTestId('wizard-ai-cloud').click();
  await chapter(
    live
      ? 'Switch to Anthropic for written-answer marking'
      : 'REHEARSAL: select Anthropic mode with a test sentinel',
  );
  await page.goto('/');
  await expect(page.getByTestId('parent-marking')).toContainText(live ? 'Anthropic' : 'test');
  await page.getByRole('button', { name: /Are you smarter than your kid/ }).click();
  await page.getByTestId('subject-card-demo').click();
  await page.getByTestId('difficulty-easy').click();
  await chapter('Launch a mini exam from the newly generated pack');
  await page.getByTestId('start-exam').click();
  const text = await page.getByTestId('exam-progress').textContent();
  const total = Number(/of (\d+)/.exec(text ?? '')?.[1]);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThanOrEqual(12);
  let written = 0;
  for (let n = 1; n <= total; n++) {
    const free = page.getByTestId('exam-free-answer');
    if (await free.isVisible()) {
      written++;
      // Answer from the visible source notes, never from server answer keys.
      await free.fill(
        live
          ? 'Chloroplasts capture light to make sugar. Mitochondria release energy from food. Plant cells have a cell wall; animal cells do not.'
          : 'This is a synthetic rehearsal answer in a complete sentence.',
      );
    } else {
      await page.getByTestId('exam-choice').first().click();
    }
    await page.getByTestId('exam-next').click();
  }
  expect(written).toBeGreaterThan(0);
  await expect(page.getByTestId('results-score')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('review-row-free').first()).toContainText(/Score: \d+\/\d+/);
  await page.getByTestId('review-row-free').first().scrollIntoViewIfNeeded();
  await chapter(
    live ? 'Real server-side grading and review' : 'REHEARSAL: stub marking, not AI grading',
  );
  await page.getByTestId('results-home').click();
  await page.getByTestId('progress-link').click();
  await expect(page.getByTestId('attempt-row').first()).toContainText('Generate demo');
  await chapter('Persisted progress for this synthetic account');
  await fs.mkdir('demo-recording/evidence', { recursive: true });
  await fs.writeFile(
    'demo-recording/evidence/chapters.json',
    JSON.stringify(
      { mode: live ? 'live' : 'rehearsal', synthetic: true, total, written, chapters },
      null,
      2,
    ),
  );
});
