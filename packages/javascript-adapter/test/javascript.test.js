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

test('identifies JavaScript containers and their header lines for structural rendering', () => {
  const source = 'for (let item of items) {\n  use(item);\n}\n';
  const loop = parseJavaScript(source).root.children[0];

  assert.deepEqual(loop.metadata, {
    type: 'ForOfStatement', blockRole: 'container', headerTo: source.indexOf('\n')
  });
  assert.ok(loop.children.some((node) => node.metadata.type === 'BlockStatement'));
});

test('projects blank and whitespace-only JavaScript lines for block layout', () => {
  const source = 'first();\n \t\n\nsecond();\n';
  const whitespace = collectNodes(parseJavaScript(source).root).filter((node) => node.kind === 'whitespace');

  assert.deepEqual(whitespace.map(({from, to, metadata}) => ({from, to, metadata})), [
    {from: 9, to: 12, metadata: {text: ' \t', lineEnding: '\n'}},
    {from: 12, to: 13, metadata: {text: '', lineEnding: '\n'}}
  ]);
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

test('labels JavaScript assignment sides and if conditions as distinct sockets', () => {
  const source = 'let target = value;\ntarget = next;\nif (ready) { run(); }\n';
  const sockets = collectNodes(parseJavaScript(source).root).filter((node) => node.kind === 'socket')
    .map((node) => ({text: source.slice(node.from, node.to), role: node.metadata.socketRole}));

  assert.deepEqual(sockets, [
    {text: 'target', role: 'assignment-target'},
    {text: 'value', role: 'assignment-value'},
    {text: 'target', role: 'assignment-target'},
    {text: 'next', role: 'assignment-value'},
    {text: 'ready', role: 'if-condition'}
  ]);
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

test('deletes a JavaScript statement through a source-range operation', () => {
  const source = 'first();\nsecond();\n';
  const [first] = parseJavaScript(source).root.children;

  const deleted = transformJavaScript({
    type: 'delete-node', source: {from: first.from, to: first.to}, kind: 'statement'
  }, parseJavaScript(source));

  assert.equal(applySourceChanges(source, deleted), '\nsecond();\n');
});

test('copies a JavaScript statement through a source-range operation', () => {
  const source = 'first();\nsecond();\n';
  const [first] = parseJavaScript(source).root.children;

  const copied = transformJavaScript({
    type: 'copy-node', source: {from: first.from, to: first.to}, kind: 'statement',
    destination: {from: source.length, to: source.length}
  }, parseJavaScript(source));

  assert.equal(applySourceChanges(source, copied), 'first();\nsecond();\nfirst();');
});

function findFirst(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function collectNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectNodes)];
}
