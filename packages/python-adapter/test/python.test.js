import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPythonTrivia,
  createEmptyPythonSuite,
  transformPython,
  parsePython
} from '../src/index.js';
import {applySourceChanges} from '@droplet/core';

test('maps Brython line and column locations to exact source ranges', () => {
  const source = 'value = outer(1)\n';
  const ast = {type: 'Module', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: source.length - 1,
    body: [{type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: source.length - 1,
      value: {type: 'Call', lineno: 1, col_offset: 8, end_lineno: 1, end_col_offset: source.length - 1, args: []}}]};
  const parsed = parsePython(source, () => ast);
  assert.equal(parsed.source, source);
  assert.equal(parsed.root.children[0].kind, 'statement');
  assert.deepEqual(parsed.root.children[0].children[0], {
    id: 'socket:Call:8:16', kind: 'socket', from: 8, to: 16, editable: true,
    children: [], metadata: {type: 'Call', socketRole: 'assignment-value'}
  });
});

test('sockets a function\'s name and individual parameters instead of its whole header and body', () => {
  const source = 'def greet(a, b):\n  pass\n';
  // Brython's `arguments` node carries a lineno but no col_offset - it isn't
  // itself a source-range node, only its own args are. Reproduce that shape
  // exactly: treating it as located anyway previously fell back to the
  // enclosing statement's full range as one oversized "socket".
  const ast = {type: 'Module', body: [
    {type: 'FunctionDef', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 6, name: 'greet',
      args: {lineno: 1, posonlyargs: [], args: [
        {type: 'arg', lineno: 1, col_offset: 10, end_lineno: 1, end_col_offset: 11, arg: 'a'},
        {type: 'arg', lineno: 1, col_offset: 13, end_lineno: 1, end_col_offset: 14, arg: 'b'}
      ], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: []},
      body: [{type: 'Pass', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 6}],
      decorator_list: []}
  ]};

  const kids = collectProjectedNodes(parsePython(source, () => ast).root)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(kids, [
    {text: 'greet', role: 'name'},
    {text: 'a', role: 'expression'},
    {text: 'b', role: 'expression'}
  ]);
});

test('sockets a class\'s name without letting the class keyword itself be edited', () => {
  const source = 'class Widget:\n  pass\n';
  const ast = {type: 'Module', body: [
    {type: 'ClassDef', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 6, name: 'Widget',
      bases: [], keywords: [], body: [{type: 'Pass', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 6}],
      decorator_list: []}
  ]};

  const kids = collectProjectedNodes(parsePython(source, () => ast).root)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(kids, [{text: 'Widget', role: 'name'}]);
});

test('labels assignment targets, assignment values, and if conditions as distinct sockets', () => {
  const source = 'target = value\nif ready:\n  pass\n';
  const ast = {type: 'Module', body: [
    {type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 14,
      targets: [{type: 'Name', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 6}],
      value: {type: 'Name', lineno: 1, col_offset: 9, end_lineno: 1, end_col_offset: 14}},
    {type: 'If', lineno: 2, col_offset: 0, end_lineno: 3, end_col_offset: 6,
      test: {type: 'Name', lineno: 2, col_offset: 3, end_lineno: 2, end_col_offset: 8},
      body: [{type: 'Pass', lineno: 3, col_offset: 2, end_lineno: 3, end_col_offset: 6}]}
  ]};

  const sockets = parsePython(source, () => ast).root.children.flatMap((node) => node.children)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(sockets, [
    {text: 'target', role: 'assignment-target'},
    {text: 'value', role: 'assignment-value'},
    {text: 'ready', role: 'if-condition'}
  ]);
});

test('labels a unary operator\'s operand as an editable socket', () => {
  const source = 'value = not ready\n';
  const ast = {type: 'Module', body: [
    {type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 17,
      targets: [{type: 'Name', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 5}],
      value: {type: 'UnaryOp', lineno: 1, col_offset: 8, end_lineno: 1, end_col_offset: 17,
        op: {type: 'Not'},
        operand: {type: 'Name', lineno: 1, col_offset: 12, end_lineno: 1, end_col_offset: 17, id: 'ready'}}}
  ]};

  const sockets = collectProjectedNodes(parsePython(source, () => ast).root)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(sockets, [
    {text: 'value', role: 'assignment-target'},
    {text: 'not ready', role: 'assignment-value'},
    {text: 'ready', role: 'expression'}
  ]);
});

