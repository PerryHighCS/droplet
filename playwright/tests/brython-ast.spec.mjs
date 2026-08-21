import {expect, test} from '@playwright/test';

test('Brython exposes Python AST source locations in a browser', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const ast = await page.evaluate(() => {
    window.brython();
    return JSON.parse(JSON.stringify(
      window.__BRYTHON__.pythonToAST('value = outer(1)\n', 'probe.py', 'file')
    ));
  });

  const assignment = ast.body[0];
  expect(assignment.lineno).toBe(1);
  expect(assignment.col_offset).toBe(0);
  expect(assignment.end_lineno).toBe(1);
  expect(assignment.end_col_offset).toBe('value = outer(1)'.length);
  expect(assignment.value.lineno).toBe(1);
  expect(assignment.value.col_offset).toBe('value = '.length);
});
