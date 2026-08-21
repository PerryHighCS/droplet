import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySourceChanges,
  canMoveOpaque,
  createOpaqueProjection,
  getNodeText,
  isOpaque
} from '../src/index.js';

test('invalid source remains available as an exact opaque statement', () => {
  const source = 'if score >';
  const parsed = createOpaqueProjection(source, [{
    kind: 'opaque-statement',
    from: 0,
    to: source.length,
    movable: true,
    issue: {message: 'Expected an expression'}
  }]);
  const [node] = parsed.root.children;

  assert.equal(parsed.source, source);
  assert.equal(getNodeText(parsed, node), source);
  assert.equal(node.editable, false);
  assert.equal(isOpaque(node), true);
  assert.equal(canMoveOpaque(node), true);
  assert.deepEqual(parsed.issues, [{
    from: 0,
    to: source.length,
    message: 'Expected an expression',
    severity: 'error'
  }]);
});

test('opaque movement is explicit and unknown regions remain immovable', () => {
  const source = 'unknown()\nvalue +';
  const parsed = createOpaqueProjection(source, [
    {kind: 'opaque-expression', from: 0, to: 9, movable: true},
    {kind: 'opaque-region', from: 10, to: source.length, movable: true}
  ]);

  assert.equal(canMoveOpaque(parsed.root.children[0]), true);
  assert.equal(canMoveOpaque(parsed.root.children[1]), false);
});

test('a successful reparse replaces opaque nodes without changing source', () => {
  const source = 'if score > 10:\n    print(score)\n';
  const parsed = createOpaqueProjection(source);

  assert.equal(parsed.source, source);
  assert.deepEqual(parsed.root.children, []);
  assert.deepEqual(parsed.issues, []);
});

test('source changes are atomic and preserve unaffected lexical formatting', () => {
  const source = 'label = "keep spacing"  # comment\nvalue = 1\n';
  const changed = applySourceChanges(source, [{
    from: source.lastIndexOf('1'),
    to: source.lastIndexOf('1') + 1,
    insert: '2 + 3'
  }]);

  assert.equal(changed, 'label = "keep spacing"  # comment\nvalue = 2 + 3\n');
});

test('overlapping and out-of-bounds ranges are rejected', () => {
  assert.throws(
    () => createOpaqueProjection('abc', [
      {kind: 'opaque-expression', from: 0, to: 2},
      {kind: 'opaque-statement', from: 1, to: 3}
    ]),
    /must not overlap/
  );
  assert.throws(
    () => applySourceChanges('abc', [{from: 0, to: 4, insert: ''}]),
    /within the source snapshot/
  );
});
