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

test('Python block movement preserves nested suites, comments, and blank lines', async ({page}) => {
  await page.goto('/test/ctest.html');
  await page.addScriptTag({url: '/playwright/node_modules/brython/brython.js'});
  const source = 'if outer:\n  # standalone\n  if ready:\n    first = 1  # retain\n  second = 2\n\ntail = 0\n';
  const value = await page.evaluate(async (python) => {
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
    const {
      createBrythonPythonParser,
      createBrythonPythonTransformer,
      createEmptyPythonSuite
    } = await import('/packages/python-adapter/src/index.js');
    window.brython();
    const parent = document.createElement('div');
    document.body.append(parent);
    const pythonToAST = window.__BRYTHON__.pythonToAST;
    const editor = createDropletCodeMirrorEditor({
      parent, value: python, blockMode: true,
      parse: createBrythonPythonParser(pythonToAST),
      transform: createBrythonPythonTransformer(pythonToAST)
    });
    const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];
    const projection = editor.getProjection();
    const nestedSuite = nodes(projection.root).find((node) =>
      node.metadata?.type === 'If' && python.slice(node.from, node.to).startsWith('if ready:'));
    const tail = nodes(projection.root).find((node) => python.slice(node.from, node.to) === 'tail = 0');
    editor.applyBlockOperation({
      type: 'move-statement', source: {from: nestedSuite.from, to: nestedSuite.to},
      destination: {from: tail.from, to: tail.from}
    });
    const currentSource = editor.getValue();
    const insertionTarget = nodes(editor.getProjection().root).find((node) =>
      currentSource.slice(node.from, node.to) === 'tail = 0');
    editor.applyBlockOperation({
      type: 'insert-statement',
      destination: {from: insertionTarget.from, to: insertionTarget.from},
      source: `if created:\n${createEmptyPythonSuite('  ')}`
    });
    const result = editor.getValue();
    editor.destroy();
    return result;
  }, source);

  expect(value).toBe(
    'if outer:\n  # standalone\n  second = 2\n\nif ready:\n  first = 1  # retain\nif created:\n  pass\ntail = 0\n'
  );
});

test('manual modern Python playground loads with its source and projection panels', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  await expect(page.locator('#modern-python-editor .cm-editor')).toBeVisible();
  await expect(page.locator('#modern-python-source')).toContainText('if outer:');
  await expect(page.locator('#modern-python-projection')).toContainText('Module');
});

test('manual modern Python playground resolves a block hover to an insertion gap', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const {nestedSuite, tail} = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const blocks = [...document.querySelectorAll('[data-droplet-kind="statement"]')];
    const nestedSuite = blocks.find((block) => source.slice(
      Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
    ).startsWith('if ready:'));
    const tail = blocks.find((block) => source.slice(
      Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
    ) === 'tail = 0');
    return {
      nestedSuite: {from: nestedSuite.dataset.dropletFrom, to: nestedSuite.dataset.dropletTo},
      tail: {from: tail.dataset.dropletFrom, to: tail.dataset.dropletTo}
    };
  });
  const block = ({from, to}) => page.locator(
    `[data-droplet-kind="statement"][data-droplet-from="${from}"][data-droplet-to="${to}"]`
  ).first();
  const sourceBox = await block(nestedSuite).boundingBox();
  const targetBox = await block(tail).boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2 + 8);
  await expect(page.locator('.droplet-drag-preview')).toBeVisible();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * .75, {steps: 10});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await expect(page.locator('.droplet-drop-preview')).toContainText('if ready:');
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('tail = 0\nif ready:\n  first = 1  # inline note');
});

test('manual modern Python playground attaches a standalone comment without moving its containing suite', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const {comment, tail} = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const blocks = [...document.querySelectorAll('[data-droplet-kind]')];
    const range = (block) => ({from: block.dataset.dropletFrom, to: block.dataset.dropletTo});
    return {
      comment: range(blocks.find((block) => block.dataset.dropletKind === 'comment' && source.slice(
        Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
      ) === '# standalone note')),
      tail: range(blocks.find((block) => block.dataset.dropletKind === 'statement' && source.slice(
        Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
      ) === 'tail = 0'))
    };
  });
  const block = ({from, to}) => page.locator(`[data-droplet-from="${from}"][data-droplet-to="${to}"]`).first();
  const commentBox = await block(comment).boundingBox();
  const tailBox = await block(tail).boundingBox();
  await page.mouse.move(commentBox.x + commentBox.width / 2, commentBox.y + commentBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(commentBox.x + commentBox.width / 2 + 8, commentBox.y + commentBox.height / 2 + 8);
  await page.mouse.move(tailBox.x + tailBox.width + 100, tailBox.y + tailBox.height / 2, {steps: 10});
  await expect(page.locator('.droplet-drop-preview')).toContainText('# standalone note');
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText(
    'if outer:\n  if ready:\n    first = 1  # inline note\n  second = 2\n\ntail = 0  # standalone note'
  );
});

test('manual modern Python playground drags an inline comment without moving its statement', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const {comment, tail} = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const blocks = [...document.querySelectorAll('[data-droplet-kind]')];
    const range = (block) => ({from: block.dataset.dropletFrom, to: block.dataset.dropletTo});
    return {
      comment: range(blocks.find((block) => block.dataset.dropletKind === 'comment' && source.slice(
        Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
      ) === '# inline note')),
      tail: range(blocks.find((block) => block.dataset.dropletKind === 'statement' && source.slice(
        Number(block.dataset.dropletFrom), Number(block.dataset.dropletTo)
      ) === 'tail = 0'))
    };
  });
  const block = ({from, to}) => page.locator(`[data-droplet-from="${from}"][data-droplet-to="${to}"]`).first();
  const commentBox = await block(comment).boundingBox();
  const tailBox = await block(tail).boundingBox();
  await page.mouse.move(commentBox.x + commentBox.width / 2, commentBox.y + commentBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(commentBox.x + commentBox.width / 2 + 8, commentBox.y + commentBox.height / 2 + 8);
  await expect(page.locator('.droplet-drag-preview')).toContainText('# inline note');
  await page.mouse.move(tailBox.x + tailBox.width / 2, tailBox.y - 4, {steps: 10});
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toHaveText(
    'if outer:\n  # standalone note\n  if ready:\n    first = 1\n  second = 2\n\n# inline note\ntail = 0\n'
  );
});
