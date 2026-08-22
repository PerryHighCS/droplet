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
      .map((node) => [node.metadata.type, node.kind]),
    [['arg', 'socket'], ['Constant', 'socket'], ['Name', 'expression'], ['Name', 'socket'], ['Name', 'socket']]
  );
});

function collectProjectedNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectProjectedNodes)];
}
