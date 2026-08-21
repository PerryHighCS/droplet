import {expect, test} from '@playwright/test';

test('Brython exposes Python AST source locations in a browser', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const result = await page.evaluate(() => {
    window.brython();
    const parsed = window.__BRYTHON__.pythonToAST('value = outer(1)\n', 'probe.py', 'file');
    const assignment = parsed.body[0];
    return {
      ast: JSON.parse(JSON.stringify(parsed)),
      assignmentType: assignment.constructor?.$name ?? assignment.__class__?.__name__ ?? Object.getPrototypeOf(assignment)?.$name
    };
  });

  const ast = result.ast;
  const assignment = ast.body[0];
  expect(assignment.lineno).toBe(1);
  expect(assignment.col_offset).toBe(0);
  expect(assignment.end_lineno).toBe(1);
  expect(assignment.end_col_offset).toBe('value = outer(1)'.length);
  expect(assignment.value.lineno).toBe(1);
  expect(assignment.value.col_offset).toBe('value = '.length);
  expect(result.assignmentType).toBe('Assign');
});

test('Brython AST columns use JavaScript source offsets and omit comments', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = '# retained comment\nname = "😀"\n';
  const ast = await page.evaluate((python) => {
    window.brython();
    return JSON.parse(JSON.stringify(
      window.__BRYTHON__.pythonToAST(python, 'probe.py', 'file')
    ));
  }, source);

  const assignment = ast.body[0];
  expect(assignment.lineno).toBe(2);
  expect(assignment.col_offset).toBe(0);
  expect(assignment.end_col_offset).toBe('name = "😀"'.length);
  expect(Object.values(ast).flat()).not.toContain('# retained comment');
});
