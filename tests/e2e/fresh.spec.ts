import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  DESKTOP_AI_VIEWPORT,
  DESKTOP_FOOTER_CLEARANCE_PX,
  DESKTOP_FRAME_MARGIN_Y_PX,
  TABLET_AI_VIEWPORT,
  TABLET_FRAME_MARGIN_Y_PX,
  evaluateSecretActionClearance,
  wizardFrameFitsViewport,
  type LayoutBox,
} from '../helpers/wizard-footer-clearance';

const OUTBOX =
  process.env.MAIL_OUTBOX_DIR ?? path.join(process.cwd(), 'tests', '.tmp', 'e2e-fresh-outbox');

const SECRET_ACTION_IDS = [
  'wizard-anthropic-key-save',
  'wizard-anthropic-key-rotate',
  'wizard-anthropic-key-clear',
] as const;

type MeasuredSecretClearance = {
  footer: LayoutBox;
  viewport: { width: number; height: number };
  controls: Array<{
    id: (typeof SECRET_ACTION_IDS)[number];
    missing: boolean;
    box: LayoutBox | null;
    hitIsControl: boolean;
    hitTestId: string | null;
  }>;
  computed: {
    footerPosition: string;
    footerZ: string;
    actionsPosition: string;
    actionsZ: string;
    actionsBottom: string;
    actionsScrollMarginBottom: string;
    clearance: string;
  };
};

async function measureAiSecretClearance(page: Page): Promise<MeasuredSecretClearance> {
  return page.evaluate((ids) => {
    const toBox = (r: DOMRect) => ({
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
      width: r.width,
      height: r.height,
    });
    const footer = document.querySelector('[data-testid="wizard-footer"]');
    if (!footer) {
      throw new Error('wizard-footer missing');
    }
    const actions = document.querySelector('[data-testid="wizard-anthropic-key-actions"]');
    const shell = document.querySelector('.wizard-shell');
    const footerStyle = getComputedStyle(footer);
    const actionsStyle = actions ? getComputedStyle(actions) : null;
    return {
      footer: toBox(footer.getBoundingClientRect()),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      controls: ids.map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) {
          return { id, missing: true, box: null, hitIsControl: false, hitTestId: null };
        }
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          id,
          missing: false,
          box: toBox(box),
          hitIsControl: Boolean(hit && (el === hit || el.contains(hit))),
          hitTestId: hit?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
        };
      }),
      computed: {
        footerPosition: footerStyle.position,
        footerZ: footerStyle.zIndex,
        actionsPosition: actionsStyle?.position ?? '',
        actionsZ: actionsStyle?.zIndex ?? '',
        actionsBottom: actionsStyle?.bottom ?? '',
        actionsScrollMarginBottom: actionsStyle?.scrollMarginBottom ?? '',
        clearance: shell
          ? getComputedStyle(shell).getPropertyValue('--wizard-footer-clearance').trim()
          : '',
      },
    };
  }, SECRET_ACTION_IDS);
}

async function assertAiSecretActionsClearOfFooter(page: Page) {
  await expect(page.getByTestId('wizard-ai')).toBeVisible();
  await expect(page.getByTestId('wizard-anthropic-key-actions')).toBeVisible();
  const measured = await measureAiSecretClearance(page);
  expect(measured.viewport.width).toBe(DESKTOP_AI_VIEWPORT.width);
  expect(measured.viewport.height).toBe(DESKTOP_AI_VIEWPORT.height);
  expect(measured.computed.footerPosition).toBe('sticky');
  expect(Number(measured.computed.footerZ)).toBeGreaterThanOrEqual(5);
  expect(measured.computed.actionsPosition).toBe('sticky');
  expect(measured.computed.actionsBottom).toBe('0px');
  expect(Number(measured.computed.actionsZ)).toBeGreaterThan(Number(measured.computed.footerZ));
  const scrollMargin = Number.parseFloat(measured.computed.actionsScrollMarginBottom);
  expect(scrollMargin).toBeGreaterThanOrEqual(DESKTOP_FOOTER_CLEARANCE_PX - 0.5);
  expect(measured.footer.height).toBeGreaterThan(0);
  expect(measured.footer.height).toBeLessThanOrEqual(scrollMargin + 24);

  for (const control of measured.controls) {
    expect(control.missing, `${control.id} missing`).toBe(false);
    expect(control.box, `${control.id} empty box`).not.toBeNull();
    const proof = evaluateSecretActionClearance({
      control: control.box!,
      footer: measured.footer,
      viewport: measured.viewport,
      hitIsControl: control.hitIsControl,
    });
    expect(proof, `${control.id} ${JSON.stringify({ proof, hit: control.hitTestId })}`).toEqual({
      ok: true,
      overlap: false,
      aboveFooter: true,
      inViewport: true,
      hitControl: true,
    });
    await expect(page.getByTestId(control.id)).toBeInViewport();
    await page.getByTestId(control.id).click({ trial: true });
  }
}

