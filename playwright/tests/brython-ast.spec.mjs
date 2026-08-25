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
  // metadata is matched with objectContaining, not a bare literal - every
  // socket also carries a socketRole (see metadataFor in the python-adapter),
  // so a bare {type: 'Name'} would never equal the received object.
  expect(parsed.root.children[0].children).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: 'socket', metadata: expect.objectContaining({type: 'Name'})}),
    expect.objectContaining({kind: 'socket', metadata: expect.objectContaining({type: 'List'})})
  ]));
  // A call is a structural 'expression' wrapper around its own callee and
  // argument sockets, not an editable socket itself - see project() in the
  // python-adapter.
  expect(parsed.root.children[0].children).toEqual(expect.arrayContaining([
    expect.objectContaining({kind: 'statement', metadata: {type: 'Expr'}, children: expect.arrayContaining([
      expect.objectContaining({kind: 'expression', metadata: {type: 'Call'}})
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
      blocks: parent.querySelectorAll('.droplet-block-surface [data-droplet-kind="statement"]').length
    };
    editor.setBlockMode(false);
    const textValue = editor.getValue();
    editor.setValue('if score >');
    editor.setBlockMode(true);
    const opaque = {
      value: editor.getValue(),
      blocks: parent.querySelectorAll('.droplet-block-surface [data-droplet-kind="opaque-statement"]').length
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
  // The playground starts with blockMode: true, and #publishProjection sets
  // the CodeMirror view's inline display to "none" in that mode - the
  // BlockSurface, not CodeMirror's own DOM, is what's actually visible.
  await expect(page.locator('#modern-python-editor .droplet-block-surface')).toBeVisible();
  await expect(page.locator('#modern-python-editor .cm-editor')).toBeHidden();
  await expect(page.locator('#modern-python-source')).toContainText('if outer:');
  await expect(page.locator('#modern-python-projection')).toContainText('Module');
});

test('manual modern Python playground inserts a Python palette block through the source transformer', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  await page.locator('[data-palette-block="assignment"]').click();

  await expect(page.locator('#modern-python-source')).toContainText('tail = 0\nvalue = 1');
  await expect(page.locator('#modern-python-status')).toHaveText('Inserted value = 1.');
});

test('manual modern Python playground inserts a palette block before a selected standalone comment', async ({page}) => {
  // insertPaletteBlock's own "selected" lookup only matched kind: 'statement',
  // so selecting a standalone comment first (the playground's own help text
  // says selecting a block inserts before it) was silently ignored - the new
  // block was appended at the document's own end instead.
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  const comment = page.locator('.droplet-block-surface [data-droplet-kind="comment"]').filter({hasText: '# standalone note'});
  await comment.scrollIntoViewIfNeeded();
  const box = await comment.boundingBox();
  await page.mouse.click(box.x + 4, box.y + 4);

  await page.locator('[data-palette-block="assignment"]').click();

  await expect(page.locator('#modern-python-source')).toContainText('if outer:\n  value = 1\n  # standalone note');
});

test('manual modern Python playground keeps the opaque-recovery status visible after selecting a broken sample', async ({page}) => {
  // setValue() synchronously runs refresh() first, which already reports an
  // opaque-recovery issue for this sample - the sample-select handler's own
  // unconditional "Loaded..." status update immediately overwrote it. Match
  // refresh()'s own "Opaque recovery: <message>" prefix, not a bare
  // /Opaque recovery/: the sample is itself named "Opaque recovery", so
  // even the buggy generic "Loaded "Opaque recovery"." message contains
  // that substring and would pass a looser check either way.
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  await page.locator('#modern-python-sample').selectOption('Opaque recovery');

  await expect(page.locator('#modern-python-status')).toHaveText(/^Opaque recovery:/);
});

test('manual modern Python playground exposes an expandable print argument socket', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  await page.locator('[data-palette-block="print"]').click();
  await expect(page.locator('#modern-python-source')).toContainText('print()');

  const emptyArgument = await page.locator('.droplet-block-surface [data-droplet-kind="socket"]').evaluateAll((sockets) => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = sockets.find((candidate) => candidate.dataset.dropletFrom === candidate.dataset.dropletTo &&
      source.slice(Number(candidate.dataset.dropletFrom) - 6, Number(candidate.dataset.dropletFrom)) === 'print(');
    return socket ? {from: socket.dataset.dropletFrom, to: socket.dataset.dropletTo} : undefined;
  });
  expect(emptyArgument).toBeDefined();
  const socket = page.locator(`[data-droplet-kind="socket"][data-droplet-from="${emptyArgument.from}"][data-droplet-to="${emptyArgument.to}"]`);
  // print() lands below the default 1280x720 viewport's fold; a raw
  // page.mouse.click at its unscrolled coordinates hits nothing (unlike a
  // locator .click(), page.mouse.click does not scroll the target into view).
  await socket.scrollIntoViewIfNeeded();
  const box = await socket.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.droplet-socket-editor').fill('first, second');
  await page.locator('.droplet-socket-editor').press('Enter');

  await expect(page.locator('#modern-python-source')).toContainText('print(first, second)');
  // The sample already has statements named "first" and "second" elsewhere
  // (see the "Comments and nested suite" sample's "first = 1" and
  // "second = 2"), so matching by text alone also counts those pre-existing
  // sockets - only count ones at/after the print() argument list itself.
  await expect.poll(() => page.locator('.droplet-block-surface [data-droplet-kind="socket"]').evaluateAll((sockets, from) => {
    const source = document.querySelector('#modern-python-source').textContent;
    return sockets.filter((socket) => Number(socket.dataset.dropletFrom) >= from &&
      source.slice(Number(socket.dataset.dropletFrom), Number(socket.dataset.dropletTo)).match(/^(first|second)$/)).length;
  }, Number(emptyArgument.from))).toBe(2);
});

test('manual modern Python playground accepts a palette block drag at an insertion target', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  const [tailBox, dataTransfer] = await Promise.all([
    tail.boundingBox(), page.evaluateHandle(() => new DataTransfer())
  ]);
  const paletteBlock = page.locator('[data-palette-block="assignment"]');
  await paletteBlock.dispatchEvent('dragstart', {dataTransfer});
  const surface = page.locator('.droplet-block-surface svg');
  await surface.dispatchEvent('dragover', {dataTransfer, clientX: tailBox.x + 3, clientY: tailBox.y + 2});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await surface.dispatchEvent('drop', {dataTransfer, clientX: tailBox.x + 3, clientY: tailBox.y + 2});

  await expect(page.locator('#modern-python-source')).toContainText('  second = 2\n\nvalue = 1\ntail = 0');
});

test('manual modern Python playground deletes selected and off-canvas blocks', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  // "tail = 0" lands below the default 1280x720 viewport's fold; a raw
  // page.mouse.click at its unscrolled coordinates hits nothing (unlike a
  // locator .click(), page.mouse.click does not scroll the target into view).
  await tail.scrollIntoViewIfNeeded();
  const tailBox = await tail.boundingBox();
  await page.mouse.click(tailBox.x + 4, tailBox.y + 4);
  await page.keyboard.press('Delete');
  await expect(page.locator('#modern-python-source')).not.toContainText('tail = 0');

  const second = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'second = 2'}).first();
  await second.scrollIntoViewIfNeeded();
  const [secondBox, surfaceBox] = await Promise.all([
    second.boundingBox(), page.locator('.droplet-block-surface svg').boundingBox()
  ]);
  await page.mouse.move(secondBox.x + 4, secondBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + 12, secondBox.y + 12);
  await page.mouse.move(surfaceBox.x - 20, secondBox.y + 12, {steps: 8});
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).not.toContainText('second = 2');
});

