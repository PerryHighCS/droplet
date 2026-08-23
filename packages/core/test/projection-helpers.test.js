import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertInsertionPoint,
  assertOperationSource,
  assertParsedSource,
  compareProjectedNodes,
  findAny,
  findNode,
  findParent,
  findSocket,
  lineTextEnd,
  physicalLines
} from '../src/index.js';

function tree() {
  return {
    id: 'root', kind: 'document', from: 0, to: 20, children: [
      {id: 'statement', kind: 'statement', from: 0, to: 10, children: [
        {id: 'socket', kind: 'socket', from: 2, to: 5, children: []},
        {id: 'recovery', kind: 'recovery-socket', from: 6, to: 9, children: []}
      ]}
    ]
  };
}

test('findNode locates a node by exact kind and range, ignoring a kind mismatch', () => {
  const root = tree();
  assert.equal(findNode(root, {from: 0, to: 10}, 'statement')?.id, 'statement');
  assert.equal(findNode(root, {from: 2, to: 5}, 'statement'), undefined);
  assert.equal(findNode(root, {from: 0, to: 10}, 'statement'), root.children[0]);
});

test('findSocket locates a socket or recovery-socket, but not a statement', () => {
  const root = tree();
  assert.equal(findSocket(root, {from: 2, to: 5})?.id, 'socket');
  assert.equal(findSocket(root, {from: 6, to: 9})?.id, 'recovery');
  assert.equal(findSocket(root, {from: 0, to: 10}), undefined);
});

test('findAny locates any node at an exact range regardless of kind', () => {
  const root = tree();
  assert.equal(findAny(root, {from: 6, to: 9})?.id, 'recovery');
  assert.equal(findAny(root, {from: 0, to: 20})?.id, 'root');
  assert.equal(findAny(root, {from: 3, to: 4}), undefined);
});

test('findParent finds a node\'s direct parent by instance, not by matching range', () => {
  const root = tree();
  const statement = root.children[0];
  const socket = statement.children[0];
  assert.equal(findParent(root, socket), statement);
  assert.equal(findParent(root, statement), root);
  assert.equal(findParent(root, root), undefined);
});

test('compareProjectedNodes orders by position, then id, for equal-range ties', () => {
  const nodes = [
    {id: 'b', from: 5, to: 10},
    {id: 'a', from: 0, to: 3},
    {id: 'c', from: 0, to: 3}
  ];
  assert.deepEqual([...nodes].sort(compareProjectedNodes).map((node) => node.id), ['a', 'c', 'b']);
});

test('assertParsedSource rejects a missing source or root, naming the language', () => {
  assert.throws(() => assertParsedSource(undefined, 'JavaScript'), /current JavaScript projection/);
  assert.throws(() => assertParsedSource({source: 'x'}, 'Python'), /current Python projection/);
  assert.doesNotThrow(() => assertParsedSource({source: 'x', root: {}}, 'JavaScript'));
});

test('assertOperationSource requires a string, naming the operation in its error', () => {
  assert.throws(() => assertOperationSource(42, 'Socket replacement'), /Socket replacement source must be a string/);
  assert.doesNotThrow(() => assertOperationSource('x', 'Socket replacement'));
});

test('assertInsertionPoint requires a zero-width position within the source', () => {
  const source = '0123456789';
  assert.throws(() => assertInsertionPoint(source, {from: 3, to: 4}), RangeError);
  assert.throws(() => assertInsertionPoint(source, {from: -1, to: -1}), RangeError);
  assert.throws(() => assertInsertionPoint(source, {from: 11, to: 11}), RangeError);
  assert.doesNotThrow(() => assertInsertionPoint(source, {from: 5, to: 5}));
});

test('physicalLines splits source into lines that reconstruct it exactly, including a trailing unterminated line', () => {
  const source = 'first\r\nsecond\nthird';
  const lines = physicalLines(source);

  assert.deepEqual(lines, [
    {from: 0, to: 7, text: 'first', ending: '\r\n'},
    {from: 7, to: 14, text: 'second', ending: '\n'},
    {from: 14, to: 19, text: 'third', ending: ''}
  ]);
  assert.equal(lines.map((line) => line.text + line.ending).join(''), source);
});

test('lineTextEnd stops at the line ending, not the end of the source', () => {
  const source = 'first\nsecond';
  assert.equal(lineTextEnd(source, 0), 5);
  assert.equal(lineTextEnd(source, 6), source.length);
});
