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
    children: [{
      id: 'socket:call-argument:15:15', kind: 'socket', from: 15, to: 15, editable: true, children: [],
      metadata: {type: 'CallArgument', socketRole: 'call-argument', empty: true}
    }],
    metadata: {type: 'Call', socketRole: 'assignment-value'}
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
    {text: 'a', role: 'parameter'},
    {text: 'b', role: 'parameter'}
  ]);
});

test('sockets a function name even when it contains regex metacharacters', () => {
  // pythonToAST is caller-supplied (see parsePython's own doc comment), so
  // node.name is not guaranteed to be a plain identifier - interpolating it
  // straight into a RegExp used to either throw on an invalid pattern or
  // silently match the wrong span.
  const source = 'def a+b(c):\n  pass\n';
  const ast = {type: 'Module', body: [
    {type: 'FunctionDef', lineno: 1, col_offset: 0, end_lineno: 2, end_col_offset: 6, name: 'a+b',
      args: {lineno: 1, posonlyargs: [], args: [
        {type: 'arg', lineno: 1, col_offset: 8, end_lineno: 1, end_col_offset: 9, arg: 'c'}
      ], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: []},
      body: [{type: 'Pass', lineno: 2, col_offset: 2, end_lineno: 2, end_col_offset: 6}],
      decorator_list: []}
  ]};

  const kids = collectProjectedNodes(parsePython(source, () => ast).root)
    .filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(kids, [
    {text: 'a+b', role: 'name'},
    {text: 'c', role: 'parameter'}
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
    {text: 'first', role: 'call-argument'}
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
    [{text: 'first', role: 'call-argument', empty: undefined}, {text: 'second', role: 'call-argument', empty: undefined}]
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

test('projects an if/elif/else chain as its own branch clauses, not one merged body', () => {
  const source = 'if ready:\n  first()\nelif retry:\n  second()\nelse:\n  third()\n';
  const position = (offset) => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return {lineno: source.slice(0, offset).split('\n').length, col_offset: offset - lineStart};
  };
  const located = (type, from, to, extra = {}) => ({
    type, ...position(from), end_lineno: position(to).lineno, end_col_offset: position(to).col_offset, ...extra
  });
  const call = (name) => {
    const from = source.indexOf(`${name}()`);
    const to = from + name.length + 2;
    return located('Expr', from, to, {
      value: located('Call', from, to, {func: located('Name', from, from + name.length, {id: name}), args: []})
    });
  };
  const name = (text, from) => located('Name', from, from + text.length, {id: text});

  const elifFrom = source.indexOf('elif retry:');
  const elseFrom = source.indexOf('else:');
  const elifNode = located('If', elifFrom, source.length - 1, {
    test: name('retry', source.indexOf('retry')),
    body: [call('second')],
    orelse: [call('third')]
  });
  const ifNode = located('If', 0, source.length - 1, {
    test: name('ready', source.indexOf('ready')),
    body: [call('first')],
    orelse: [elifNode]
  });

  const statement = parsePython(source, () => ({type: 'Module', body: [ifNode]})).root.children[0];
  const clauses = statement.children.filter((child) => child.kind === 'clause')
    .sort((left, right) => left.from - right.from);

  assert.deepEqual(clauses.map((clause) => ({
    role: clause.metadata.clauseRole, header: source.slice(clause.from, clause.metadata.headerTo)
  })), [
    {role: 'elif', header: 'elif retry:'},
    {role: 'else', header: 'else:'}
  ]);
  const elifCondition = clauses[0].children.find((child) => child.kind === 'socket');
  assert.equal(source.slice(elifCondition.from, elifCondition.to), 'retry');
  assert.equal(elifCondition.metadata.socketRole, 'if-condition');
  assert.equal(source.slice(clauses[0].metadata.bodyFrom, clauses[0].metadata.bodyEnd).trim(), 'second()');
  assert.equal(clauses[1].children.some((child) => child.kind === 'socket'), false);
  assert.equal(source.slice(clauses[1].metadata.bodyFrom, clauses[1].metadata.bodyEnd).trim(), 'third()');
  // The primary if-body must not also carry the elif/else statements - the
  // generic located-child walk used to sweep orelse in as flat siblings.
  assert.deepEqual(statement.children.filter((child) => child.kind === 'statement')
    .map((child) => source.slice(child.from, child.to)), ['first()']);
});

test('does not treat a literal `else:` followed by a nested `if` as an elif branch', () => {
  const source = 'if ready:\n  first()\nelse:\n  if retry:\n    second()\n';
  const position = (offset) => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return {lineno: source.slice(0, offset).split('\n').length, col_offset: offset - lineStart};
  };
  const located = (type, from, to, extra = {}) => ({
    type, ...position(from), end_lineno: position(to).lineno, end_col_offset: position(to).col_offset, ...extra
  });
  const call = (name) => {
    const from = source.indexOf(`${name}()`);
    const to = from + name.length + 2;
    return located('Expr', from, to, {
      value: located('Call', from, to, {func: located('Name', from, from + name.length, {id: name}), args: []})
    });
  };
  const name = (text, from) => located('Name', from, from + text.length, {id: text});

  const nestedIfFrom = source.indexOf('if retry:');
  const nestedIf = located('If', nestedIfFrom, source.length - 1, {
    test: name('retry', source.indexOf('retry')),
    body: [call('second')],
    orelse: []
  });
  const ifNode = located('If', 0, source.length - 1, {
    test: name('ready', source.indexOf('ready')),
    body: [call('first')],
    orelse: [nestedIf]
  });

  const statement = parsePython(source, () => ({type: 'Module', body: [ifNode]})).root.children[0];
  const clauses = statement.children.filter((child) => child.kind === 'clause');
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].metadata.clauseRole, 'else');
  // The nested `if` is a real statement inside the else body, not folded
  // into the chain as another branch.
  const nestedStatement = clauses[0].children.find((child) => child.kind === 'statement');
  assert.equal(nestedStatement.metadata.type, 'If');
});

