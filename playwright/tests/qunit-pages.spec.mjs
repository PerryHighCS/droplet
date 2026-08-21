import { expect, test } from '@playwright/test';

const qunitPages = [
  'ctest.html',
  'cstest.html',
  'htmltest.html',
  'jstest.html',
  'test.html',
  'uitest.html'
];

for (const pageName of qunitPages) {
  test(`QUnit: ${pageName}`, async ({ page }) => {
    await page.goto(`/test/${pageName}`);
    await expect(page.locator('#qunit')).toBeVisible();
    await expect(page.locator('#qunit .failed')).toHaveText('0', {
      timeout: 60_000
    });
  });
}
