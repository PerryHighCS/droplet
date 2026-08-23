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
    type: 'ForOfStatement', blockRole: 'container', headerTo: source.indexOf('\n'), bodyEnd: source.indexOf('}')
  });
  assert.ok(loop.children.some((node) => node.metadata.type === 'BlockStatement'));
});

test('a container\'s bodyEnd lands before its closing brace, not after it', () => {
  const source = 'if (ready) {\n}\n';
  const statement = parseJavaScript(source).root.children[0];

  // The layout engine falls back to a container's own end (node.to, after
  // the closing "}") when metadata.bodyEnd is absent - landing a block
  // dropped on the body-end insertion zone outside the container instead of
  // inside it as its last statement.
  assert.equal(statement.metadata.bodyEnd, source.indexOf('}'));
  assert.notEqual(statement.metadata.bodyEnd, statement.to);
});

test('inserting at bodyEnd does not corrupt an already-indented closing brace', () => {
  // The closing "}" here is indented (it is itself nested one level deep),
  // unlike the top-level, column-0 braces the other bodyEnd tests use. If
  // bodyEnd pointed at the brace itself rather than the start of its line, an
  // insert would land between the brace's own leading spaces and the brace,
  // corrupting both: the existing indentation would become a prefix of the
  // inserted line, and the brace would be left with none of its own.
  const source = 'if (x) {\n  while (true) {\n  }\n}\n';
  const parsed = parseJavaScript(source);
  const whileStatement = findFirst(parsed.root, (node) => node.metadata?.type === 'WhileStatement');

  const changes = transformJavaScript({
    type: 'insert-statement',
    destination: {from: whileStatement.metadata.bodyEnd, to: whileStatement.metadata.bodyEnd},
    source: 'value += 1;\n'
  }, parsed);

  assert.equal(
    applySourceChanges(source, changes),
    'if (x) {\n  while (true) {\n    value += 1;\n  }\n}\n'
  );
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

test('inserts and removes sequence items for a def, a call statement, and a nested call', () => {
  // A def's parameters and a call's own arguments (see childNodes/
  // socketRoleFor) both extend/shrink by splicing "," before the sequence's
  // own closing ")" - the exact position differs by context (a def/call
  // statement's own line vs. a call nested as a value's own end), which is
  // why all three are covered here, not just one.
  let source = 'function myFunction(n) {\n}\n';
  let parsed = parseJavaScript(source);
  let target = findFirst(parsed.root, (node) => node.metadata?.type === 'FunctionDeclaration');
  let changes = transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'function myFunction(n, ) {\n}\n');

  source = 'myFunction(n);\n';
  parsed = parseJavaScript(source);
  target = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');
  changes = transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'myFunction(n, );\n');

  source = 'return myFunction(n);\n';
  parsed = parseJavaScript(source);
  target = findFirst(parsed.root, (node) => node.kind === 'socket' && node.metadata?.type === 'CallExpression');
  changes = transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'return myFunction(n, );\n');

  source = 'myFunction(a, b, c);\n';
  parsed = parseJavaScript(source);
  const middle = findFirst(parsed.root, (node) => node.kind === 'socket' && source.slice(node.from, node.to) === 'b');
  changes = transformJavaScript({type: 'remove-sequence-item', target: {from: middle.from, to: middle.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'myFunction(a, c);\n');
});

test('the "," insert-sequence-item leaves behind still has an editable, removable slot', () => {
  // The "," itself is not a param/argument, so without this there would be
  // nothing new to click after "+", and removing the item that was there
  // *before* "+" was clicked would leave a dangling "," - `myFunction(, )` -
  // which is not valid JavaScript.
  let source = 'myFunction(n);\n';
  let parsed = parseJavaScript(source);
  const call = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');
  let changes = transformJavaScript({type: 'insert-sequence-item', target: {from: call.from, to: call.to}}, parsed);
  source = applySourceChanges(source, changes);
  assert.equal(source, 'myFunction(n, );\n');

  parsed = parseJavaScript(source);
  const emptySlot = findFirst(parsed.root, (node) => node.kind === 'socket' && node.metadata?.socketRole === 'call-argument' && node.metadata?.empty);
  assert.ok(emptySlot, 'expected an empty call-argument socket after the dangling ","');
  assert.equal(emptySlot.from, emptySlot.to);

  const originalArgument = findFirst(parsed.root, (node) => node.kind === 'socket' && source.slice(node.from, node.to) === 'n');
  changes = transformJavaScript({type: 'remove-sequence-item', target: {from: originalArgument.from, to: originalArgument.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'myFunction();\n');
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
    {text: 'ready', role: 'if-condition'},
    {text: 'run', role: 'call-target'},
    {text: '', role: 'call-argument'}
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