test('sockets a call\'s function name alongside its arguments, leaving the parentheses fixed', () => {
  const source = 'result = name(first)\n';
  const ast = {type: 'Module', body: [
    {type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 20,
      targets: [{type: 'Name', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 6}],
      value: {type: 'Call', lineno: 1, col_offset: 9, end_lineno: 1, end_col_offset: 20,
        func: {type: 'Name', lineno: 1, col_offset: 9, end_lineno: 1, end_col_offset: 13, id: 'name'},
        args: [{type: 'Name', lineno: 1, col_offset: 14, end_lineno: 1, end_col_offset: 19, id: 'first'}],
        keywords: []}}
  ]};

  const sockets = collectProjectedNodes(parsePython(source, () => ast).root)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(sockets, [
    {text: 'result', role: 'assignment-target'},
    {text: 'name(first)', role: 'assignment-value'},
    {text: 'name', role: 'call-target'},
    {text: 'first', role: 'expression'}
  ]);
});

test('projects a standalone print call as argument sockets, including an editable empty argument', () => {
  const source = 'print()\nprint(first, second)\n';
  const ast = {type: 'Module', body: [
    {type: 'Expr', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 7,
      value: {type: 'Call', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 7,
        func: {type: 'Name', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 5, id: 'print'}, args: []}},
    {type: 'Expr', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 20,
      value: {type: 'Call', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 20,
        func: {type: 'Name', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 5, id: 'print'}, args: [
          {type: 'Name', lineno: 2, col_offset: 6, end_lineno: 2, end_col_offset: 11, id: 'first'},
          {type: 'Name', lineno: 2, col_offset: 13, end_lineno: 2, end_col_offset: 19, id: 'second'}
        ]}}
  ]};

  const statements = parsePython(source, () => ast).root.children;
  const sockets = statements.map((statement) => collectProjectedNodes(statement)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole, empty: node.metadata.empty})));

  assert.deepEqual(sockets, [
    [{text: '', role: 'call-argument', empty: true}],
    [{text: 'first', role: 'expression', empty: undefined}, {text: 'second', role: 'expression', empty: undefined}]
  ]);
});

test('converts Brython syntax failures into an opaque source projection', () => {
  const parsed = parsePython('if score >', () => { throw new Error('invalid syntax'); });
  assert.deepEqual(parsed.root.children[0], {
    id: 'opaque-statement:0:10:0', kind: 'opaque-statement', from: 0, to: 10,
    editable: false, children: [], metadata: {movable: false}
  });
  assert.deepEqual(parsed.issues, [{
    from: 0, to: 10, message: 'invalid syntax', severity: 'error'
  }]);
});

test('falls back to the containing source boundary for invalid AST locations', () => {
  const source = 'pass\n';
  const ast = {type: 'Module', body: [{type: 'Pass', lineno: 9, col_offset: 0, end_lineno: 9, end_col_offset: 4}]};
  const parsed = parsePython(source, () => ast);
  assert.deepEqual(parsed.root.children[0], {
    id: 'statement:Pass:0:5', kind: 'statement', from: 0, to: 5, editable: true,
    children: [], metadata: {type: 'Pass'}
  });
});

test('keeps the document root over all source trivia', () => {
  const source = 'value = outer(1)\n';
  const ast = {type: 'Module', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: source.length - 1, body: []};
  const parsed = parsePython(source, () => ast);
  assert.deepEqual(parsed.root, {
    id: `document:Module:0:${source.length}`, kind: 'document', from: 0, to: source.length,
    editable: false, children: [], metadata: {type: 'Module'}
  });
});