test('manual modern Python playground copies a block with Ctrl-drag', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  const first = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'first = 1'}).first();
  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  // "tail = 0" lands below the default 1280x720 viewport's fold; a raw
  // page.mouse drag at its unscrolled coordinates cannot reach it (unlike a
  // locator .click(), raw mouse actions do not scroll the target into view).
  await tail.scrollIntoViewIfNeeded();
  const [firstBox, tailBox] = await Promise.all([first.boundingBox(), tail.boundingBox()]);

  await page.keyboard.down('Control');
  await page.mouse.move(firstBox.x + 4, firstBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 12, firstBox.y + 12);
  await page.mouse.move(tailBox.x + 4, tailBox.y + 2, {steps: 8});
  await page.mouse.up();
  await page.keyboard.up('Control');

  await expect(page.locator('#modern-python-source')).toContainText('  if ready:\n    first = 1  # inline note\n  second = 2\n\nfirst = 1\ntail = 0');
});

test('manual modern Python playground visibly outlines the selected block', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  // "tail = 0" lands below the default 1280x720 viewport's fold; a raw
  // page.mouse.click at its unscrolled coordinates hits nothing (unlike a
  // locator .click(), page.mouse.click does not scroll the target into view).
  await tail.scrollIntoViewIfNeeded();
  const box = await tail.boundingBox();
  await page.mouse.click(box.x + 4, box.y + 4);

  const selection = page.locator('.droplet-block-surface .droplet-block-selection');
  await expect(selection).toBeVisible();
  await expect(selection).toHaveAttribute('stroke', '#d97706');
  await expect(page.locator('.droplet-block-surface svg')).toHaveAttribute('data-droplet-selected-id', 'statement:Assign:85:93');
});