test('projects a for-loop else clause the same way as an if/else', () => {
  const source = 'for item in items:\n  use(item)\nelse:\n  finish()\n';
  const position = (offset) => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return {lineno: source.slice(0, offset).split('\n').length, col_offset: offset - lineStart};
  };
  const located = (type, from, to, extra = {}) => ({
    type, ...position(from), end_lineno: position(to).lineno, end_col_offset: position(to).col_offset, ...extra
  });
  const call = (name) => {
    const from = source.indexOf(`${name}(`);
    const to = source.indexOf(')', from) + 1;
    return located('Expr', from, to, {value: located('Call', from, to, {
      func: located('Name', from, from + name.length, {id: name}), args: []
    })});
  };

  const forFrom = 0;
  const forNode = located('For', forFrom, source.length - 1, {
    target: located('Name', source.indexOf('item'), source.indexOf('item') + 4, {id: 'item'}),
    iter: located('Name', source.indexOf('items'), source.indexOf('items') + 5, {id: 'items'}),
    body: [call('use')],
    orelse: [call('finish')]
  });

  const statement = parsePython(source, () => ({type: 'Module', body: [forNode]})).root.children[0];
  const clauses = statement.children.filter((child) => child.kind === 'clause');
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].metadata.clauseRole, 'else');
  assert.equal(source.slice(clauses[0].from, clauses[0].metadata.headerTo), 'else:');
  assert.equal(source.slice(clauses[0].metadata.bodyFrom, clauses[0].metadata.bodyEnd).trim(), 'finish()');
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