test('expands decorated definitions to include their decorators', () => {
  const source = '@trace\ndef run():\n  pass\n';
  const ast = {type: 'Module', body: [{
    type: 'FunctionDef', lineno: 2, col_offset: 0, end_lineno: 3, end_col_offset: 6,
    decorator_list: [{type: 'Name', lineno: 1, col_offset: 1, end_lineno: 1, end_col_offset: 6}],
    body: []
  }]};

  const definition = parsePython(source, () => ast).root.children[0];
  assert.deepEqual({from: definition.from, to: definition.to}, {from: 0, to: source.length - 1});
  assert.deepEqual({from: definition.children[0].from, to: definition.children[0].to}, {from: 1, to: 6});
});

test('does not project Python type-ignore bookkeeping as source nodes', () => {
  const source = 'pass  # type: ignore\n';
  const ast = {type: 'Module', body: [{
    type: 'Pass', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 4
  }], type_ignores: [{lineno: 1, tag: ''}]};

  const parsed = parsePython(source, () => ast);
  assert.deepEqual(parsed.root.children.map((node) => node.metadata.type), ['Pass']);
});

test('contains partial and inverted child locations within their statement', () => {
  const source = 'first\nsecond\n';
  const ast = {type: 'Module', body: [
    {type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 5,
      value: {type: 'Call', lineno: 1, col_offset: 5, end_lineno: 1, end_col_offset: 1}},
    {type: 'Assign', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 6,
      value: {type: 'Call', lineno: 2, col_offset: 0}}
  ]};

  const statements = parsePython(source, () => ast).root.children;
  assert.deepEqual(statements.map(({from, to}) => ({from, to})), [
    {from: 0, to: 5}, {from: 6, to: 12}
  ]);
  assert.deepEqual(statements.map((node) => ({from: node.children[0].from, to: node.children[0].to})), [
    {from: 0, to: 5}, {from: 6, to: 12}
  ]);
});

test('contains child columns beyond their source line within their statement', () => {
  const source = 'pass\nnext\n';
  const ast = {type: 'Module', body: [
    {type: 'Expr', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 4,
      value: {type: 'Call', lineno: 1, col_offset: 100, end_lineno: 1, end_col_offset: 101}},
    {type: 'Expr', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 4}
  ]};

  const statements = parsePython(source, () => ast).root.children;
  assert.deepEqual(statements.map(({from, to}) => ({from, to})), [
    {from: 0, to: 4}, {from: 5, to: 9}
  ]);
  assert.deepEqual(statements[0].children[0], {
    id: 'socket:Call:0:4', kind: 'socket', from: 0, to: 4, editable: true,
    children: [], metadata: {type: 'Call', socketRole: 'expression'}
  });
});

test('uses the containing boundary when either AST endpoint is invalid', () => {
  const source = 'first\nsecond\n';
  const ast = {type: 'Module', body: [{
    type: 'Expr', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 5,
    values: [
      {type: 'Name', lineno: 9, col_offset: 0, end_lineno: 1, end_col_offset: 5},
      {type: 'Name', lineno: 1, col_offset: 0, end_lineno: 9, end_col_offset: 5}
    ]
  }]};

  assert.deepEqual(parsePython(source, () => ast).root.children[0].children.map(({from, to}) => ({from, to})), [
    {from: 0, to: 5}, {from: 0, to: 5}
  ]);
});

test('maps CR and CRLF physical lines for AST locations and comments', () => {
  const source = 'first\r# comment\r\npass\r';
  const ast = {type: 'Module', body: [{
    type: 'Pass', lineno: 3, col_offset: 0, end_lineno: 3, end_col_offset: 4
  }]};
  const tokens = [{type: 65, string: '# comment', lineno: 2, col_offset: 0, end_lineno: 2, end_col_offset: 9}];

  assert.deepEqual(parsePython(source, () => ast).root.children[0].from, 17);
  assert.deepEqual(parsePython(source, () => ast).root.children[0].to, 21);
  assert.deepEqual(collectPythonTrivia(source, () => tokens).comments, [
    {kind: 'comment', from: 6, to: 15, inline: false}
  ]);
});

