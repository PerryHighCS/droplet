import { expect, test } from '@playwright/test';

const qunitPages = [
  'ctest.html',
  'cstest.html',
  'htmltest.html',
  'jstest.html',
  'pytest.html',
  'test.html',
  'uitest.html'
];

test('static server does not expose dotted paths', async ({ request }) => {
  const response = await request.get('/.git/config');

  expect(response.status()).toBe(404);
});

test.describe('legacy QUnit pages', () => {
  // C parser freeze coverage and the timer-driven UI interactions can each
  // exceed Playwright's ordinary 30-second deadline on constrained runners.
  test.describe.configure({timeout: 150_000});

  for (const pageName of qunitPages) {
    test(`QUnit: ${pageName}`, async ({ page }) => {
      await page.goto(`/test/${pageName}`);
      await expect(page.locator('#qunit')).toBeVisible();
      await expect(page.locator('#qunit .failed')).toHaveText('0', {
        timeout: pageName === 'uitest.html' ? 110_000 : 60_000
      });
    });
  }
});

test('demo preserves JavaScript source while toggling text and blocks', async ({ page }) => {
  const source = [
    'var total = 1 + 2;',
    'if (total > 2) {',
    '  announce("large");',
    '}'
  ].join('\n') + '\n';

  await page.addInitScript(({ initialSource }) => {
    localStorage.setItem('blocks', 'no');
    localStorage.setItem('config', '({"mode":"javascript","palette":[]})');
    localStorage.setItem('text', initialSource);
  }, { initialSource: source });

  await page.goto('/example/example.html');
  await expect.poll(() => page.evaluate(() => Boolean(window.editor))).toBe(true);
  await expect(page.locator('#toggle')).toBeVisible();

  const firstToggle = page.evaluate(() => new Promise((resolve) => {
    window.editor.once('toggledone', resolve);
  }));
  await page.locator('#toggle').click();
  await firstToggle;
  await expect.poll(() => page.evaluate(() => window.editor.session.currentlyUsingBlocks)).toBe(true);

  const secondToggle = page.evaluate(() => new Promise((resolve) => {
    window.editor.once('toggledone', resolve);
  }));
  await page.locator('#toggle').click();
  await secondToggle;
  await expect.poll(() => page.evaluate(() => window.editor.session.currentlyUsingBlocks)).toBe(false);
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe(source);
});
