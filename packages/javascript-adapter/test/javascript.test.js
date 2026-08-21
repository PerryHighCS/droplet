import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {applySourceChanges, parseWithOpaqueRecovery} from '@droplet/core';
import {parseJavaScript, transformJavaScript} from '../src/index.js';

test('projects the compatibility fixture without changing any source character', async () => {
  const source = await readFile(new URL('../../../test/data/javascript-compatibility.js', import.meta.url), 'utf8');
  const parsed = parseJavaScript(source);

  assert.equal(parsed.source, source);
  assert.equal(parsed.root.kind, 'document');
  assert.ok(parsed.root.children.some((node) => node.metadata.type === 'IfStatement'));
  assert.ok(parsed.root.children.some((node) => node.metadata.type === 'ForStatement'));
});

test('replaces only a known call argument socket', () => {
  const source = 'announce("total", total);\n';
  const parsed = parseJavaScript(source);
  const socket = findFirst(parsed.root, (node) =>
    node.kind === 'socket' && source.slice(node.from, node.to) === 'total');

  assert.ok(socket);
  assert.deepEqual(transformJavaScript({
    type: 'replace-socket', target: {from: socket.from, to: socket.to}, source: 'score + 1'
  }, parsed), [{from: socket.from, to: socket.to, insert: 'score + 1'}]);
  assert.throws(
    () => transformJavaScript({type: 'replace-socket', target: {from: 0, to: 1}, source: 'x'}, parsed),
    /Socket target/
  );
});

test('syntax errors retain their source location for opaque recovery', () => {
  const source = 'if (score >';
  const parsed = parseWithOpaqueRecovery(source, parseJavaScript);

  assert.equal(parsed.root.children[0].kind, 'opaque-statement');
  assert.equal(parsed.root.children[0].from, 0);
  assert.equal(parsed.root.children[0].to, source.length);
  assert.equal(parsed.issues[0].message.includes('Unexpected token'), true);
});

test('inserts and moves statements with source-range changes only', () => {
  const source = 'first();\nsecond();\n';
  const parsed = parseJavaScript(source);
  const [first, second] = parsed.root.children;
  const inserted = transformJavaScript({
    type: 'insert-statement',
    destination: {from: 0, to: 0},
    source: 'before();\n'
  }, parsed);
  assert.equal(applySourceChanges(source, inserted), 'before();\nfirst();\nsecond();\n');

  const moved = transformJavaScript({
    type: 'move-statement',
    source: {from: first.from, to: first.to},
    destination: {from: source.length, to: source.length}
  }, parsed);
  assert.equal(applySourceChanges(source, moved), '\nsecond();\nfirst();');
  assert.equal(source.slice(second.from, second.to), 'second();');

  const movedUpward = transformJavaScript({
    type: 'move-statement',
    source: {from: second.from, to: second.to},
    destination: {from: 0, to: 0}
  }, parsed);
  assert.deepEqual(movedUpward, [
    {from: 0, to: 0, insert: 'second();'},
    {from: second.from, to: second.to, insert: ''}
  ]);
});

function findFirst(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}