test('uses raw source indentation while retaining inline and standalone comments', () => {
  const source = '# heading\nif value:\n\t# nested\n\tresult = value  # inline\n';
  const tokens = [
    {type: 65, string: '# heading', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 9},
    {type: 65, string: '# nested', lineno: 3, col_offset: 1, end_lineno: 3, end_col_offset: 9},
    {type: 5, string: '', lineno: 4, col_offset: 0, end_lineno: 4, end_col_offset: 8},
    {type: 65, string: '# inline', lineno: 4, col_offset: 17, end_lineno: 4, end_col_offset: 25}
  ];

  assert.deepEqual(collectPythonTrivia(source, () => tokens), {
    comments: [
      {kind: 'comment', from: 0, to: 9, inline: false},
      {kind: 'comment', from: 21, to: 29, inline: false},
      {kind: 'comment', from: 47, to: 55, inline: true}
    ],
    indentation: [{kind: 'indentation', from: 30, to: 31, text: '\t'}]
  });
});

test('retains form-feed indentation prefixes', () => {
  const source = '\f  result = 1\n';
  const tokens = [{type: 5, string: '', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 8}];
  assert.deepEqual(collectPythonTrivia(source, () => tokens).indentation, [
    {kind: 'indentation', from: 0, to: 3, text: '\f  '}
  ]);
});

test('projects tokenizer comments as independent movable nodes', () => {
  const source = 'if ready:\n  # note\n  pass\n';
  const ast = {type: 'Module', body: [{
    type: 'If', lineno: 1, col_offset: 0, end_lineno: 3, end_col_offset: 6,
    body: [{type: 'Pass', lineno: 3, col_offset: 2, end_lineno: 3, end_col_offset: 6}]
  }]};
  const tokenize = () => [{type: 65, string: '# note', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 8}];

  const parsed = parsePython(source, () => ast, tokenize);
  const comment = collectProjectedNodes(parsed.root).find((node) => node.kind === 'comment');
  assert.deepEqual(comment, {
    id: 'comment:12:18', kind: 'comment', from: 12, to: 18, editable: true, children: [],
    metadata: {inline: false}
  });
});

test('identifies Python suites and their header lines for structural rendering', () => {
  const source = 'for item in items:\n  use(item)\n';
  const ast = {type: 'Module', body: [{
    type: 'For', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 11,
    body: [{type: 'Expr', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 11}]
  }]};
  const loop = parsePython(source, () => ast).root.children[0];

  assert.deepEqual(loop.metadata, {
    type: 'For', blockRole: 'container', headerTo: source.indexOf('\n'),
    bodyFrom: source.indexOf('use(item)'), bodyEnd: source.length, bodyIndentation: '  '
  });
});

test('moves a statement to a container body end using the suite indentation', () => {
  const source = 'if ready:\n  first()\nnext()\n';
  const ast = {type: 'Module', body: [
    {type: 'If', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 9,
      body: [{type: 'Expr', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 9}]},
    {type: 'Expr', lineno: 3, col_offset: 0, end_lineno: 3, end_col_offset: 6}
  ]};
  const parsed = parsePython(source, () => ast);
  const [container, next] = parsed.root.children;

  const changes = transformPython({
    type: 'move-statement', source: {from: next.from, to: next.to},
    destination: {from: container.metadata.bodyEnd, to: container.metadata.bodyEnd,
      indentation: container.metadata.bodyIndentation}
  }, parsed, () => ast);
  assert.equal(applySourceChanges(source, changes), 'if ready:\n  first()\n  next()\n');
});

