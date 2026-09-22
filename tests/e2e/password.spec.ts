/**
 * AUTH_MODE=password (the `install.sh` default) in a real browser, plus the
 * core exam flow: sign in, sit a whole mini exam (MCQ + free-text), results,
 * resume after a reload, progress, the parent's read-only dashboard, and a
 * retry after a finish that never reached the server.
 * Runs under `playwright.password.config.ts` against the DB seeded by
 * `pnpm test:e2e:prepare:password` (see `tests/e2e/seed.ts`).
 */
import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD_ACCOUNTS } from './seed';

const { student: STUDENT, parent: PARENT } = E2E_PASSWORD_ACCOUNTS;

type Role = 'Student' | 'Parent';

/** What the test did on one question, so a resume can check it was kept. */
type Answered = { kind: 'mcq'; choice: number } | { kind: 'free'; text: string };

/**
 * The password form handles submit in React. Wait until the form element is
 * hydrated so a click is never a pre-hydration native submit (a GET to
 * `/signin` that would ignore the chosen role).
 */
async function waitForHydration(page: Page, testId: string) {
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    return Boolean(el && Object.keys(el).some((key) => key.startsWith('__reactFiber')));
  }, testId);
}

async function fillSignIn(page: Page, email: string, password: string, role: Role) {
  await page.goto('/signin');
  await expect(page.getByTestId('signin-form')).toBeVisible();
  await expect(page.getByTestId('password-input')).toBeVisible();
  await expect(page.getByTestId('turnstile')).toHaveCount(0);
  await waitForHydration(page, 'signin-form');
  const roleRadio = page.getByRole('radio', { name: role });
  await roleRadio.click();
  await expect(roleRadio).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('email-input').fill(email);
  await page.getByTestId('password-input').fill(password);
  await page.getByTestId('signin-submit').click();
}

async function signIn(page: Page, account: { email: string; password: string }, role: Role) {
  await fillSignIn(page, account.email, account.password, role);
  await expect(page).toHaveURL(/\/$/);
}

async function startExam(page: Page, subjectId: string, difficulty: string) {
  await page.getByTestId(`subject-card-${subjectId}`).click();
  await page.getByTestId(`difficulty-${difficulty}`).click();
  await page.getByTestId('start-exam').click();
  await expect(page.getByTestId('exam-progress')).toHaveText(/^Question 1 of \d+$/);
}

async function examTotal(page: Page): Promise<number> {
  const text = (await page.getByTestId('exam-progress').textContent()) ?? '';
  const total = Number(/of (\d+)/.exec(text)?.[1]);
  expect(total, `question count in "${text}"`).toBeGreaterThan(0);
  return total;
}

/** Answer the question on screen: a sentence for free-text, else a choice. */
async function answerCurrent(page: Page, questionNumber: number): Promise<Answered> {
  const free = page.getByTestId('exam-free-answer');
  if (await free.isVisible()) {
    const text = `My answer to question ${questionNumber} explains it in a full sentence.`;
    await free.fill(text);
    return { kind: 'free', text };
  }
  const choices = page.getByTestId('exam-choice');
  const count = await choices.count();
  expect(count, 'an MCQ needs choices').toBeGreaterThan(1);
  const choice = questionNumber % count;
  await choices.nth(choice).click();
  await expect(choices.nth(choice)).toHaveClass(/\bselected\b/);
  return { kind: 'mcq', choice };
}

async function expectAnswerKept(page: Page, answered: Answered) {
  if (answered.kind === 'free') {
    await expect(page.getByTestId('exam-free-answer')).toHaveValue(answered.text);
    return;
  }
  const choices = page.getByTestId('exam-choice');
  await expect(choices.nth(answered.choice)).toHaveClass(/\bselected\b/);
  await expect(page.locator('[data-testid="exam-choice"].selected')).toHaveCount(1);
  await expect(page.getByTestId('exam-next')).toBeEnabled();
}

test.describe.configure({ mode: 'serial' });

test('student signs in with a password, sits a whole exam, and sees results + progress', async ({
  page,
}) => {
  await signIn(page, STUDENT, 'Student');
  await expect(page.getByRole('heading', { name: 'Pick a subject to practise.' })).toBeVisible();

  // Maths · Easy mixes MCQ with a free-text question.
  await startExam(page, 'maths', 'easy');
  const total = await examTotal(page);
  const kinds: Answered['kind'][] = [];
  for (let n = 1; n <= total; n++) {
    await expect(page.getByTestId('exam-progress')).toHaveText(`Question ${n} of ${total}`);
    const next = page.getByTestId('exam-next');
    await expect(next).toBeDisabled();
    kinds.push((await answerCurrent(page, n)).kind);
    await expect(next).toBeEnabled();
    await expect(next).toHaveText(n === total ? /Finish exam/ : /Next question/);
    await next.click();
  }
  expect(kinds).toContain('free');
  expect(kinds).toContain('mcq');

  // Server-scored results: a score, then one review row per question.
  const score = page.getByTestId('results-score');
  await expect(score).toBeVisible({ timeout: 20_000 });
  await expect(score).toContainText(/\d+% correct/);
  const scoreText = (await score.locator('.score-num').textContent()) ?? '';
  expect(scoreText).toMatch(new RegExp(`^\\d+/${total}$`));
  await expect(page.getByTestId('review-row-mcq')).toHaveCount(
    kinds.filter((k) => k === 'mcq').length,
  );
  const freeRows = page.getByTestId('review-row-free');
  await expect(freeRows).toHaveCount(kinds.filter((k) => k === 'free').length);
  // The grader's bounded verdict renders (not the unmarked NEEDS_REVIEW_COPY line).
  await expect(freeRows.first()).toContainText(/Score: \d+\/\d+ · \S/);

  // The attempt shows up on the student's own progress screen.
  await page.getByTestId('results-home').click();
  await expect(page.getByTestId('progress-link')).toContainText(/Your progress · \d+ done/);
  await page.getByTestId('progress-link').click();
  await expect(page.getByRole('heading', { name: 'How you’re doing' })).toBeVisible();
  const attempt = page.getByTestId('attempt-row').first();
  await expect(attempt).toContainText('Maths');
  await expect(attempt).toContainText('Easy');
  await expect(attempt).toContainText(scoreText);
  await attempt.getByRole('button').click();
  await expect(attempt.locator('.review-row')).toHaveCount(total);
});

