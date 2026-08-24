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

test('appends after a document whose final line ends in a bare CR, without turning it into a CRLF', () => {
  // isAppendPastUnterminatedLine used to check only endsWith('\n') - a
  // document already terminated by a bare "\r" (physicalLines/lineStart's
  // own third supported line ending) was misclassified as unterminated,
  // taking the "prepend a \n" branch meant for a genuinely missing
  // terminator and silently turning the source's own trailing "\r" into a
  // "\r\n" pair it never had.
  const source = 'first();\r';
  const inserted = transformJavaScript({
    type: 'insert-statement',
    destination: {from: source.length, to: source.length},
    source: 'second();\n'
  }, parseJavaScript(source));
  assert.equal(applySourceChanges(source, inserted), 'first();\rsecond();\n');
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

test('projects an unbraced else branch as its own editable clause instead of dropping it', () => {
  // elseClause used to require a BlockStatement and return undefined
  // otherwise - a valid unbraced else ("else bar();") produced no clause at
  // all, and childNodes() unconditionally excludes `alternate` from the
  // ordinary recursive walk regardless of whether a clause was actually
  // built, so the branch was neither rendered nor independently editable
  // anywhere in the projection.
  const source = 'if (x) foo(); else bar();\n';
  const parsed = parseJavaScript(source);
  const clause = findFirst(parsed.root, (node) => node.kind === 'clause');

  assert.ok(clause, 'the unbraced else must still project as a clause');
  assert.equal(clause.metadata.clauseRole, 'else');
  assert.equal(source.slice(clause.from, clause.to), 'else bar();');
  assert.equal(clause.metadata.headerTo, source.indexOf('bar()'));
  assert.equal(clause.metadata.bodyEnd, source.indexOf('bar();') + 'bar();'.length);
  const body = findFirst({children: clause.children}, (node) => node.kind === 'statement');
  assert.ok(body, 'the unbraced branch\'s own statement must be an independent, editable child');
  assert.equal(source.slice(body.from, body.to), 'bar();');
});

test('projects an unbraced elif branch, and does not truncate the rest of the chain after it', () => {
  // ifClause had the same BlockStatement requirement for an "else if" body -
  // an unbraced elif not only vanished itself, ifClauses' own recursive call
  // only continues past a clause that successfully built, so it also
  // silently dropped every later branch in the chain (a subsequent elif or
  // else) from the projection too.
  const source = 'if (x) foo(); else if (y) bar(); else baz();\n';
  const parsed = parseJavaScript(source);
  const ifStatement = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'IfStatement');
  const clauses = ifStatement.children.filter((node) => node.kind === 'clause');

  assert.deepEqual(clauses.map((clause) => clause.metadata.clauseRole), ['elif', 'else']);
  assert.equal(source.slice(clauses[0].from, clauses[0].to), 'else if (y) bar();');
  assert.equal(source.slice(clauses[1].from, clauses[1].to), 'else baz();');
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

test('adds an argument to a bare call statement that is a one-statement document with no trailing newline', () => {
  // insert-sequence-item resolves its target with the shared findAny helper,
  // which used to check the passed-in node itself before its children -
  // for a one-statement document with no trailing newline, the document root
  // and the call statement it wraps share the exact same range, so this
  // resolved to the document instead of the statement. hasRealSequenceItem
  // then never found the statement's own call-argument socket (only its
  // direct 'expression'/'statement' children, not the document's own kind),
  // and the "+" button silently became a no-op.
  const source = 'f(a)';
  const parsed = parseJavaScript(source);
  const statement = findFirst(parsed.root, (node) => node.kind === 'statement');
  assert.equal(statement.from, parsed.root.from);
  assert.equal(statement.to, parsed.root.to);

  const changes = transformJavaScript({type: 'insert-sequence-item', target: {from: statement.from, to: statement.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'f(a, )');
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

test('finds the real opening parenthesis past a comment that contains one, for both a def and a call', () => {
  // A plain indexOf for the opening "(" could match one sitting inside a
  // comment between the name/callee and the real delimiter - and slicing
  // the source there to retokenize afterward then failed outright, since a
  // comment sliced mid-way no longer reads as one to the tokenizer.
  const withComment = parseJavaScript('function f/* ( */() {\n}\n').root.children[0];
  const emptyParameter = findFirst({children: withComment.children}, (node) =>
    node.metadata?.socketRole === 'parameter' && node.metadata?.empty);
  assert.ok(emptyParameter, 'the real "(" must still be found past the comment');
  assert.equal(emptyParameter.from, 'function f/* ( */('.length);

  const call = findFirst(parseJavaScript('f/* ( */();\n').root, (node) => node.metadata?.type === 'CallExpression');
  const emptyArgument = findFirst({children: call.children}, (node) =>
    node.metadata?.socketRole === 'call-argument' && node.metadata?.empty);
  assert.ok(emptyArgument, 'the real "(" must still be found past the comment');
  assert.equal(emptyArgument.from, 'f/* ( */('.length);
});

test('adds a parameter to a compact single-line function whose body has its own nested call', () => {
  // insert-sequence-item's target search used the whole physical line for a
  // statement target, not just its own header - for a compact single-line
  // function (`function f(a) { g(); }`), the line also contains the body,
  // and a backward search for ")" from the line's end found g()'s own
  // closing paren (the last one in the text) instead of f's own parameter
  // list, corrupting the wrong call entirely.
  const source = 'function f(a) { g(); }\n';
  const parsed = parseJavaScript(source);
  const fn = findFirst(parsed.root, (node) => node.metadata?.type === 'FunctionDeclaration');

  const changes = transformJavaScript({type: 'insert-sequence-item', target: {from: fn.from, to: fn.to}}, parsed);

  assert.equal(applySourceChanges(source, changes), 'function f(a, ) { g(); }\n');
});

test('adds an argument to a bare call statement with a trailing line comment containing ")"', () => {
  // A bare call-as-statement target with no metadata.headerTo fell back to
  // searching its whole physical line, not just its own range - a trailing
  // line comment sharing that line could contain its own ")" (unrelated to
  // the call), which a backward search from the line's end found first,
  // splicing the new item into the comment instead of the call itself.
  const source = 'f(a); // has a ") in it\n';
  const parsed = parseJavaScript(source);
  const target = findFirst(parsed.root, (node) => node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');

  const changes = transformJavaScript({type: 'insert-sequence-item', target: {from: target.from, to: target.to}}, parsed);

  assert.equal(applySourceChanges(source, changes), 'f(a, ); // has a ") in it\n');
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

test('removing the last call argument does not delete a trailing comment that belongs to the one before it', () => {
  // remove-sequence-item's last-item branch used to delete everything from
  // the *previous*, kept argument's own end through the removed item's own
  // end - a trailing line comment between them (visually attached to the
  // previous, surviving argument) was swept away along with the separating
  // comma and the removed item, even though it describes a() completely
  // untouched by this edit.
  const source = 'f(a, // keep a\n  b);\n';
  const parsed = parseJavaScript(source);
  const b = findFirst(parsed.root, (node) => node.kind === 'socket' && source.slice(node.from, node.to) === 'b');

  const changes = transformJavaScript({type: 'remove-sequence-item', target: {from: b.from, to: b.to}}, parsed);
  assert.equal(applySourceChanges(source, changes), 'f(a // keep a\n  );\n');
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

test('bounds a bare return\'s empty socket to its own statement, not a following statement\'s semicolon', () => {
  // A semicolon-free bare "return" relies on ASI - an unbounded search for
  // the next ";" would otherwise walk past this statement's own end and
  // attach the empty socket to whatever the next statement's own ";" is.
  const source = 'function f() {\n  return\n  next();\n}\n';
  const parsed = parseJavaScript(source);
  const returnStatement = findFirst(parsed.root, (node) => node.metadata?.type === 'ReturnStatement');
  const socket = findFirst({children: returnStatement.children}, (node) =>
    node.metadata?.socketRole === 'expression' && node.metadata?.empty);
  assert.ok(socket, 'the return statement should still get its own empty socket');
  assert.ok(socket.from <= returnStatement.to, 'the socket must stay within the return statement\'s own range');
  assert.equal(source.slice(0, socket.from), 'function f() {\n  return');
});

test('caps a compact single-line elif/else clause\'s header at its own opening brace', () => {
  // A clause's headerTo/bodyEnd used the whole physical line, which for a
  // compact single-line clause ("else if (y) { work(); }") runs past the
  // clause's own closing brace too - folding the body into the header text
  // and pointing bodyEnd back at the header's own line.
  const elifSource = 'if (x) {} else if (y) { work(); }\n';
  const elifStatement = findFirst(parseJavaScript(elifSource).root, (node) => node.kind === 'statement');
  const elifClause = elifStatement.children.find((child) => child.kind === 'clause');
  assert.equal(elifSource.slice(elifClause.from, elifClause.metadata.headerTo), 'else if (y) {');
  assert.equal(elifClause.metadata.bodyEnd, elifSource.indexOf('}', elifClause.from));

  const elseSource = 'if (x) {} else { work(); }\n';
  const elseStatement = findFirst(parseJavaScript(elseSource).root, (node) => node.kind === 'statement');
  const elseClause = elseStatement.children.find((child) => child.kind === 'clause');
  assert.equal(elseSource.slice(elseClause.from, elseClause.metadata.headerTo), 'else {');
  assert.equal(elseClause.metadata.bodyEnd, elseSource.indexOf('}', elseClause.from));
});

test('projects a for-of/for-in loop\'s own header operands as sockets, not a duplicated body statement', () => {
  // Without a socket role, ForOfStatement/ForInStatement's own `left`
  // (a VariableDeclaration) projected with its natural 'statement' kind,
  // sitting alongside the body's BlockStatement - structuralChildren's
  // single-BlockStatement flatten check then saw two statement children and
  // never flattened the body, rendering it as a second nested container
  // with the loop variable duplicated as its own spurious block above it.
  const ofSource = 'for (const x of list) {\n  console.log(x);\n}\n';
  const forOf = findFirst(parseJavaScript(ofSource).root, (node) => node.metadata?.type === 'ForOfStatement');
  assert.deepEqual(forOf.children.map((child) => child.kind), ['socket', 'socket', 'statement']);
  const [left, right, body] = forOf.children;
  assert.equal(ofSource.slice(left.from, left.to), 'const x');
  assert.equal(ofSource.slice(right.from, right.to), 'list');
  assert.equal(body.metadata?.type, 'BlockStatement');

  const inSource = 'for (const key in obj) {\n  x(key);\n}\n';
  const forIn = findFirst(parseJavaScript(inSource).root, (node) => node.metadata?.type === 'ForInStatement');
  assert.deepEqual(forIn.children.map((child) => child.kind), ['socket', 'socket', 'statement']);
});

test('caps an unbraced container\'s header before its own body, instead of consuming it too', () => {
  // Without a BlockStatement, headerTo fell back to the whole physical
  // line - for a valid unbraced body ("if (x) work();"), that line also
  // contains the body text childNodes/structuralChildren separately render
  // as its own nested statement, duplicating it: once folded into the
  // header, once as its own block.
  const ifSource = 'if (x) work();\n';
  const ifStatement = findFirst(parseJavaScript(ifSource).root, (node) => node.metadata?.type === 'IfStatement');
  assert.equal(ifSource.slice(ifStatement.from, ifStatement.metadata.headerTo).trimEnd(), 'if (x)');
  const consequent = findFirst({children: ifStatement.children}, (node) => node.kind === 'statement');
  assert.equal(ifSource.slice(consequent.from, consequent.to), 'work();');

  const whileSource = 'while (x) work();\n';
  const whileStatement = findFirst(parseJavaScript(whileSource).root, (node) => node.metadata?.type === 'WhileStatement');
  assert.equal(whileSource.slice(whileStatement.from, whileStatement.metadata.headerTo).trimEnd(), 'while (x)');
});

test('resolves a container\'s closing-brace line start in a bare-CR-only document', () => {
  // Two compounding bugs, both only visible with an indented closing brace
  // on its own line (bodyEnd's own single-line shortcut otherwise masks
  // them - an unindented brace already sits at its own line start, so the
  // buggy and correct positions coincide by accident): the single-line check
  // used a raw .includes('\n'), so a CR-only multi-line body was
  // misclassified as single-line and never reached lineStart at all; and
  // lineStart itself used a raw lastIndexOf('\n', ...), which - since no
  // "\n" exists anywhere in a CR-only document - always resolved to 0 (the
  // start of the whole document), not the closing brace's own line. Either
  // bug alone would splice a bodyEnd insertion at the wrong place.
  const source = 'if (x) {\r  a();\r  }\r';
  const statement = findFirst(parseJavaScript(source).root, (node) => node.metadata?.type === 'IfStatement');
  assert.equal(statement.metadata.bodyEnd, source.lastIndexOf('\r', source.lastIndexOf('}')) + 1);
  assert.notEqual(statement.metadata.bodyEnd, source.lastIndexOf('}'), 'must be the line start, not the brace\'s own position');
});

test('resolves an else clause\'s closing-brace line start in a bare-CR-only document', () => {
  // clauseHeaderMetadata's own single-line check used a raw .includes('\n'),
  // same bug as metadataFor's primary-container check already fixed above -
  // a CR-only multi-line else body was misclassified as single-line and
  // never reached lineStart's own CR-aware handling at all, splicing a
  // bodyEnd insertion at the closing brace itself instead of its line start.
  const source = 'if (x) {\r  a();\r} else {\r  b();\r  }\r';
  const elseClause = findFirst(parseJavaScript(source).root, (node) => node.metadata?.clauseRole === 'else');
  assert.equal(elseClause.metadata.bodyEnd, source.lastIndexOf('\r', source.lastIndexOf('}')) + 1);
  assert.notEqual(elseClause.metadata.bodyEnd, source.lastIndexOf('}'), 'must be the line start, not the brace\'s own position');
});

test('reindents every line of a relocated multi-line statement in a bare-CR-only document', () => {
  // reindentRelocatedText used a raw text.split('\n') - in a CR-only document
  // that never splits at all, so only the whole (single-element) text ever
  // received the destination's own indentation while every continuation
  // line - the body, the closing brace - kept its old absolute depth.
  const source = 'if (a) {\r  if (b) {\r    if (c) {\r      d();\r    }\r  }\r  y();\r}\r';
  const inner = findFirst(parseJavaScript(source).root, (node) =>
    node.metadata?.type === 'IfStatement' && node.from === source.indexOf('if (c)'));
  const yStatement = findFirst(parseJavaScript(source).root, (node) =>
    node.kind === 'statement' && node.from === source.indexOf('y()'));
  const destination = {from: yStatement.from, to: yStatement.from};

  const changes = transformJavaScript(
    {type: 'move-statement', source: {from: inner.from, to: inner.to}, destination}, parseJavaScript(source));
  assert.equal(
    applySourceChanges(source, changes),
    'if (a) {\r  if (b) {\r    \r  }\r  if (c) {\r    d();\r  }\r  y();\r}\r'
  );
});

test('indents a statement inserted before a container\'s first line in a bare-CR-only document', () => {
  // insertionIndentation used a raw lastIndexOf('\n', ...) too - in a
  // CR-only document this always resolved destination's own line to the
  // very start of the source, treating every insertion as if there were no
  // previous line to indent from (or bump past an opening brace on) at all.
  const source = 'if (x) {\r  first();\r}\r';
  const first = findFirst(parseJavaScript(source).root, (node) =>
    node.kind === 'statement' && node.metadata?.type === 'ExpressionStatement');
  const destination = {from: first.from, to: first.from};

  const inserted = transformJavaScript({type: 'insert-statement', destination, source: 'inserted();\r'}, parseJavaScript(source));
  assert.equal(applySourceChanges(source, inserted), 'if (x) {\r  inserted();\r  first();\r}\r');
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
