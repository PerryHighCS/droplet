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
    type: 'ForOfStatement', blockRole: 'container', headerTo: source.indexOf('\n'),
    bodyEnd: source.indexOf('}'), blockEnd: source.indexOf('}') + 1
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

test('a compact single-line container gets a header that stops at its opening brace, and a bodyEnd before its closing one', () => {
  // headerTo/bodyEnd both used physical-line boundaries, which coincide with
  // the opening/closing brace for the ordinary multi-line case - but for a
  // single-line container (`if (x) { work(); }`), the whole statement is one
  // physical line: headerTo swallowed the entire statement (rendering its
  // body twice, once as header text and once as a nested block), and
  // lineStart(bodyEnd) landed at the start of the document, well before the
  // body even begins.
  const source = 'if (x) { work(); }\n';
  const statement = parseJavaScript(source).root.children[0];

  assert.equal(statement.metadata.headerTo, source.indexOf('{') + 1);
  assert.equal(statement.metadata.bodyEnd, source.indexOf('}'));
});

test('a "before this statement" destination does not double or lose indentation', () => {
  // block-surface.js's insertionZones use an existing statement's own `from`
  // as a "before-sibling" destination - which, like any statement range here,
  // sits after that line's leading whitespace, not at column 0. Splicing
  // directly at that position would prepend a second indentation onto the
  // inserted text while leaving the original statement with none of its own.
  const source = 'if (x) {\n  first();\n  second();\n}\n';
  const secondStatement = findFirst(parseJavaScript(source).root, (node) =>
    node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement' && source.slice(node.from, node.to).startsWith('second'));
  const destination = {from: secondStatement.from, to: secondStatement.from};

  const inserted = transformJavaScript({type: 'insert-statement', destination, source: 'inserted();\n'}, parseJavaScript(source));
  assert.equal(applySourceChanges(source, inserted), 'if (x) {\n  first();\n  inserted();\n  second();\n}\n');

  const copied = transformJavaScript({
    type: 'copy-node', kind: 'statement', source: {from: 11, to: 19}, destination
  }, parseJavaScript(source));
  assert.equal(applySourceChanges(source, copied), 'if (x) {\n  first();\n  first();\n  second();\n}\n');

  const moved = transformJavaScript({
    type: 'move-statement', source: {from: 11, to: 19}, destination
  }, parseJavaScript(source));
  assert.equal(applySourceChanges(source, moved), 'if (x) {\n  \n  first();\n  second();\n}\n');
});

test('moving a nested multi-line statement to a shallower level reindents its body and closing brace', () => {
  // A relocated statement's continuation lines (its body, its closing brace)
  // already carry their own absolute indentation from wherever it used to
  // live. Stacking the destination's indentation on top of that used to keep
  // the old depth baked in alongside the new one.
  const source = 'function outer() {\n  if (true) {\n    doThing();\n    doOther();\n  }\n}\nfirst();\n';
  const parsed = parseJavaScript(source);
  const ifStatement = findFirst(parsed.root, (node) => node.metadata?.type === 'IfStatement');
  const firstStatement = findFirst(parsed.root, (node) =>
    node.metadata?.type === 'ExpressionStatement' && node.from > ifStatement.to);

  const moved = transformJavaScript({
    type: 'move-statement',
    source: {from: ifStatement.from, to: ifStatement.to},
    destination: {from: firstStatement.from, to: firstStatement.from}
  }, parsed);

  assert.equal(
    applySourceChanges(source, moved),
    'function outer() {\n  \n}\nif (true) {\n  doThing();\n  doOther();\n}\nfirst();\n'
  );
});

test('moving a statement with a multi-line template literal reindents code but leaves the raw string untouched', () => {
  // Reindenting every continuation line (see the previous test) is only
  // correct for structural source - a template literal's raw text carries
  // its own leading whitespace as part of the runtime string value, and
  // reindenting it the same way as code would silently change what the
  // moved statement actually returns.
  const source = 'if (x) {\n}\nconst s = `first\nraw`;\n';
  const parsed = parseJavaScript(source);
  const declaration = findFirst(parsed.root, (node) => node.metadata?.type === 'VariableDeclaration');
  const ifStatement = findFirst(parsed.root, (node) => node.metadata?.type === 'IfStatement');

  const moved = transformJavaScript({
    type: 'move-statement',
    source: {from: declaration.from, to: declaration.to},
    destination: {from: ifStatement.from + 'if (x) {\n'.length, to: ifStatement.from + 'if (x) {\n'.length}
  }, parsed);

  assert.equal(
    applySourceChanges(source, moved),
    'if (x) {\n  const s = `first\nraw`;\n}\n\n'
  );
});

test('appends past an unterminated final line instead of prepending to the start of the document', () => {
  // A body-end destination lands at source.length - for a document with no
  // trailing newline, normalizing that to its own line's start (as any
  // "before this statement" destination needs) resolved to position 0
  // instead, prepending the new statement rather than appending it.
  const noNewline = 'first();';
  const inserted = transformJavaScript({
    type: 'insert-statement',
    destination: {from: noNewline.length, to: noNewline.length},
    source: 'second();\n'
  }, parseJavaScript(noNewline));
  assert.equal(applySourceChanges(noNewline, inserted), 'first();\nsecond();\n');

  const multiline = 'first();\nsecond()';
  const parsed = parseJavaScript(multiline);
  const [first] = parsed.root.children;
  const moved = transformJavaScript({
    type: 'move-statement',
    source: {from: first.from, to: first.to},
    destination: {from: multiline.length, to: multiline.length}
  }, parsed);
  assert.equal(applySourceChanges(multiline, moved), '\nsecond()\nfirst();');
});

test('add-clause finds the body\'s real closing brace, not one inside a string', () => {
  // closingBraceEnd used to text-search for the first "}" at/after bodyEnd,
  // which also matches a "}" that happens to appear inside a string literal
  // in the body - splicing the new clause into the middle of that string
  // instead of after the block.
  const source = 'if (x) { s = "}"; }\n';
  const ifStatement = parseJavaScript(source).root.children[0];

  const changes = transformJavaScript({
    type: 'add-clause', target: {from: ifStatement.from, to: ifStatement.to}, role: 'else'
  }, parseJavaScript(source));

  assert.equal(applySourceChanges(source, changes), 'if (x) { s = "}"; } else {\n}\n');
});

test('an else clause is found by its real keyword token, not the first "else" text after a comment', () => {
  // A raw text search for "else" could match one inside a comment sitting
  // between the consequent's own closing brace and the real keyword,
  // landing the clause's own range on the comment instead - removing that
  // "clause" then deletes into the comment and leaves it unterminated.
  const source = 'if (x) {} /* else */ else {}\n';
  const clause = findFirst(parseJavaScript(source).root, (node) => node.kind === 'clause');

  assert.equal(source.slice(clause.from, clause.to), 'else {}');

  const changes = transformJavaScript({type: 'remove-clause', target: {from: clause.from, to: clause.to}}, parseJavaScript(source));
  assert.equal(applySourceChanges(source, changes), 'if (x) {} /* else */\n');
});

test('a blank line inside an else branch attaches to that clause, not the enclosing if', () => {
  const source = 'if (x) {\n  a();\n} else {\n  b();\n\n  c();\n}\n';
  const elseClause = findFirst(parseJavaScript(source).root, (node) => node.kind === 'clause');

  assert.ok(elseClause);
  assert.ok(elseClause.children.some((child) => child.kind === 'whitespace'));
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

test('adds an editable trailing socket even when a call argument is itself a nested call', () => {
  // emptySequenceSocket used to find the closing ")" with a plain indexOf,
  // which stops at the first one it sees - for f(g()), that is g()'s own
  // closing paren, not f's. The "," insert-sequence-item spliced in front of
  // it still happened to parse (a nested call's own close paren reads as
  // "the end of the previous argument" either way), but the empty socket it
  // should have projected right after was computed from that same wrong
  // position and never appeared.
  const source = 'f(g());\n';
  const parsed = parseJavaScript(source);
  const statement = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');
  const changes = transformJavaScript({type: 'insert-sequence-item', target: {from: statement.from, to: statement.to}}, parsed);
  const result = applySourceChanges(source, changes);
  assert.equal(result, 'f(g(), );\n');

  const reprojected = parseJavaScript(result);
  const trailingSocket = findFirst(reprojected.root, (node) =>
    node.kind === 'socket' && node.metadata?.socketRole === 'call-argument' && node.metadata?.empty && node.from === 7);
  assert.ok(trailingSocket, 'a new editable empty socket must appear right before the outer call\'s own closing paren');
});

test('does not attach an empty argument socket outside a parenless "new" expression\'s own range', () => {
  // A parenless `new Foo` is complete, valid JavaScript with no argument
  // list - the unbounded search for its own "(" used to walk straight past
  // it into whatever statement came next and attach a socket to that
  // statement's own "(" instead, well outside this node's own range.
  const source = 'new Foo;\nbar();\n';
  const parsed = parseJavaScript(source);
  const [newStatement, callStatement] = parsed.root.children;

  assert.deepEqual(newStatement.children.map((child) => child.kind), ['expression']);
  const callArgumentSockets = [];
  (function collect(node) {
    if (node.metadata?.socketRole === 'call-argument') callArgumentSockets.push(node);
    (node.children ?? []).forEach(collect);
  })(parsed.root);
  assert.equal(callArgumentSockets.length, 1, 'only bar()\'s own call-argument socket should exist');
  assert.ok(callArgumentSockets[0].from >= callStatement.from && callArgumentSockets[0].to <= callStatement.to);
});

test('"+" on an empty call/def is a no-op, not an invalid leading comma', () => {
  // A zero-item call/def already has a directly-editable synthetic empty
  // socket (see emptyCallArgumentSocket/emptyParameterSocket) - splicing a
  // leading "," in before any real item exists produced invalid syntax
  // (`print(, )`), since an argument/parameter list allows no leading
  // elision the way an array literal does.
  let source = 'print();\n';
  let parsed = parseJavaScript(source);
  let target = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');
  assert.deepEqual(transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed), []);

  source = 'function empty() {\n}\n';
  parsed = parseJavaScript(source);
  target = findFirst(parsed.root, (node) => node.metadata?.type === 'FunctionDeclaration');
  assert.deepEqual(transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed), []);

  source = 'x = f();\n';
  parsed = parseJavaScript(source);
  target = findFirst(parsed.root, (node) => node.kind === 'socket' && node.metadata?.type === 'CallExpression');
  assert.deepEqual(transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed), []);
});

test('a def or call with real parameters/arguments and no trailing "," gets no phantom empty socket', () => {
  // emptySequenceSocket matches "nothing between the last real item and the
  // closing )" - without requiring an actual "," there, `myFunction(n)`
  // would match too (nothing but the literal characters between "n" and ")"
  // is whitespace), producing a second, empty 'parameter' socket alongside
  // "n" before "+" is ever clicked.
  const source = 'function myFunction(n) {\n}\nmyFunction(n);\n';
  const sockets = collectNodes(parseJavaScript(source).root).filter((node) => node.kind === 'socket');

  const parameterSockets = sockets.filter((node) => node.metadata?.socketRole === 'parameter');
  const argumentSockets = sockets.filter((node) => node.metadata?.socketRole === 'call-argument');
  assert.equal(parameterSockets.length, 1);
  assert.equal(parameterSockets[0].metadata.empty, undefined);
  assert.equal(argumentSockets.length, 1);
  assert.equal(argumentSockets[0].metadata.empty, undefined);
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
    {from: 0, to: 0, insert: 'second();\n'},
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