test('manual modern Python playground renders suite containers and blank-line placeholders', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);
  await expect(page.locator('.droplet-block-surface')).toBeVisible();
  await expect(page.locator('.droplet-block-surface [data-droplet-kind="container"]')).toHaveCount(2);
  await expect(page.locator('.droplet-block-surface [data-droplet-kind="whitespace"]')).toHaveCount(1);
  const outerContainer = page.locator('.droplet-block-surface [data-droplet-kind="container"]').first();
  // Every Python container header ends in ":", so renderContainerFrame's
  // isColonHeader check always renders it in the "snake" style - a green
  // stroke over a translucent fill, not the plain blue outline this
  // asserted before that style existed.
  await expect(outerContainer.locator('path').first()).toHaveAttribute('stroke', '#5f8a41');
  await expect(outerContainer.locator('path').first()).toHaveAttribute('fill', 'rgba(122, 163, 88, .12)');
  const containerBox = await outerContainer.boundingBox();
  expect(containerBox.width).toBeGreaterThan(40);
  expect(containerBox.height).toBeGreaterThan(30);
  const innerContainer = page.locator('.droplet-block-surface [data-droplet-kind="container"][data-droplet-from="32"]');
  const secondStatement = page.locator('.droplet-block-surface [data-droplet-kind="statement"][data-droplet-from="73"][data-droplet-to="83"]').first();
  const [innerBox, secondBox] = await Promise.all([innerContainer.boundingBox(), secondStatement.boundingBox()]);
  expect(innerBox.y + innerBox.height).toBeLessThanOrEqual(secondBox.y);
});

test('manual modern Python playground replaces a synthetic pass with a dropped outer statement', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const block = (text) => page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: text}).first();
  const first = block('first = 1');
  const second = block('second = 2');
  const firstBox = await first.boundingBox();
  await page.mouse.move(firstBox.x + 4, firstBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(firstBox.x + 12, firstBox.y + 12);
  const secondBox = await second.boundingBox();
  // This is the outer-scope gap immediately after `if ready:`. It differs
  // from moving below `second = 2` and must still round-trip through `pass`.
  await page.mouse.move(secondBox.x + 4, secondBox.y + 2, {steps: 8});
  await page.mouse.up();

  const pass = block('pass');
  const movedFirst = block('first = 1');
  const movedFirstBox = await movedFirst.boundingBox();
  await page.mouse.move(movedFirstBox.x + 4, movedFirstBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(movedFirstBox.x + 12, movedFirstBox.y + 12);
  const passBox = await pass.boundingBox();
  await page.mouse.move(passBox.x + 4, passBox.y + 4, {steps: 8});
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('  if ready:\n    first = 1  # inline note\n  second = 2');
});

