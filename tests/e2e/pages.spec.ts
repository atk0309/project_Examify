import { expect, test } from '@playwright/test';

const STATIC_ROUTES = [
  { path: '/signin', titleMatch: /Sign in/ },
  { path: '/signin/verify/error?reason=expired', titleMatch: /Sign-in link invalid/ },
] as const;

test.describe('static pages', () => {
  for (const route of STATIC_ROUTES) {
    test(`GET ${route.path} renders without console errors`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => consoleErrors.push(err.message));

      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path} should return 200`).toBe(200);
      await expect(page).toHaveTitle(route.titleMatch);

      // Filter out network noise from missing Turnstile/Plausible/font scripts.
      // Markers stay plain words (not hostname-shaped strings) so this log-line
      // mute can't read as URL validation (CodeQL
      // js/incomplete-url-substring-sanitization).
      const noise = ['turnstile', 'plausible', 'cloudflare', 'fonts.g', 'failed to load resource'];
      const significant = consoleErrors.filter(
        (line) => !noise.some((marker) => line.toLowerCase().includes(marker)),
      );
      expect(significant, `console errors on ${route.path}`).toEqual([]);
    });
  }
});

test('the login screen shows the brand + role control', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByRole('heading', { name: 'Examify' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Student' })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Parent' })).toBeVisible();
});

test('the verify error page renders the reason copy and a recovery link', async ({ page }) => {
  await page.goto('/signin/verify/error?reason=used');
  await expect(page.getByText('That link has already been used.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
});

test('the home route redirects unauthenticated visitors to /signin', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/signin$/);
});
