import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPythonTrivia,
  parsePython
} from '../src/index.js';

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
    children: [], metadata: {type: 'Call'}
  });
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
    children: [], metadata: {type: 'Call'}
  });
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
  const located = (type, from, to, extra = {}) => ({
    type, lineno: 1, col_offset: from, end_lineno: 1, end_col_offset: to, ...extra
  });
  const ast = {type: 'Module', body: [located('FunctionDef', 0, 15, {
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
      .map((node) => [node.metadata.type, node.kind]).sort(),
    [['arg', 'socket'], ['Constant', 'socket'], ['Name', 'expression'], ['Name', 'socket'], ['Name', 'socket']].sort()
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

function collectProjectedNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectProjectedNodes)];
}