test('manual modern Python playground accepts statement drops above a standalone comment', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const statement = page.locator('.droplet-block-surface [data-droplet-kind="statement"]');
  const second = statement.filter({hasText: 'second = 2'}).first();
  const comment = page.locator('.droplet-block-surface [data-droplet-kind="comment"]').filter({hasText: '# standalone note'});
  const [secondBox, commentBox] = await Promise.all([second.boundingBox(), comment.boundingBox()]);

  await page.mouse.move(secondBox.x + 4, secondBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + 12, secondBox.y + 12);
  // Use the row's right-hand gutter, rather than the comment rectangle.
  await page.mouse.move(commentBox.x + commentBox.width + 12, commentBox.y + 2, {steps: 8});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('if outer:\n  second = 2\n  # standalone note\n  if ready:');
});

test('manual modern Python playground accepts statement drops inside a container header', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  const ready = page.locator('.droplet-block-surface [data-droplet-kind="container"][data-droplet-from="32"]');
  // "tail = 0" lands below the default 1280x720 viewport's fold; a raw
  // page.mouse.down at its unscrolled coordinates never grabs it (unlike a
  // locator .click(), page.mouse.* does not scroll the target into view), so
  // the drag that follows never actually starts.
  await tail.scrollIntoViewIfNeeded();
  const [tailBox, readyBox] = await Promise.all([tail.boundingBox(), ready.boundingBox()]);

  await page.mouse.move(tailBox.x + 4, tailBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(tailBox.x + 12, tailBox.y + 12);
  // The SVG group's bounding box includes the whole C-shaped body. Target the
  // lower half of its 28px header line, not its footer.
  await page.mouse.move(readyBox.x + 4, readyBox.y + 22, {steps: 8});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('if outer:\n  # standalone note\n  if ready:\n    tail = 0\n    first = 1');
});

test('manual modern Python playground edits assignment target and value sockets', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const socketFor = async (text) => {
    const range = await page.evaluate((expected) => {
      const source = document.querySelector('#modern-python-source').textContent;
      const block = [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) => source.slice(
        Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)
      ) === expected);
      return {from: block.dataset.dropletFrom, to: block.dataset.dropletTo};
    }, text);
    return page.locator(`[data-droplet-kind="socket"][data-droplet-from="${range.from}"][data-droplet-to="${range.to}"]`);
  };
  const edit = async (socket, value, commit) => {
    const box = await socket.boundingBox();
    await page.mouse.click(box.x + 3, box.y + 3);
    const input = page.locator('.droplet-socket-editor');
    await input.fill(value);
    if (commit === 'blur') await input.evaluate((element) => element.blur());
    else await input.press('Enter');
  };

  await edit(await socketFor('first'), 'result', 'enter');
  await expect(page.locator('#modern-python-source')).toContainText('    result = 1  # inline note');
  await edit(await socketFor('1'), '2', 'blur');
  await expect(page.locator('#modern-python-source')).toContainText('    result = 2  # inline note');
  await edit(await socketFor('ready'), 'result > 0', 'enter');
  await expect(page.locator('#modern-python-source')).toContainText('  if result > 0:');
});

test('manual modern Python playground keeps an incomplete socket editable', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const range = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) => source.slice(
      Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)
    ) === '1');
    return {from: socket.dataset.dropletFrom, to: socket.dataset.dropletTo};
  });
  const value = page.locator(`[data-droplet-kind="socket"][data-droplet-from="${range.from}"][data-droplet-to="${range.to}"]`);
  const valueBox = await value.boundingBox();
  await page.mouse.click(valueBox.x + 3, valueBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('(');
  await page.locator('.droplet-socket-editor').press('Enter');

  await expect(page.locator('#modern-python-source')).toContainText('first = (  # inline note');
  const recovery = page.locator('[data-droplet-kind="recovery-socket"]');
  await expect(recovery).toBeVisible();
  await expect(page.locator('[data-droplet-kind="opaque-statement"]')).toHaveCount(0);

  const recoveryBox = await recovery.boundingBox();
  await page.mouse.click(recoveryBox.x + 3, recoveryBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('2');
  await page.locator('.droplet-socket-editor').press('Enter');
  await expect(page.locator('#modern-python-source')).toContainText('first = 2  # inline note');
  await expect(page.locator('[data-droplet-kind="recovery-socket"]')).toHaveCount(0);
});

