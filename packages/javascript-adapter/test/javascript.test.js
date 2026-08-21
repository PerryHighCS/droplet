import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {parseWithOpaqueRecovery} from '@droplet/core';
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

function findFirst(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}
