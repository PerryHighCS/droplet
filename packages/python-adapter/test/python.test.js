import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePython} from '../src/index.js';

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
