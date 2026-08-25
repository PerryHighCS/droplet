import {expect, test} from '@playwright/test';

test('the generated package demo mounts JavaScript and Python editors', async ({page}) => {
  // The lightweight local Playwright server intentionally serves files only;
  // GitHub Pages itself resolves this directory to index.html.
  await page.goto('/site/index.html');

  await expect(page.locator('#javascript-editor .droplet-block-surface')).toBeVisible();
  await expect(page.locator('#python-editor .droplet-block-surface')).toBeVisible();
  await expect(page.locator('#javascript-source')).toContainText('var score = 0');
  await expect(page.locator('#python-source')).toContainText('score = 0');
  await expect(page.locator('#javascript-palette .cat-control')).toBeVisible();
  await expect(page.locator('#javascript-palette')).toContainText('Variables');
  await expect(page.locator('#python-palette .cat-python').first()).toBeVisible();
  await expect(page.locator('#python-palette')).toContainText('Conditionals & loops');

  await page.getByRole('button', {name: 'Use text mode'}).first().click();
  await expect(page.getByRole('button', {name: 'Use block mode'}).first()).toBeVisible();
});