test('reindents a final nested statement when its outer-suite body end shares its range boundary', () => {
  const source = 'if outer:\n  if ready:\n    first()\n    second()\n';
  const first = {id: 'statement:first', kind: 'statement', from: 25, to: 32, children: []};
  const second = {id: 'statement:second', kind: 'statement', from: 37, to: 45, children: []};
  const parsed = projection(source, [{
    id: 'statement:outer', kind: 'statement', from: 0, to: source.length, children: [{
      id: 'statement:inner', kind: 'statement', from: 12, to: second.to, children: [first, second]
    }]
  }]);

  const changes = transformPython({
    type: 'move-statement', source: {from: second.from, to: second.to},
    destination: {from: second.to, to: second.to, indentation: '  '}
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if outer:\n  if ready:\n    first()\n  second()\n');
});

test('deindents a final nested statement when dropped at a root-level boundary', () => {
  const source = 'if ready:\n  second()\n';
  const second = {id: 'statement:second', kind: 'statement', from: 10, to: 20, children: []};
  const parsed = projection(source, [{id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [second]}]);

  const changes = transformPython({
    type: 'move-statement', source: {from: second.from, to: second.to},
    destination: {from: source.length, to: source.length, indentation: ''}
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\nsecond()\n');
});

test('moves the statement immediately after a synthetic pass into that suite', () => {
  const source = 'if ready:\n  pass\nfirst()\n';
  const pass = {id: 'statement:pass', kind: 'statement', from: 12, to: 16, metadata: {type: 'Pass'}, children: []};
  const first = {id: 'statement:first', kind: 'statement', from: 17, to: 24, children: []};
  const parsed = projection(source, [{
    id: 'statement:ready', kind: 'statement', from: 0, to: 17,
    metadata: {blockRole: 'container'}, children: [pass]
  }, first]);

  const changes = transformPython({
    type: 'move-statement', source: {from: first.from, to: first.to},
    destination: {from: 17, to: 17, emptySuitePass: {from: pass.from, to: pass.to}}
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  first()\n');
});

test('leaves an actual pass when moving the only Python suite statement out', () => {
  const source = 'if ready:\n  only()\nafter()\n';
  const ast = {type: 'Module', body: [
    {type: 'If', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 8,
      body: [{type: 'Expr', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 8}]},
    {type: 'Expr', lineno: 3, col_offset: 0, end_lineno: 3, end_col_offset: 7}
  ]};
  const parsed = parsePython(source, () => ast);
  const [, only, after] = collectProjectedNodes(parsed.root).filter((node) => node.kind === 'statement');

  const changes = transformPython({
    type: 'move-statement', source: {from: only.from, to: only.to},
    destination: {from: after.to + 1, to: after.to + 1}
  }, parsed, () => ast);
  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nafter()\nonly()\n');
});

test('fills a pass-only suite while retaining its comments and blank lines', () => {
  const source = 'if ready:\n  # explain the work\n  pass  # TODO\n\nnext()\n';
  const ast = {type: 'Module', body: [
    {type: 'If', lineno: 1, col_offset: 0, end_lineno: 3, end_col_offset: 6,
      body: [{type: 'Pass', lineno: 3, col_offset: 2, end_lineno: 3, end_col_offset: 6}]},
    {type: 'Expr', lineno: 5, col_offset: 0, end_lineno: 5, end_col_offset: 6}
  ]};
  const parsed = parsePython(source, () => ast);
  const [container, next] = parsed.root.children.filter((node) => node.kind === 'statement');
  const pass = container.children.find((node) => node.metadata?.type === 'Pass');

  const changes = transformPython({
    type: 'move-statement', source: {from: next.from, to: next.to},
    destination: {from: container.metadata.bodyEnd, to: container.metadata.bodyEnd,
      emptySuitePass: {from: pass.from, to: pass.to}}
  }, parsed, () => ast);
  assert.equal(applySourceChanges(source, changes), 'if ready:\n  # explain the work\n  next()  # TODO\n\n');
});

test('projects a blank Python suite line as a source-preserving whitespace node', () => {
  const source = 'if ready:\n  pass\n  \n';
  const ast = {type: 'Module', body: [{
    type: 'If', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 6,
    body: [{type: 'Pass', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 6}]
  }]};
  const whitespace = collectProjectedNodes(parsePython(source, () => ast).root)
    .find((node) => node.kind === 'whitespace');

  assert.deepEqual(whitespace, {
    id: 'whitespace:17:20', kind: 'whitespace', from: 17, to: 20, editable: false, children: [],
    metadata: {text: '  ', lineEnding: '\n'}
  });
});

test('moves an independent comment line without moving its containing statement', () => {
  const source = 'if ready:\n  # note\n  pass\nnext()\n';
  const ifStatement = {
    id: 'statement:if', kind: 'statement', from: 0, to: 25, children: [{
      id: 'comment:12:18', kind: 'comment', from: 12, to: 18, children: []
    }]
  };
  const parsed = projection(source, [ifStatement,
    {id: 'statement:next', kind: 'statement', from: 26, to: 32, children: []}
  ]);

  const changes = transformPython({
    type: 'move-comment', source: {from: 12, to: 18}, destination: {from: 26, to: 26}
  }, parsed, () => ({}));
  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\n# note\nnext()\n');
});

test('attaches a standalone comment to the end of a statement line', () => {
  const source = '# note\nvalue = 1\n';
  const parsed = projection(source, [
    {id: 'comment:0:6', kind: 'comment', from: 0, to: 6, children: [], metadata: {inline: false}},
    {id: 'statement:value', kind: 'statement', from: 7, to: 16, children: []}
  ]);

  const changes = transformPython({
    type: 'move-comment', source: {from: 0, to: 6},
    destination: {from: 7, to: 16}, placement: 'line-end'
  }, parsed, () => ({}));
  assert.equal(applySourceChanges(source, changes), 'value = 1  # note\n');
});

test('moves an inline comment without moving its statement text', () => {
  const source = 'first = 1  # note\nnext = 2\n';
  const parsed = projection(source, [
    {id: 'statement:first', kind: 'statement', from: 0, to: 17, children: []},
    {id: 'comment:11:17', kind: 'comment', from: 11, to: 17, children: [], metadata: {inline: true}},
    {id: 'statement:next', kind: 'statement', from: 18, to: 26, children: []}
  ]);

  const changes = transformPython({
    type: 'move-comment', source: {from: 11, to: 17}, destination: {from: 18, to: 18}
  }, parsed, () => ({}));
  assert.equal(applySourceChanges(source, changes), 'first = 1\n# note\nnext = 2\n');
});

test('classifies the complete modern Python statement set as statements', () => {
  const types = [
    'Assert', 'AsyncFor', 'AsyncFunctionDef', 'AsyncWith', 'ClassDef', 'Delete',
    'Global', 'Match', 'Nonlocal', 'Raise', 'Try', 'TryStar', 'TypeAlias', 'With'
  ];
  const source = 'pass\n';
  const ast = {
    type: 'Module',
    body: types.map((type) => ({
      type, lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 4
    }))
  };

  assert.deepEqual(parsePython(source, () => ast).root.children.map((node) => node.kind),
    types.map(() => 'statement'));
});

test('projects descendants of unlocated Brython argument and comprehension containers', () => {
  const source = 'def f(value=1):\n  return [item for item in values]\n';
  const position = (offset) => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return {lineno: source.slice(0, offset).split('\n').length, col_offset: offset - lineStart};
  };
  const located = (type, from, to, extra = {}) => ({type, ...position(from), end_lineno: position(to).lineno,
    end_col_offset: position(to).col_offset, ...extra});
  const ast = {type: 'Module', body: [located('FunctionDef', 0, source.length - 1, {
    args: {
      args: [located('arg', 6, 11)],
      defaults: [located('Constant', 12, 13)]
    },
    body: [located('Return', 16, source.length - 1, {
      value: located('ListComp', 25, source.length - 1, {
        elt: located('Name', 26, 30),
        generators: [{
          target: located('Name', 35, 39),
          iter: located('Name', 43, 49),
          ifs: []
        }]
      })
    })]
  })]};

  const projected = parsePython(source, () => ast);
  const descendants = collectProjectedNodes(projected.root);
  assert.deepEqual(
    descendants.filter((node) => ['arg', 'Constant', 'Name'].includes(node.metadata?.type))
      .map((node) => [node.metadata.type, node.kind, node.from, node.to]),
    [
      ['arg', 'socket', 6, 11], ['Constant', 'socket', 12, 13],
      ['Name', 'expression', 26, 30], ['Name', 'socket', 35, 39], ['Name', 'socket', 43, 49]
    ]
  );
});

test('orders projected children by source range instead of AST field order', () => {
  const source = 'abcdefghijklmnopqrst\n';
  const located = (type, from, to, extra = {}) => ({
    type, lineno: 1, col_offset: from, end_lineno: 1, end_col_offset: to, ...extra
  });
  const ast = {type: 'Module', body: [located('Expr', 0, 20, {
    value: located('Call', 0, 20, {
      args: [located('Name', 15, 20)],
      func: located('Name', 0, 2),
      keywords: [located('keyword', 3, 14, {value: located('Constant', 9, 14)})]
    })
  })]};

  const call = parsePython(source, () => ast).root.children[0].children[0];
  assert.deepEqual(call.children.map(({from, to}) => ({from, to})), [
    {from: 0, to: 2}, {from: 3, to: 14}, {from: 15, to: 20}
  ]);
});

test('inserts Python statements using the destination indentation without normalizing source', () => {
  const source = 'if ready:\n\tfirst = 1\n';
  const first = {id: 'statement:first', kind: 'statement', from: 11, to: 20, children: []};
  const parsed = projection(source, [first]);

  const changes = transformPython({
    type: 'insert-statement', destination: {from: first.from, to: first.from}, source: 'pass'
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n\tpass\n\tfirst = 1\n');
  assert.equal(createEmptyPythonSuite('\t'), '\tpass');
  assert.throws(() => createEmptyPythonSuite('  value'), /indentation/);
});

test('moves only Python statement lines and preserves comments, blanks, and local indentation', () => {
  const source = 'if ready:\n  first = 1  # retain\n  second = 2\n\n';
  const first = {id: 'statement:first', kind: 'statement', from: 12, to: 31, children: []};
  const second = {id: 'statement:second', kind: 'statement', from: 34, to: 44, children: []};
  const parsed = projection(source, [{
    id: 'statement:if', kind: 'statement', from: 0, to: 44, children: [first, second]
  }]);

  const changes = transformPython({
    type: 'move-statement', source: {from: second.from, to: second.to},
    destination: {from: first.from, to: first.from}
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  second = 2\n  first = 1  # retain\n\n');
});

test('deletes a Python statement line and leaves pass in an emptied suite', () => {
  const source = 'if ready:\n  first = 1\nnext = 2\n';
  const first = {id: 'statement:first', kind: 'statement', from: 12, to: 21, children: []};
  const parsed = projection(source, [
    {id: 'statement:if', kind: 'statement', from: 0, to: 21, children: [first],
      metadata: {blockRole: 'container', bodyFrom: 12, bodyEnd: 21}},
    {id: 'statement:next', kind: 'statement', from: 22, to: 30, children: []}
  ]);

  const changes = transformPython({
    type: 'delete-node', source: {from: first.from, to: first.to}, kind: 'statement'
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nnext = 2\n');
});

test('deletes an inline Python comment without deleting its statement', () => {
  const source = 'first = 1  # note\n';
  const comment = {id: 'comment:11', kind: 'comment', from: 11, to: 17, children: [], metadata: {inline: true}};
  const parsed = projection(source, [{id: 'statement:first', kind: 'statement', from: 0, to: 9, children: [comment]}]);

  const changes = transformPython({
    type: 'delete-node', source: {from: 11, to: 17}, kind: 'comment'
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'first = 1\n');
});

test('copies a Python statement with destination indentation', () => {
  const source = 'first = 1\nsecond = 2\n';
  const first = {id: 'statement:first', kind: 'statement', from: 0, to: 9, children: []};
  const parsed = projection(source, [first, {id: 'statement:second', kind: 'statement', from: 10, to: 20, children: []}]);

  const changes = transformPython({
    type: 'copy-node', source: {from: 0, to: 9}, kind: 'statement', destination: {from: source.length, to: source.length}
  }, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'first = 1\nsecond = 2\nfirst = 1');
});

test('rejects Python block changes that Brython cannot parse', () => {
  const source = 'value = 1\n';
  const socket = {id: 'socket:value', kind: 'socket', from: 8, to: 9, children: []};
  const parsed = projection(source, [{id: 'statement:assign', kind: 'statement', from: 0, to: 9, children: [socket]}]);

  assert.throws(() => transformPython({
    type: 'replace-socket', target: {from: 8, to: 9}, source: '('
  }, parsed, () => { throw new Error('invalid syntax'); }), /invalid source/);
});

function collectProjectedNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectProjectedNodes)];
}

function projection(source, children) {
  return {source, root: {id: 'document', kind: 'document', from: 0, to: source.length, children}};
}