test('manual modern Python playground keeps a newly inserted elif condition directly recoverable', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  await page.locator('[data-droplet-action="add-clause"][data-droplet-role="elif"]').first().click();
  await expect(page.locator('#modern-python-source')).toContainText('elif True:\n  pass');

  const condition = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) =>
      source.slice(Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)) === 'True');
    return {from: socket.dataset.dropletFrom, to: socket.dataset.dropletTo};
  });
  const socket = page.locator(`[data-droplet-kind="socket"][data-droplet-from="${condition.from}"][data-droplet-to="${condition.to}"]`);
  const box = await socket.boundingBox();
  await page.mouse.click(box.x + 3, box.y + 3);
  await page.locator('.droplet-socket-editor').fill('(');
  await page.locator('.droplet-socket-editor').press('Enter');
  const recovery = page.locator('[data-droplet-kind="recovery-socket"]');
  await expect(recovery).toBeVisible();

  const recoveryBox = await recovery.boundingBox();
  await page.mouse.click(recoveryBox.x + 3, recoveryBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('retry');
  await page.locator('.droplet-socket-editor').press('Enter');
  await expect(page.locator('#modern-python-source')).toContainText('elif retry:\n  pass');
  await expect(recovery).toHaveCount(0);
});

test('manual modern Python playground replaces a value socket by dragging an expression socket', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const ranges = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = (text) => [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) => source.slice(
      Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)
    ) === text);
    const range = (element) => ({from: element.dataset.dropletFrom, to: element.dataset.dropletTo});
    return {target: range(socket('first')), value: range(socket('1'))};
  });
  const socket = (range) => page.locator(
    `[data-droplet-kind="socket"][data-droplet-from="${range.from}"][data-droplet-to="${range.to}"]`
  );
  const [targetBox, valueBox] = await Promise.all([socket(ranges.target).boundingBox(), socket(ranges.value).boundingBox()]);
  await page.mouse.move(targetBox.x + 3, targetBox.y + 3);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 12, targetBox.y + 12);
  await page.mouse.move(valueBox.x + 3, valueBox.y + 3, {steps: 8});
  await expect(page.locator('.droplet-drop-preview')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('first = first  # inline note');
});

test('manual modern Python playground keeps an invalid assignment target editable', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const range = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) => source.slice(
      Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)
    ) === 'first');
    return {from: socket.dataset.dropletFrom, to: socket.dataset.dropletTo};
  });
  const target = page.locator(`[data-droplet-kind="socket"][data-droplet-from="${range.from}"][data-droplet-to="${range.to}"]`);
  const targetBox = await target.boundingBox();
  await page.mouse.click(targetBox.x + 3, targetBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('1');
  await page.locator('.droplet-socket-editor').press('Enter');

  await expect(page.locator('#modern-python-source')).toContainText('1 = 1  # inline note');
  const recovery = page.locator('[data-droplet-kind="recovery-socket"]');
  await expect(recovery).toBeVisible();
  const recoveryBox = await recovery.boundingBox();
  await page.mouse.click(recoveryBox.x + 3, recoveryBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('result');
  await page.locator('.droplet-socket-editor').press('Enter');

  await expect(page.locator('#modern-python-source')).toContainText('result = 1  # inline note');
  await expect(page.locator('[data-droplet-kind="recovery-socket"]')).toHaveCount(0);
});