test('adds an elif branch with a default condition and empty suite', () => {
  const source = 'if ready:\n  pass\n';
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [],
    metadata: {type: 'If', blockRole: 'container', bodyFrom: source.indexOf('pass'), bodyEnd: source.length, bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython({type: 'add-clause', target: {from: 0, to: source.length}, role: 'elif'}, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nelif True:\n  pass\n');
});

test('adds an else branch after the last existing elif', () => {
  const source = 'if ready:\n  pass\nelif retry:\n  pass\n';
  const elifClause = {
    id: 'clause:elif', kind: 'clause', from: source.indexOf('elif retry:'), to: source.length, children: [],
    metadata: {
      clauseRole: 'elif', headerTo: source.indexOf('elif retry:') + 'elif retry:'.length,
      bodyFrom: source.lastIndexOf('pass'), bodyEnd: source.length, bodyIndentation: '  '
    }
  };
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [elifClause],
    metadata: {
      type: 'If', blockRole: 'container', bodyFrom: source.indexOf('pass'),
      bodyEnd: source.indexOf('elif retry:'), bodyIndentation: '  '
    }
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython({type: 'add-clause', target: {from: 0, to: source.length}, role: 'else'}, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nelif retry:\n  pass\nelse:\n  pass\n');
});

test('adds a new elif before an existing else, not after it', () => {
  const source = 'if ready:\n  pass\nelse:\n  pass\n';
  const elseFrom = source.indexOf('else:');
  const elseClause = {
    id: 'clause:else', kind: 'clause', from: elseFrom, to: source.length, children: [],
    metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '}
  };
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [elseClause],
    metadata: {type: 'If', blockRole: 'container', bodyFrom: source.indexOf('pass'), bodyEnd: elseFrom, bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython({type: 'add-clause', target: {from: 0, to: source.length}, role: 'elif'}, parsed, () => ({}));

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nelif True:\n  pass\nelse:\n  pass\n');
});

test('rejects adding a second else branch', () => {
  const source = 'if ready:\n  pass\nelse:\n  pass\n';
  const elseFrom = source.indexOf('else:');
  const elseClause = {
    id: 'clause:else', kind: 'clause', from: elseFrom, to: source.length, children: [],
    metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '}
  };
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [elseClause],
    metadata: {type: 'If', blockRole: 'container', bodyFrom: source.indexOf('pass'), bodyEnd: elseFrom, bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  assert.throws(() => transformPython(
    {type: 'add-clause', target: {from: 0, to: source.length}, role: 'else'}, parsed, () => ({})
  ), /already has an else branch/);
});

test('removes an elif branch, splicing out its header and body', () => {
  const source = 'if ready:\n  pass\nelif retry:\n  pass\nelse:\n  pass\n';
  const elifFrom = source.indexOf('elif retry:');
  const elseFrom = source.indexOf('else:');
  const elifClause = {
    id: 'clause:elif', kind: 'clause', from: elifFrom, to: elseFrom, children: [],
    metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:'.length, bodyEnd: elseFrom, bodyIndentation: '  '}
  };
  const elseClause = {
    id: 'clause:else', kind: 'clause', from: elseFrom, to: source.length, children: [],
    metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '}
  };
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [elifClause, elseClause],
    metadata: {type: 'If', blockRole: 'container', bodyEnd: elifFrom, bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'remove-clause', target: {from: elifClause.from, to: elifClause.to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\nelse:\n  pass\n');
});

test('removes the only elif branch, leaving a bare if', () => {
  const source = 'if ready:\n  pass\nelif retry:\n  pass\n';
  const elifFrom = source.indexOf('elif retry:');
  const elifClause = {
    id: 'clause:elif', kind: 'clause', from: elifFrom, to: source.length, children: [],
    metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:'.length, bodyEnd: source.length, bodyIndentation: '  '}
  };
  const statement = {
    id: 'statement:if', kind: 'statement', from: 0, to: source.length, children: [elifClause],
    metadata: {type: 'If', blockRole: 'container', bodyEnd: elifFrom, bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'remove-clause', target: {from: elifClause.from, to: elifClause.to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'if ready:\n  pass\n');
});

test('appends a new empty argument after existing call arguments', () => {
  const source = 'first(a)\n';
  const argSocket = {
    id: 'socket:a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, children: [],
    metadata: {type: 'Name', socketRole: 'call-argument'}
  };
  const callSocket = {
    id: 'socket:call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, children: [argSocket],
    metadata: {type: 'Call', socketRole: 'expression'}
  };
  const statement = {id: 'statement:call', kind: 'statement', from: 0, to: source.length, children: [callSocket]};
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'insert-sequence-item', target: {from: callSocket.from, to: callSocket.to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'first(a, )\n');
});

test('appends a new empty element to a list literal', () => {
  const source = 'items = [a]\n';
  const itemSocket = {
    id: 'socket:a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, children: [],
    metadata: {type: 'Name', socketRole: 'list-item'}
  };
  const listSocket = {
    id: 'socket:list', kind: 'socket', from: source.indexOf('['), to: source.indexOf(']') + 1, children: [itemSocket],
    metadata: {type: 'List', socketRole: 'assignment-value'}
  };
  const statement = {id: 'statement:assign', kind: 'statement', from: 0, to: source.length, children: [listSocket]};
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'insert-sequence-item', target: {from: listSocket.from, to: listSocket.to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'items = [a, ]\n');
});

test('"+" on an empty call/list/def is a no-op, not an invalid leading comma', () => {
  // A zero-item call/list/def already has a directly-editable synthetic
  // empty socket (see emptyCallArgumentSocket/emptyParameterSocket/
  // emptyListItemSocket) - splicing a leading "," in before any real item
  // exists produces invalid syntax (`print(, )`), since a call/parameter
  // list/list literal allows no leading elision.
  let source = 'first()\n';
  let callSocket = {
    id: 'socket:call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, children: [],
    metadata: {type: 'Call', socketRole: 'expression'}
  };
  let statement = {id: 'statement:call', kind: 'statement', from: 0, to: source.length, children: [callSocket]};
  let parsed = projection(source, [statement]);
  assert.deepEqual(transformPython(
    {type: 'insert-sequence-item', target: {from: callSocket.from, to: callSocket.to}}, parsed, () => ({})
  ), []);

  source = 'items = []\n';
  let listSocket = {
    id: 'socket:list', kind: 'socket', from: source.indexOf('['), to: source.indexOf(']') + 1, children: [],
    metadata: {type: 'List', socketRole: 'assignment-value'}
  };
  statement = {id: 'statement:assign', kind: 'statement', from: 0, to: source.length, children: [listSocket]};
  parsed = projection(source, [statement]);
  assert.deepEqual(transformPython(
    {type: 'insert-sequence-item', target: {from: listSocket.from, to: listSocket.to}}, parsed, () => ({})
  ), []);

  source = 'def f():\n  pass\n';
  statement = {id: 'statement:def', kind: 'statement', from: 0, to: source.length, children: [],
    metadata: {type: 'FunctionDef', blockRole: 'container', bodyIndentation: '  '}};
  parsed = projection(source, [statement]);
  assert.deepEqual(transformPython(
    {type: 'insert-sequence-item', target: {from: statement.from, to: statement.to}}, parsed, () => ({})
  ), []);
});

test('appends a new empty parameter to a function definition', () => {
  const source = 'def f(a, b):\n  pass\n';
  const paramA = {
    id: 'socket:a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, children: [],
    metadata: {type: 'arg', socketRole: 'parameter'}
  };
  const paramB = {
    id: 'socket:b', kind: 'socket', from: source.indexOf('b'), to: source.indexOf('b') + 1, children: [],
    metadata: {type: 'arg', socketRole: 'parameter'}
  };
  const statement = {
    id: 'statement:def', kind: 'statement', from: 0, to: source.length, children: [paramA, paramB],
    metadata: {type: 'FunctionDef', blockRole: 'container', bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'insert-sequence-item', target: {from: 0, to: source.length}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'def f(a, b, ):\n  pass\n');
});

test('adds a parameter to a compact single-line def whose body has its own nested call', () => {
  // insert-sequence-item's target search used the whole physical line for a
  // statement target, not just its own header - for a compact single-line
  // def (`def f(a): g()`), the line also contains the body, and a backward
  // search for ")" from the line's end found g()'s own closing paren (the
  // last one in the text) instead of f's own parameter list, corrupting the
  // wrong call entirely.
  const source = 'def f(a): g()\n';
  const paramA = {
    id: 'socket:a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, children: [],
    metadata: {type: 'arg', socketRole: 'parameter'}
  };
  const statement = {
    id: 'statement:def', kind: 'statement', from: 0, to: source.length - 1, children: [paramA],
    metadata: {type: 'FunctionDef', blockRole: 'container', bodyIndentation: '  '}
  };
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'insert-sequence-item', target: {from: 0, to: source.length - 1}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'def f(a, ): g()\n');
});

test('projects an editable trailing socket after "+" leaves a dangling "," behind a real call argument, parameter, or list item', () => {
  // addEmptyCallArgumentSocket/addEmptyParameterSocket/addEmptyListItemSocket
  // used to add their synthetic empty socket only when the sequence had zero
  // real items. Brython still reports the same real item count after "+"
  // splices a "," before the closing delimiter (the trailing "," is not
  // itself an item), so the gap it leaves behind had nothing typed into it -
  // and clicking "+" again would splice a second, invalid leading comma in
  // front of the last real item.
  const position = (source) => (offset) => {
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    return {lineno: source.slice(0, offset).split('\n').length, col_offset: offset - lineStart};
  };
  const located = (source) => (type, from, to, extra = {}) => {
    const pos = position(source);
    return {type, ...pos(from), end_lineno: pos(to).lineno, end_col_offset: pos(to).col_offset, ...extra};
  };

  const callSource = 'first(a, )\n';
  const at = located(callSource);
  const argA = at('Name', callSource.indexOf('a'), callSource.indexOf('a') + 1, {id: 'a'});
  const call = at('Call', 0, callSource.indexOf(')') + 1, {func: at('Name', 0, 5, {id: 'first'}), args: [argA]});
  const callExpr = at('Expr', 0, callSource.indexOf(')') + 1, {value: call});
  const callParsed = parsePython(callSource, () => ({type: 'Module', body: [callExpr]}));
  const trailingArgument = collectProjectedNodes(callParsed.root).find((node) => node.metadata?.socketRole === 'call-argument' && node.metadata?.empty);
  assert.ok(trailingArgument, 'a new editable call-argument socket must appear before the closing parenthesis');
  assert.equal(trailingArgument.from, callSource.indexOf(')'));

  const defSource = 'def f(a, ):\n  pass\n';
  const atDef = located(defSource);
  const paramA = atDef('arg', defSource.indexOf('a'), defSource.indexOf('a') + 1, {arg: 'a'});
  const passStatement = atDef('Pass', defSource.indexOf('pass'), defSource.indexOf('pass') + 4);
  const fn = atDef('FunctionDef', 0, defSource.indexOf('\n'), {
    name: 'f', args: {lineno: 1, posonlyargs: [], args: [paramA], kwonlyargs: []}, body: [passStatement], decorator_list: []
  });
  const defParsed = parsePython(defSource, () => ({type: 'Module', body: [fn]}));
  const trailingParameter = collectProjectedNodes(defParsed.root).find((node) => node.metadata?.socketRole === 'parameter' && node.metadata?.empty);
  assert.ok(trailingParameter, 'a new editable parameter socket must appear before the closing parenthesis');
  assert.equal(trailingParameter.from, defSource.indexOf(')'));

  const listSource = 'x = [a, ]\n';
  const atList = located(listSource);
  const elt = atList('Name', listSource.indexOf('a'), listSource.indexOf('a') + 1, {id: 'a'});
  const list = atList('List', listSource.indexOf('['), listSource.indexOf(']') + 1, {elts: [elt]});
  const assign = atList('Assign', 0, listSource.length - 1, {targets: [atList('Name', 0, 1, {id: 'x'})], value: list});
  const listParsed = parsePython(listSource, () => ({type: 'Module', body: [assign]}));
  const trailingItem = collectProjectedNodes(listParsed.root).find((node) => node.metadata?.socketRole === 'list-item' && node.metadata?.empty);
  assert.ok(trailingItem, 'a new editable list-item socket must appear before the closing bracket');
  assert.equal(trailingItem.from, listSource.indexOf(']'));
});

test('removes a middle call argument, splicing its own separating comma', () => {
  const source = 'first(a, b, c)\n';
  const args = ['a', 'b', 'c'].map((letter) => ({
    id: `socket:${letter}`, kind: 'socket', from: source.indexOf(letter, 5), to: source.indexOf(letter, 5) + 1,
    children: [], metadata: {type: 'Name', socketRole: 'call-argument'}
  }));
  const callSocket = {
    id: 'socket:call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, children: args,
    metadata: {type: 'Call', socketRole: 'expression'}
  };
  const statement = {id: 'statement:call', kind: 'statement', from: 0, to: source.length, children: [callSocket]};
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'remove-sequence-item', target: {from: args[1].from, to: args[1].to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'first(a, c)\n');
});

test('removes the last remaining call argument, leaving an empty call', () => {
  const source = 'first(a)\n';
  const argSocket = {
    id: 'socket:a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, children: [],
    metadata: {type: 'Name', socketRole: 'call-argument'}
  };
  const callSocket = {
    id: 'socket:call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, children: [argSocket],
    metadata: {type: 'Call', socketRole: 'expression'}
  };
  const statement = {id: 'statement:call', kind: 'statement', from: 0, to: source.length, children: [callSocket]};
  const parsed = projection(source, [statement]);

  const changes = transformPython(
    {type: 'remove-sequence-item', target: {from: argSocket.from, to: argSocket.to}}, parsed, () => ({})
  );

  assert.equal(applySourceChanges(source, changes), 'first()\n');
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