async function assertWizardFrameFitsFirstViewport(
  page: Page,
  viewport: { width: number; height: number },
  marginY: number,
) {
  await expect(page.getByTestId('wizard-footer')).toBeInViewport();
  await expect(page.getByTestId('wizard-next')).toBeInViewport();
  const frame = await page.locator('.app-frame-wizard').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      height: rect.height,
      top: rect.top,
      bottom: rect.bottom,
      maxHeight: style.maxHeight,
      marginTop: Number.parseFloat(style.marginTop) || 0,
      marginBottom: Number.parseFloat(style.marginBottom) || 0,
    };
  });
  expect(frame.marginTop).toBeCloseTo(marginY, 0);
  expect(frame.marginBottom).toBeCloseTo(marginY, 0);
  expect(
    wizardFrameFitsViewport({
      frameHeight: frame.height,
      marginTop: frame.marginTop,
      marginBottom: frame.marginBottom,
      viewportHeight: viewport.height,
    }),
  ).toBe(true);
  expect(frame.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
}

test.describe.configure({ mode: 'serial' });

test('setup Create household stays in the first desktop viewport', async ({ page }) => {
  await page.setViewportSize(DESKTOP_AI_VIEWPORT);
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByTestId('setup-submit')).toBeInViewport();
  await expect(page.getByTestId('setup-submit')).toBeEnabled();
});

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
  await expect(page.getByRole('heading', { name: 'Set up your family’s content' })).toBeVisible();
  await expect(page.getByTestId('wizard-rail')).toBeVisible();
  await expect(page.getByTestId('wizard-progress')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('wizard-rail')).toBeHidden();
  await page.getByTestId('wizard-get-started').click();
  await expect(page.getByTestId('wizard-subjects')).toBeVisible();
  await expect(page.getByTestId('wizard-progress')).toContainText('Step 2 of 8');
  await expect(page.getByTestId('wizard-progress')).toContainText('Subjects');
  if ((await page.getByTestId('wizard-add-subject').count()) === 0) {
    await page.getByRole('button', { name: 'Add a subject' }).click();
  }
  await page.getByTestId('wizard-subject-label').fill('History');
  await expect(page.getByTestId('wizard-subject-id')).toHaveValue('history');
  await page.getByTestId('wizard-add-subject-submit').click();
  await expect(page.getByTestId('wizard-subjects')).toContainText('History');
  await expect(page.getByTestId('wizard-subjects')).toContainText('history');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-files')).toBeVisible();
  await expect(page.getByTestId('wizard-files')).not.toContainText('0 PDFs');
  await page.getByRole('button', { name: /Generate demo/ }).click();
  await expect(page.getByTestId('wizard-file-sources-demo')).toContainText('notes.txt');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-ai')).toBeVisible();
  await page.getByTestId('wizard-ai-cloud').click();
  await expect(page.getByTestId('wizard-ai-store')).toContainText('not configured');
  await expect(page.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
  await expect(page.getByTestId('wizard-anthropic-key-rotate')).toBeVisible();
  await expect(page.getByTestId('wizard-generate')).toContainText('Generate from local sources');
  await expect(page.getByTestId('wizard-generate-sources-demo')).toContainText('notes.txt');
  await page.getByTestId('wizard-back').click();
  await expect(page.getByTestId('wizard-files')).toBeVisible();

  await page.setViewportSize(DESKTOP_AI_VIEWPORT);
  await expect(page.getByTestId('wizard-rail')).toBeVisible();
  await expect(page.getByTestId('wizard-progress')).toBeHidden();
  await expect(page.getByTestId('wizard-rail')).toContainText('Review');
  await page.getByTestId('wizard-next').click();
  await expect(page.getByTestId('wizard-ai')).toBeVisible();
  await page.getByTestId('wizard-ai-cloud').click();
  await expect(page.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
  await assertAiSecretActionsClearOfFooter(page);
  await page.getByTestId('wizard-stage').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await assertAiSecretActionsClearOfFooter(page);
  await assertWizardFrameFitsFirstViewport(page, DESKTOP_AI_VIEWPORT, DESKTOP_FRAME_MARGIN_Y_PX);

  await page.setViewportSize(TABLET_AI_VIEWPORT);
  await expect(page.getByTestId('wizard-rail')).toBeHidden();
  await expect(page.getByTestId('wizard-anthropic-key-clear')).toBeVisible();
  await expect(page.getByTestId('wizard-anthropic-key-clear')).toBeInViewport();
  await page.getByTestId('wizard-anthropic-key-clear').click({ trial: true });
  await assertWizardFrameFitsFirstViewport(page, TABLET_AI_VIEWPORT, TABLET_FRAME_MARGIN_Y_PX);

  await page.setViewportSize(DESKTOP_AI_VIEWPORT);
  await expect(page.getByTestId('wizard-rail')).toBeVisible();
  await page.getByTestId('wizard-back').click();
  await expect(page.getByTestId('wizard-files')).toBeVisible();
  await page.getByTestId('wizard-back').click();
  await expect(page.getByTestId('wizard-subjects')).toBeVisible();
  await expect(page.getByTestId('wizard-subjects')).toContainText('History');
  await expect(page.getByRole('button', { name: 'Welcome' })).toBeEnabled();
  await page.locator('.wizard-skip-menu summary').click();
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