test('manual modern Python playground accepts an expression drop onto a recovery socket', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const ranges = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    const socket = (text) => [...document.querySelectorAll('[data-droplet-kind="socket"]')].find((candidate) => source.slice(
      Number(candidate.dataset.dropletFrom), Number(candidate.dataset.dropletTo)
    ) === text);
    const range = (element) => ({from: element.dataset.dropletFrom, to: element.dataset.dropletTo});
    return {target: range(socket('first')), value: range(socket('1'))};
  });
  const socket = (range) => page.locator(
    `[data-droplet-kind="socket"][data-droplet-from="${range.from}"][data-droplet-to="${range.to}"]`
  );
  const valueBox = await socket(ranges.value).boundingBox();
  await page.mouse.click(valueBox.x + 3, valueBox.y + 3);
  await page.locator('.droplet-socket-editor').fill('(');
  await page.locator('.droplet-socket-editor').press('Enter');

  const recovery = page.locator('[data-droplet-kind="recovery-socket"]');
  await expect(recovery).toBeVisible();
  const [targetBox, recoveryBox] = await Promise.all([socket(ranges.target).boundingBox(), recovery.boundingBox()]);
  await page.mouse.move(targetBox.x + 3, targetBox.y + 3);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + 12, targetBox.y + 12);
  await page.mouse.move(recoveryBox.x + 3, recoveryBox.y + 3, {steps: 8});
  await expect(page.locator('.droplet-drop-preview')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('first = first  # inline note');
  await expect(page.locator('[data-droplet-kind="recovery-socket"]')).toHaveCount(0);
});

test('manual modern Python playground drops a statement at a container C-shape bottom', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const tail = page.locator('.droplet-block-surface [data-droplet-kind="statement"]').filter({hasText: 'tail = 0'}).first();
  const outer = page.locator('.droplet-block-surface [data-droplet-kind="container"][data-droplet-from="0"]');
  // "tail = 0" lands below the default 1280x720 viewport's fold; a raw
  // page.mouse.down at its unscrolled coordinates never grabs it (unlike a
  // locator .click(), page.mouse.* does not scroll the target into view).
  await tail.scrollIntoViewIfNeeded();
  const [tailBox, outerBox] = await Promise.all([tail.boundingBox(), outer.boundingBox()]);

  await page.mouse.move(tailBox.x + 4, tailBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(tailBox.x + 12, tailBox.y + 12);
  // The rendered group's bounding box spans the whole C-shaped container
  // (header, body, and footer together); its footer - the C-shape's own
  // bottom, the body-end drop target - sits in the last few pixels before
  // that box's own bottom edge.
  await page.mouse.move(outerBox.x + 28, outerBox.y + outerBox.height - 4, {steps: 10});
  await expect(page.locator('.droplet-drop-guide')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('#modern-python-source')).toContainText('  second = 2\n  tail = 0');
});

test('manual modern Python playground resolves a block hover to an insertion gap', async ({page}) => {
  await page.goto('/example/modern-python.html');
  await expect(page.locator('#modern-python-status')).toHaveText(/Ready/);

  const {nestedSuite, tail} = await page.evaluate(() => {
    const source = document.querySelector('#modern-python-source').textContent;
    // "if ready:" is itself a nested container, not a plain statement - it
    // renders with data-droplet-kind="container", not "statement".
    const blocks = [...document.querySelectorAll('[data-droplet-kind="statement"], [data-droplet-kind="container"]')];
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
    `[data-droplet-from="${from}"][data-droplet-to="${to}"]`
  ).first();
  const sourceBox = await block(nestedSuite).boundingBox();
  const targetBox = await block(tail).boundingBox();
  // The rendered group's bounding box spans the whole C-shaped container
  // (header, body, and footer together, as wide as its widest content) - its
  // own horizontal/vertical center lands inside a child (its own inline
  // comment, in this fixture) or past the header's own much narrower
  // rendered width, neither of which hit-tests to the container itself.
  // Grab it near its header's own left edge instead, matching the
  // container-header drop test above.
  await page.mouse.move(sourceBox.x + 4, sourceBox.y + 14);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 12, sourceBox.y + 22);
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
  await page.mouse.move(tailBox.x + tailBox.width - 2, tailBox.y + tailBox.height / 2, {steps: 10});
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