test('an exam in progress resumes after a reload with earlier answers kept', async ({ page }) => {
  await signIn(page, STUDENT, 'Student');
  await startExam(page, 'geography', 'easy');
  const total = await examTotal(page);
  expect(total).toBeGreaterThan(2);

  const first = await answerCurrent(page, 1);
  await page.getByTestId('exam-next').click();
  await expect(page.getByTestId('exam-progress')).toHaveText(`Question 2 of ${total}`);
  const second = await answerCurrent(page, 2);
  // Next is an autosave checkpoint. Wait for the save that records question 3
  // as the current one before reloading, so the reload cannot race it.
  const saved = page.waitForResponse(
    (res) =>
      res.request().method() === 'POST' &&
      (res.request().postData() ?? '').includes('"currentIndex":2'),
  );
  await page.getByTestId('exam-next').click();
  await expect(page.getByTestId('exam-progress')).toHaveText(`Question 3 of ${total}`);
  expect((await saved).ok()).toBe(true);

  await page.reload();
  await expect(page.getByText('Continue where you left off')).toBeVisible();
  const resume = page.getByTestId('resume-geography-easy');
  await expect(resume).toContainText(`Easy · Question 3 of ${total}`);
  await resume.click();

  await expect(page.getByTestId('exam-progress')).toHaveText(`Question 3 of ${total}`);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByTestId('exam-progress')).toHaveText(`Question 2 of ${total}`);
  await expectAnswerKept(page, second);
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page.getByTestId('exam-progress')).toHaveText(`Question 1 of ${total}`);
  await expectAnswerKept(page, first);
});

test('parent signs in with a password and sees the child’s progress', async ({ page }) => {
  await signIn(page, PARENT, 'Parent');
  await expect(page.getByRole('heading', { name: 'Student’s progress' })).toBeVisible();
  const child = page.getByTestId('student-attempts');
  await expect(child).toContainText('Student’s attempts');
  await expect(child.getByTestId('attempt-row').first()).toContainText('Maths');
  // The parent has not sat an exam; the child's attempt is not theirs.
  await expect(page.getByText("You haven't tried a mini exam yet")).toBeVisible();
});

test('a wrong password or role shows the generic sign-in error', async ({ page }) => {
  await fillSignIn(page, STUDENT.email, 'definitely-not-the-password', 'Student');
  await expect(page.getByTestId('signin-error-invalid')).toHaveText(
    "Email, password, or role didn't match.",
  );
  await expect(page).toHaveURL(/\/signin$/);

  // Right password, wrong role: the same generic copy (no enumeration).
  await fillSignIn(page, STUDENT.email, STUDENT.password, 'Parent');
  await expect(page.getByTestId('signin-error-invalid')).toHaveText(
    "Email, password, or role didn't match.",
  );
  await expect(page).toHaveURL(/\/signin$/);
});

test('a finish that never reaches the server keeps the answers, and Try again marks them', async ({
  page,
}) => {
  await signIn(page, STUDENT, 'Student');
  await startExam(page, 'computer-science', 'easy');
  const total = await examTotal(page);

  // Drop the first submit (the recordAttempt Server Action — the only request
  // carrying `items`) as if the connection went at the moment of Finish.
  const submits: string[] = [];
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const request = route.request();
      const body = request.postData() ?? '';
      if (request.method() !== 'POST' || !body.includes('"items"')) return route.continue();
      submits.push(body);
      if (submits.length === 1) return route.abort('internetdisconnected');
      return route.continue();
    },
  );

  for (let n = 1; n <= total; n++) {
    await expect(page.getByTestId('exam-progress')).toHaveText(`Question ${n} of ${total}`);
    await answerCurrent(page, n);
    await page.getByTestId('exam-next').click();
  }

  const offline = page.getByTestId('exam-error-unreachable');
  await expect(offline).toBeVisible();
  await expect(offline).toContainText('your answers are still here');
  expect(submits).toHaveLength(1);

  await page.getByTestId('exam-retry').click();
  const score = page.getByTestId('results-score');
  await expect(score).toBeVisible({ timeout: 20_000 });
  await expect(score).toContainText(/\d+% correct/);
  await expect(page.locator('.review-row')).toHaveCount(total);
  // The retry re-sent exactly the answers the dropped submit carried.
  expect(submits).toHaveLength(2);
  expect(submits[1]).toBe(submits[0]);
});
