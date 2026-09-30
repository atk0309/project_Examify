import { expect, test } from '@playwright/test';
test('fresh application and browser start without provider credentials', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByTestId('household-name-input')).toBeVisible();
  await expect(page.getByTestId('setup-submit')).toBeVisible();
});
