import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySourceChanges,
  canMoveOpaque,
  createOpaqueProjection,
  getNodeText,
  isOpaque,
  parseWithOpaqueRecovery
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

test('parser failures become opaque nodes and recover on the next successful parse', () => {
  const invalid = 'if score >';
  const parse = (source) => {
    if (source === invalid) {
      const error = new Error('Expected an expression');
      error.from = 0;
      error.to = source.length;
      error.opaqueKind = 'opaque-statement';
      error.movable = true;
      throw error;
    }
    return {
      source,
      root: {
        id: `document:0:${source.length}`,
        kind: 'document',
        from: 0,
        to: source.length,
        editable: false,
        children: [{
          id: 'statement:0', kind: 'statement', from: 0, to: source.length,
          editable: true, children: []
        }]
      },
      issues: []
    };
  };

  const opaque = parseWithOpaqueRecovery(invalid, parse);
  assert.equal(opaque.root.children[0].kind, 'opaque-statement');
  assert.equal(getNodeText(opaque, opaque.root.children[0]), invalid);

  const valid = 'if score > 10:\n    print(score)\n';
  const structured = parseWithOpaqueRecovery(valid, parse);
  assert.equal(structured.root.children[0].kind, 'statement');
  assert.equal(structured.source, valid);
});

test('an incomplete parser error range recovers the full source snapshot', () => {
  const source = 'if score >';
  const parse = () => {
    const error = new Error('Expected an expression');
    error.to = source.length;
    throw error;
  };

  const parsed = parseWithOpaqueRecovery(source, parse);
  const [node] = parsed.root.children;

  assert.equal(node.from, 0);
  assert.equal(node.to, source.length);
  assert.equal(getNodeText(parsed, node), source);
});

test('a broken parser cannot silently normalize source', () => {
  assert.throws(
    () => parseWithOpaqueRecovery('x = 1\n', () => ({source: 'x=1\n'})),
    /retain the input source snapshot/
  );
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
