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

test('the modern Python adapter projects a live Brython AST without changing source', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = 'for item in [1, 2]:\n  print(f"item: {item}")\n';
  const parsed = await page.evaluate(async (python) => {
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js'
    }});
    document.head.append(importMap);
    const {parsePython} = await import('/packages/python-adapter/src/index.js');
    window.brython();
    return parsePython(python, window.__BRYTHON__.pythonToAST);
  }, source);

  expect(parsed.source).toBe(source);
  expect(parsed.issues).toEqual([]);
  expect(parsed.root.children[0]).toMatchObject({
    kind: 'statement', from: 0, to: source.length - 1, metadata: {type: 'For'}
  });
  expect(parsed.root.children[0].children).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: 'socket', metadata: {type: 'Name'}}),
    expect.objectContaining({kind: 'socket', metadata: {type: 'List'}})
  ]));
  expect(parsed.root.children[0].children).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: 'statement', metadata: {type: 'Expr'}, children: expect.arrayContaining([
      expect.objectContaining({kind: 'socket', metadata: {type: 'Call'}})
    ])})
  ]));
});

test('the modern Python adapter preserves a basic Python 3 corpus', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const sources = [
    'print("hello")\n',
    'name = input("Name: ")\n',
    'message = """first line\nsecond line"""\n',
    'values = [1, 2]\nconfig = {"first": (values[0:1],)}\n',
    'doubled = [item * 2 for item in values]\n',
    'def greet(name="world"):\n  return f"Hello {name}"\nresult = sorted(values, reverse=True)\n',
    'for item in values:\n  if item == 1:\n    continue\n  elif item == 2:\n    break\n  else:\n    pass\n',
    'while count:\n  count -= 1\n',
    'import math\nclass Thing:\n  pass\n',
    'count: int = 1\n'
  ];
  const parsed = await page.evaluate(async (samples) => {
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js'
    }});
    document.head.append(importMap);
    const {parsePython} = await import('/packages/python-adapter/src/index.js');
    window.brython();
    return samples.map((source) => parsePython(source, window.__BRYTHON__.pythonToAST));
  }, sources);

  for (let index = 0; index < sources.length; index += 1) {
    expect(parsed[index]).toMatchObject({source: sources[index], issues: []});
    expect(parsed[index].root).toMatchObject({kind: 'document', from: 0, to: sources[index].length});
  }
});

test('modern match syntax remains source-preserving whether Brython projects it or not', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = 'match status:\n  case 200:\n    pass\n';
  const parsed = await page.evaluate(async (python) => {
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js'
    }});
    document.head.append(importMap);
    const {parsePython} = await import('/packages/python-adapter/src/index.js');
    window.brython();
    return parsePython(python, window.__BRYTHON__.pythonToAST);
  }, source);

  expect(parsed.source).toBe(source);
  expect(parsed.root).toMatchObject({kind: 'document', from: 0, to: source.length});
  if (parsed.issues.length > 0) {
    expect(parsed.root.children[0]).toMatchObject({
      kind: 'opaque-statement', from: 0, to: source.length, editable: false
    });
  }
});
