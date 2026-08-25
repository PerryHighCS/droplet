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

test('manual modern JavaScript playground exposes the exact compatibility corpus as a block-mode fixture', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  await page.locator('#modern-javascript-sample').selectOption('Compatibility corpus');
  await expect(page.locator('#modern-javascript-source')).toHaveText(/var total = answer \+ 2 \* \(3 \+ 4\);/);
  await expect(page.locator('#modern-javascript-source')).toContainText('var note = "double"; // inline comment');
  await expect(await locateByExactSource(page, 'container', 'for (var i = 0; i < 3; i++) {\n  items.push(i);\n}')).toBeVisible();
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

test('manual modern JavaScript playground keeps the opaque-recovery status visible after selecting a broken sample', async ({page}) => {
  // setValue() synchronously runs refresh() first, which already reports an
  // opaque-recovery issue for this sample - the sample-select handler's own
  // unconditional "Loaded..." status update immediately overwrote it.
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  await page.locator('#modern-javascript-sample').selectOption('Broken syntax');

  await expect(page.locator('#modern-javascript-status')).toHaveText(/^Opaque recovery:/);
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

test('manual modern JavaScript playground moves a container together with its nested statement, then the statement alone', async ({page}) => {
  // Dragging an existing rendered block (not a palette block - no
  // DataTransfer involved, just the surface's own pointerdown/pointermove/
  // pointerup drag) is this project's central ownership guarantee: a
  // container drag must carry its whole subtree, while a drag of one of its
  // children must move only that child. Only palette-to-target drags were
  // covered here before; this exercises both directions through the real
  // browser/adapter path.
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  const container = await locateByExactSource(page, 'container', 'if (score > 0) {\n  console.log(score);\n}');
  const tail = await locateByExactSource(page, 'statement', 'score = score + 1;');
  const [containerBox, tailBox] = await Promise.all([container.boundingBox(), tail.boundingBox()]);
  // The lower half of an existing statement is an "insert after" target (see
  // block-surface.js's own upper/lower-half insertion zones). The press point
  // must clear both the block's own top/left edge (subpixel rounding can put
  // a +4,+4 offset a fraction of a pixel outside the box, silently landing
  // on nothing) and any socket text inside it (clicking a socket opens its
  // editor instead of starting a block drag) - +8,+8 on the header keyword
  // clears both.
  await page.mouse.move(containerBox.x + 8, containerBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(containerBox.x + 20, containerBox.y + 8, {steps: 8});
  // The preview is rendered from the same recursive subtree layout as the
  // on-canvas block.  Checking the projected descendants in the real browser
  // catches a regression where the floating preview falls back to a flat
  // label/rectangle while the stationary container remains structured.
  await expect(page.locator('.droplet-drag-preview [data-droplet-kind="container"]')).toHaveCount(1);
  await expect(page.locator('.droplet-drag-preview [data-droplet-kind="statement"]')).toHaveCount(1);
  await expect(page.locator('.droplet-drag-preview')).toContainText('console.log(score);');
  await page.mouse.move(tailBox.x + 8, tailBox.y + tailBox.height - 2, {steps: 8});
  await page.mouse.up();

  await expect(page.locator('#modern-javascript-source')).toContainText(
    'score = score + 1;\nif (score > 0) {\n  console.log(score);\n}');

  const relocatedNested = await locateByExactSource(page, 'statement', 'console.log(score);');
  const relocatedTail = await locateByExactSource(page, 'statement', 'score = score + 1;');
  const [nestedBox, relocatedTailBox] = await Promise.all([relocatedNested.boundingBox(), relocatedTail.boundingBox()]);
  await page.mouse.move(nestedBox.x + 8, nestedBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(nestedBox.x + 20, nestedBox.y + 10, {steps: 8});
  await page.mouse.move(relocatedTailBox.x + 8, relocatedTailBox.y + relocatedTailBox.height - 2, {steps: 8});
  await page.mouse.up();

  await expect(page.locator('#modern-javascript-source')).toContainText('if (score > 0) {\n  \n}');
  await expect(page.locator('#modern-javascript-source')).toContainText('score = score + 1;\nconsole.log(score);');
});

test('manual modern JavaScript playground colors rendered blocks using App Lab categories', async ({page}) => {
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);

  const ifBlock = await locateByExactSource(page, 'container', 'if (score > 0) {\n  console.log(score);\n}');
  await expect(ifBlock).toHaveAttribute('data-droplet-category', 'control');
  const assignment = await locateByExactSource(page, 'statement', 'score = score + 1;');
  await expect(assignment).toHaveAttribute('data-droplet-category', 'variables');
});

test('manual modern JavaScript playground colors a Math.* call as math, not variables', async ({page}) => {
  // calleeCategory categorized every member call the same way (console.log,
  // str.substring, Math.round, ...) as "variables" - but this playground's
  // own palette (and its documented category scheme) puts Math.* under
  // "math", contradicting how a Math.* call actually rendered once inserted.
  await page.goto('/example/modern-javascript.html');
  await expect(page.locator('#modern-javascript-status')).toHaveText(/Ready/);
  // "Math" is the second category in the default-open "Control" palette's
  // sibling list - open it before its blocks are clickable.
  await page.locator('.palette-category', {hasText: 'Math'}).locator('summary').click();

  await page.locator('[data-palette-block="round"]').click();

  const call = await locateByExactSource(page, 'statement', 'Math.round()');
  await expect(call).toHaveAttribute('data-droplet-category', 'math');
});
