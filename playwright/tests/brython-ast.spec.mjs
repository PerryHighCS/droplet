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
  expect(JSON.stringify(ast)).not.toContain('# retained comment');
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

test('the modern Python adapter retains descendants of Brython AST containers', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = 'def greet(name="world"):\n  return [item for item in values]\n';
  const nodes = await page.evaluate(async (python) => {
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js'
    }});
    document.head.append(importMap);
    const {parsePython} = await import('/packages/python-adapter/src/index.js');
    window.brython();
    const parsed = parsePython(python, window.__BRYTHON__.pythonToAST);
    const collect = (node) => [
      {type: node.metadata?.type, kind: node.kind},
      ...(node.children ?? []).flatMap(collect)
    ];
    return collect(parsed.root);
  }, source);

  expect(nodes).toEqual(expect.arrayContaining([
    {type: 'arg', kind: 'socket'},
    {type: 'Constant', kind: 'socket'},
    {type: 'Name', kind: 'socket'}
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

test('Brython tokenizer retains comments and reports visual indentation ranges', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = '# heading\nif value:\n\t# nested\n\tresult = value  # inline\n';
  const result = await page.evaluate(async (python) => {
    window.brython();
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js'
    }});
    document.head.append(importMap);
    const {collectPythonTrivia} = await import('/packages/python-adapter/src/index.js');
    return {
      tokens: [...window.__BRYTHON__.tokenizer(python, 'probe.py', 'file')]
      .map(({type, string, lineno, col_offset, end_lineno, end_col_offset}) => ({
        type, string, lineno, col_offset, end_lineno, end_col_offset
      })),
      trivia: collectPythonTrivia(python, window.__BRYTHON__.tokenizer)
    };
  }, source);

  const {tokens, trivia} = result;
  expect(tokens).toEqual(expect.arrayContaining([
    expect.objectContaining({string: '# heading', lineno: 1, col_offset: 0, end_col_offset: 9}),
    expect.objectContaining({string: '# nested', lineno: 3, col_offset: 1, end_col_offset: 9}),
    expect.objectContaining({string: '', type: 5, lineno: 4, col_offset: 0, end_col_offset: 8}),
    expect.objectContaining({string: '# inline', lineno: 4, col_offset: 17, end_col_offset: 25})
  ]));
  expect(trivia).toEqual({
    comments: [
      {kind: 'comment', from: 0, to: 9, inline: false},
      {kind: 'comment', from: 21, to: 29, inline: false},
      {kind: 'comment', from: 47, to: 55, inline: true}
    ],
    indentation: [{kind: 'indentation', from: 30, to: 31, text: '\t'}]
  });
});

test('CodeMirror block mode preserves Brython Python source in Chromium', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = "label = 'single quoted'\nmessage = \"\"\"first line\nsecond line\"\"\"\n";
  const result = await page.evaluate(async (python) => {
    const importMap = document.createElement('script');
    importMap.type = 'importmap';
    importMap.textContent = JSON.stringify({imports: {
      '@droplet/core': '/packages/core/src/index.js',
      '@droplet/codemirror-editor': '/packages/codemirror-editor/src/index.js',
      '@droplet/codemirror-editor/droplet': '/packages/codemirror-editor/src/droplet.js',
      '@codemirror/state': '/playwright/node_modules/@codemirror/state/dist/index.js',
      '@codemirror/view': '/playwright/node_modules/@codemirror/view/dist/index.js',
      '@codemirror/commands': '/playwright/node_modules/@codemirror/commands/dist/index.js',
      '@codemirror/language': '/playwright/node_modules/@codemirror/language/dist/index.js',
      '@lezer/common': '/playwright/node_modules/@lezer/common/dist/index.js',
      '@lezer/highlight': '/playwright/node_modules/@lezer/highlight/dist/index.js',
      '@lezer/lr': '/playwright/node_modules/@lezer/lr/dist/index.js',
      '@marijn/find-cluster-break': '/playwright/node_modules/@marijn/find-cluster-break/src/index.js',
      'crelt': '/playwright/node_modules/crelt/index.js',
      'style-mod': '/playwright/node_modules/style-mod/src/style-mod.js',
      'w3c-keyname': '/playwright/node_modules/w3c-keyname/index.js'
    }});
    document.head.append(importMap);
    const {createDropletCodeMirrorEditor} = await import('@droplet/codemirror-editor/droplet');
    const {createBrythonPythonParser} = await import('/packages/python-adapter/src/index.js');
    window.brython();
    const parent = document.createElement('div');
    document.body.append(parent);
    const editor = createDropletCodeMirrorEditor({
      parent,
      value: python,
      blockMode: true,
      parse: createBrythonPythonParser(window.__BRYTHON__.pythonToAST)
    });
    const structured = {
      value: editor.getValue(),
      blocks: parent.querySelectorAll('.droplet-block-statement').length
    };
    editor.setBlockMode(false);
    const textValue = editor.getValue();
    editor.setValue('if score >');
    editor.setBlockMode(true);
    const opaque = {
      value: editor.getValue(),
      blocks: parent.querySelectorAll('.droplet-opaque').length
    };
    editor.destroy();
    return {structured, textValue, opaque};
  }, source);

  expect(result.structured).toMatchObject({value: source});
  expect(result.structured.blocks).toBeGreaterThan(0);
  expect(result.textValue).toBe(source);
  expect(result.opaque).toEqual({value: 'if score >', blocks: 1});
});
