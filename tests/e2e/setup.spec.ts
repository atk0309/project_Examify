import { expect, test } from '@playwright/test';

test('GET /setup redirects to /signin when a household already exists', async ({ page }) => {
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/signin/);
});

test('GET /invite/bogus renders an invalid-invite page', async ({ page }) => {
  const response = await page.goto('/invite/bogus');
  expect(response?.status()).toBe(200);
  await expect(page.getByText('Invite invalid')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
