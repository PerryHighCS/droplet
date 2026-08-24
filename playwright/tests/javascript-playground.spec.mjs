import {expect, test} from '@playwright/test';

// SVG text renders as one <tspan> per line/segment, so DOM reading order
// (and therefore Playwright's hasText filter) does not match the visual
// left-to-right text - a rendered statement's own dataset.dropletFrom/To
// (set from the exact source range it projects) is the reliable way to
// find a specific block, mirroring the socket lookup in
// brython-ast.spec.mjs's "expandable print argument socket" test.
async function locateByExactSource(page, kind, expectedText) {
  const match = await page.evaluate(({kind, expectedText}) => {
    const source = document.querySelector('#modern-javascript-source').textContent;
    const elements = [...document.querySelectorAll(`.droplet-block-surface [data-droplet-kind="${kind}"]`)];
    const found = elements.find((element) =>
      source.slice(Number(element.dataset.dropletFrom), Number(element.dataset.dropletTo)) === expectedText);
    return found ? {from: found.dataset.dropletFrom, to: found.dataset.dropletTo} : undefined;
  }, {kind, expectedText});
  if (!match) throw new Error(`No ${kind} block with source ${JSON.stringify(expectedText)} found`);
  return page.locator(`[data-droplet-kind="${kind}"][data-droplet-from="${match.from}"][data-droplet-to="${match.to}"]`);
}

test('manual modern JavaScript playground loads with its source and projection panels', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);
  // The playground starts with blockMode: true, and #publishProjection sets
  // the CodeMirror view's inline display to "none" in that mode - the
  // BlockSurface, not CodeMirror's own DOM, is what's actually visible.
  await expect(page.locator('#modern-javascript-editor .droplet-block-surface')).toBeVisible();
  await expect(page.locator('#modern-javascript-editor .cm-editor')).toBeHidden();
  await expect(page.locator('#modern-javascript-source')).toContainText('var score = 0;');
  await expect(page.locator('#modern-javascript-projection')).toContainText('Program');
});

test('manual modern JavaScript playground inserts a palette block through the source transformer', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);
  // "Control" is the only palette category open by default (see renderPalette's
  // `section.open = index === 0`), so its blocks are the only ones clickable
  // without first expanding a <details> section.
  await page.locator('[data-palette-block="while"]').click();

  await expect(page.locator('#modern-javascript-source')).toContainText('score = score + 1;\nwhile (true) {\n}\n');
  await expect(page.locator('#modern-javascript-status')).toHaveText('Inserted while (true) { }.');
});

test('manual modern JavaScript playground switches between text and block mode', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  await page.locator('#modern-javascript-mode').click();
  await expect(page.locator('#modern-javascript-editor .cm-editor')).toBeVisible();
  await expect(page.locator('#modern-javascript-editor .droplet-block-surface')).toBeHidden();
  await expect(page.locator('#modern-javascript-status')).toHaveText('Text mode active.');

  await page.locator('#modern-javascript-mode').click();
  await expect(page.locator('#modern-javascript-editor .droplet-block-surface')).toBeVisible();
  await expect(page.locator('#modern-javascript-editor .cm-editor')).toBeHidden();
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Block mode active/);
});

test('manual modern JavaScript playground accepts a palette block drag at an insertion target', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);
  const target = await locateByExactSource(page, 'statement', 'score = score + 1;');
  const [targetBox, dataTransfer] = await Promise.all([
    target.boundingBox(), page.evaluateHandle(() => new DataTransfer())
  ]);
  // dispatchEvent does not require the source element to be visible, unlike
  // click() - the "Variables" palette category ("var") is collapsed by
  // default (only "Control", index 0, opens automatically).
  const paletteBlock = page.locator('[data-palette-block="var"]');
  await paletteBlock.dispatchEvent('dragstart', {dataTransfer});
  const surface = page.locator('.droplet-block-surface svg');
  await surface.dispatchEvent('dragover', {dataTransfer, clientX: targetBox.x + 3, clientY: targetBox.y + 2});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await surface.dispatchEvent('drop', {dataTransfer, clientX: targetBox.x + 3, clientY: targetBox.y + 2});

  await expect(page.locator('#modern-javascript-source')).toContainText('var value = 1;\nscore = score + 1;');
});

test('manual modern JavaScript playground colors rendered blocks using App Lab categories', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  const ifBlock = await locateByExactSource(page, 'container', 'if (score > 0) {\n  console.log(score);\n}');
  await expect(ifBlock).toHaveAttribute('data-droplet-category', 'control');
  const assignment = await locateByExactSource(page, 'statement', 'score = score + 1;');
  await expect(assignment).toHaveAttribute('data-droplet-category', 'variables');
});
