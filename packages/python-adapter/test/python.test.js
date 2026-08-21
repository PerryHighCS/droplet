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

test('converts Brython syntax failures into opaque-source metadata', () => {
  assert.throws(() => parsePython('if score >', () => { throw new Error('invalid syntax'); }),
    (error) => error.from === 0 && error.to === 10 && error.opaqueKind === 'opaque-statement');
});
