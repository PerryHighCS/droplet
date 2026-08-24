import {
  applySourceChanges,
  assertInsertionPoint,
  assertOperationSource,
  assertParsedSource,
  compareProjectedNodes,
  findAny,
  findNode,
  findParent,
  findSocket,
  lineTextEnd,
  normalizeSourceChanges,
  parseWithOpaqueRecovery,
  physicalLines
} from '@droplet/core';

/** Creates a source-range Python parser from Brython's browser AST API. */
export function createBrythonPythonParser(pythonToAST, tokenize) {
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST is required');
  return (source) => parsePython(source, pythonToAST, tokenize);
}

export function parsePython(source, pythonToAST, tokenize) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST is required');
  return parseWithOpaqueRecovery(source, () => {
    let ast;
    try {
      ast = pythonToAST(source, 'droplet.py', 'file');
    } catch (error) {
      error.from = 0;
      error.to = source.length;
      error.opaqueKind = 'opaque-statement';
      throw error;
    }
    const lines = lineStarts(source);
    const root = project(ast, source, lines, 'document');
    if (tokenize) addCommentNodes(root, collectPythonTrivia(source, tokenize).comments);
    addWhitespaceNodes(root, source);
    return {source, root, issues: []};
  });
}

/** Binds Python source-range block transforms to Brython syntax validation. */
export function createBrythonPythonTransformer(pythonToAST) {
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST is required');
  return (operation, parsed) => transformPython(operation, parsed, pythonToAST);
}

/**
 * Returns minimal source changes for supported Python block intents.
 * Untouched source, including blank lines, comments, and indentation, remains
 * byte-for-byte intact.
 */
export function transformPython(operation, parsed, pythonToAST) {
  assertParsedSource(parsed, 'Python');
  let changes;
  switch (operation?.type) {
    case 'replace-socket': {
      assertOperationSource(operation.source, 'Socket replacement');
      const socket = findSocket(parsed.root, operation.target);
      if (!socket) throw new RangeError('Socket target is not present in the current projection');
      changes = [{from: socket.from, to: socket.to, insert: operation.source}];
      break;
    }
    case 'insert-statement': {
      assertOperationSource(operation.source, 'Statement insertion');
      assertInsertionPoint(parsed.source, operation.destination);
      const emptyPass = emptySuitePass(parsed, operation.destination);
      changes = emptyPass
        ? [replaceEmptySuitePass(parsed.source, emptyPass, operation.source)]
        : [insertStatementChange(parsed.source, operation.destination.from, operation.source, operation.destination.indentation)];
      break;
    }
    case 'move-statement': {
      const statement = findNode(parsed.root, operation.source, 'statement');
      if (!statement) throw new RangeError('Statement source is not present in the current projection');
      assertInsertionPoint(parsed.source, operation.destination);
      const emptyPass = emptySuitePass(parsed, operation.destination);
      if (emptyPass) {
        const statementRange = lineRange(parsed.source, statement);
        changes = moveStatementIntoEmptySuite(parsed.source, statementRange, emptyPass);
        break;
      }
      const statementRange = lineRange(parsed.source, statement);
      if (operation.destination.from >= statementRange.from && operation.destination.from <= statementRange.to) {
        const sourceIndentation = indentationAt(parsed.source, statementRange.from);
        // A container body-end can coincide with the end of its final child.
        // It is still a meaningful move when the target suite has a different
        // indentation: reindent the statement in place instead of treating it
        // as a no-op.
        if (operation.destination.indentation !== undefined &&
            operation.destination.indentation !== sourceIndentation) {
          changes = [{
            from: statementRange.from,
            to: statementRange.to,
            insert: `${operation.destination.indentation}${reindentPythonLines(
              parsed.source.slice(statementRange.from, statementRange.to),
              sourceIndentation, operation.destination.indentation
            )}`
          }];
          break;
        }
        return [];
      }
      const emptiedContainer = containerEmptiedByMove(parsed.root, statement);
      changes = moveLineRangeChanges(
        parsed.source, statementRange, operation.destination.from, operation.destination.indentation,
        emptiedContainer ? emptySuiteReplacement(parsed.source, statementRange) : ''
      );
      break;
    }
    case 'move-comment': {
      const comment = findNode(parsed.root, operation.source, 'comment');
      if (!comment) throw new RangeError('Comment source is not present in the current projection');
      if (operation.placement === 'line-end') {
        const statement = findNode(parsed.root, operation.destination, 'statement');
        if (!statement) throw new RangeError('Comment destination statement is not present in the current projection');
        changes = attachCommentToStatement(parsed.source, comment, statement);
        break;
      }
      assertInsertionPoint(parsed.source, operation.destination);
      const commentRange = comment.metadata?.inline ? inlineCommentRange(parsed.source, comment) :
        lineRange(parsed.source, comment);
      if (operation.destination.from >= commentRange.from && operation.destination.from <= commentRange.to) return [];
      changes = comment.metadata?.inline
        ? moveInlineCommentChanges(parsed.source, comment, commentRange, operation.destination.from, operation.destination.indentation)
        : moveLineRangeChanges(parsed.source, commentRange, operation.destination.from, operation.destination.indentation);
      break;
    }
    case 'copy-node': {
      const node = findNode(parsed.root, operation.source, operation.kind);
      if (!node || (node.kind !== 'statement' && node.kind !== 'comment')) {
        throw new RangeError('Copy source is not present in the current projection');
      }
      assertInsertionPoint(parsed.source, operation.destination);
      // A statement's own range (like any node here) excludes its first
      // line's leading indentation, but a multi-line body's continuation
      // lines keep their absolute indentation - slicing from node.from alone
      // would drop the first line's indentation while leaving the rest at
      // their old absolute depth, so a nested multi-line suite copied to a
      // different depth kept/added its old depth on top of the new one. This
      // only applies to a statement: a comment's own from already starts
      // exactly at its "#" (see collectPythonTrivia) - an inline comment's
      // own line also contains the code it trails, so normalizing to the
      // line start there would copy that code too, not just the comment.
      const copiedSource = node.kind === 'statement'
        ? parsed.source.slice(lineStartAt(parsed.source, node.from), node.to)
        : parsed.source.slice(node.from, node.to);
      // Only a statement's own emptySuitePass destination replaces the
      // placeholder "pass" outright - a comment can't stand alone as a
      // suite's only content, so copying one onto an empty suite must leave
      // the pass in place and insert the comment as its own line instead.
      const emptyPass = node.kind === 'statement' ? emptySuitePass(parsed, operation.destination) : undefined;
      changes = emptyPass
        ? [replaceEmptySuitePass(parsed.source, emptyPass, copiedSource)]
        : [insertStatementChange(parsed.source, operation.destination.from, copiedSource, operation.destination.indentation)];
      break;
    }
    case 'delete-node': {
      const node = findNode(parsed.root, operation.source, operation.kind);
      if (!node) throw new RangeError('Deletion source is not present in the current projection');
      if (node.kind === 'comment') {
        const commentRange = node.metadata?.inline ? inlineCommentRange(parsed.source, node) : lineRange(parsed.source, node);
        changes = [{from: commentRange.from, to: commentRange.to, insert: ''}];
        break;
      }
      if (node.kind !== 'statement') throw new RangeError('Only statements and comments can be deleted');
      const statementRange = lineRange(parsed.source, node);
      changes = [{
        from: statementRange.from,
        to: statementRange.to,
        insert: containerEmptiedByMove(parsed.root, node) ? emptySuiteReplacement(parsed.source, statementRange) : ''
      }];
      break;
    }
    case 'add-clause': {
      const statement = findNode(parsed.root, operation.target, 'statement');
      if (!statement) throw new RangeError('Clause target is not present in the current projection');
      if (operation.role !== 'elif' && operation.role !== 'else') throw new RangeError('Unsupported clause role');
      const clauses = (statement.children ?? []).filter((child) => child.kind === 'clause')
        .sort((left, right) => left.from - right.from);
      if (operation.role === 'else' && clauses.some((clause) => clause.metadata?.clauseRole === 'else')) {
        throw new RangeError('This statement already has an else branch');
      }
      // An elif is always inserted after the last existing elif (or right
      // after the primary body if there isn't one yet) - never after an
      // else, even if one already exists, so Python's elif-before-else
      // ordering holds without needing the caller to know that.
      const previousClause = operation.role === 'elif'
        ? clauses.filter((clause) => clause.metadata?.clauseRole === 'elif').at(-1)
        : clauses.at(-1);
      const insertAt = previousClause?.metadata?.bodyEnd ?? statement.metadata?.bodyEnd;
      if (!Number.isInteger(insertAt)) throw new RangeError('Clause target has no body to extend');
      const indentation = indentationAt(parsed.source, statement.from);
      const bodyIndentation = statement.metadata?.bodyIndentation ?? `${indentation}  `;
      const lineEnding = lineEndingAt(parsed.source, statement.to);
      const header = operation.role === 'elif' ? 'elif True:' : 'else:';
      changes = [{
        from: insertAt, to: insertAt,
        insert: `${indentation}${header}${lineEnding}${bodyIndentation}pass${lineEnding}`
      }];
      break;
    }
    case 'remove-clause': {
      const clause = findNode(parsed.root, operation.target, 'clause');
      if (!clause) throw new RangeError('Clause target is not present in the current projection');
      const from = lineStartAt(parsed.source, clause.from);
      const to = clause.metadata?.bodyEnd ?? clause.to;
      changes = [{from, to, insert: ''}];
      break;
    }
    case 'insert-sequence-item': {
      const target = findAny(parsed.root, operation.target);
      if (!target) throw new RangeError('Sequence target is not present in the current projection');
      // A synthetic empty socket (see emptyCallArgumentSocket/
      // emptyParameterSocket/emptyListItemSocket) already gives a zero-item
      // call/def/list a directly-editable first slot - splicing a leading
      // "," in before any real item exists produces invalid syntax
      // (`print(, )`), since a call/parameter/list allows no leading elision.
      // "+" is then a no-op: there is already somewhere to type the first item.
      if (!hasRealSequenceItem(target)) { changes = []; break; }
      const closeChar = target.metadata?.type === 'List' ? ']' : ')';
      // A def's own parameter list closes before its own colon-suite body
      // even starts - for a compact single-line def (`def f(a): g()`), the
      // physical line also contains the body, and a backward search for ")"
      // from the line's end could match a nested call's own closing paren
      // there instead of this sequence's own. Depth-tracking through the
      // def's own opening "(" finds its actual matching close regardless of
      // what the body (on the same line or not) contains. A bare call-as-
      // statement has no body to be confused with, but its own physical line
      // can still carry a trailing comment - searching to the line's end
      // (rather than the call's own target.to) could match a ")" inside that
      // comment instead of the call's real one (`f(a)  # )`).
      const isDef = target.kind === 'statement' &&
        (target.metadata?.type === 'FunctionDef' || target.metadata?.type === 'AsyncFunctionDef');
      const closingPosition = isDef
        ? matchingDelimiterEnd(parsed.source, parsed.source.indexOf('(', target.from), '(', ')')
        : parsed.source.lastIndexOf(closeChar, target.to - 1);
      if (closingPosition < target.from) throw new RangeError('Sequence target has no closing delimiter');
      changes = [{from: closingPosition, to: closingPosition, insert: ', '}];
      break;
    }
    case 'remove-sequence-item': {
      const item = findSocket(parsed.root, operation.target);
      if (!item) throw new RangeError('Sequence item is not present in the current projection');
      const parent = findParent(parsed.root, item);
      if (!parent) throw new RangeError('Sequence item has no enclosing node');
      const role = item.metadata?.socketRole;
      const siblings = (parent.children ?? [])
        .filter((child) => (child.kind === 'socket' || child.kind === 'recovery-socket') && child.metadata?.socketRole === role)
        .sort((left, right) => left.from - right.from);
      const index = siblings.findIndex((sibling) => sibling.from === item.from && sibling.to === item.to);
      const next = siblings[index + 1];
      const previous = siblings[index - 1];
      changes = next
        ? [{from: item.from, to: next.from, insert: ''}]
        : previous
          ? removeLastSequenceItem(parsed.source, previous, item)
          : [{from: item.from, to: item.to, insert: ''}];
      break;
    }
    default:
      throw new RangeError(`Unsupported Python block operation: ${operation?.type}`);
  }

  const normalizedChanges = normalizeSourceChanges(parsed.source, changes);
  const nextSource = applySourceChanges(parsed.source, normalizedChanges);
  if (pythonToAST !== undefined) assertValidPython(nextSource, pythonToAST);
  return normalizedChanges;
}

/** Returns a valid empty-suite statement using an exact indentation prefix. */
export function createEmptyPythonSuite(indentation = '') {
  if (!/^[\t \f]*$/.test(indentation)) throw new TypeError('Python indentation must contain only whitespace');
  return `${indentation}pass`;
}

/**
 * Collects lexical trivia without allowing Brython's visual tab columns to
 * rewrite source offsets. The tokenizer callback is normally
 * `window.__BRYTHON__.tokenizer`.
 */
export function collectPythonTrivia(source, tokenize, {indentTokenType = 5} = {}) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
  if (typeof tokenize !== 'function') throw new TypeError('Brython tokenizer is required');

  const starts = lineStarts(source);
  const comments = [];
  const indentation = [];
  for (const token of tokenize(source, 'droplet.py', 'file')) {
    if (typeof token?.string === 'string' && token.string.startsWith('#')) {
      const from = offset(token.lineno, token.col_offset, starts, source, 0);
      const to = offset(token.end_lineno, token.end_col_offset, starts, source, source.length);
      comments.push({kind: 'comment', from, to, inline: hasCodeBeforeComment(source, from)});
    }
    if (token?.type === indentTokenType && Number.isInteger(token.lineno)) {
      const lineStart = starts[token.lineno - 1];
      const text = leadingWhitespace(source, lineStart);
      if (text.length) indentation.push({kind: 'indentation', from: lineStart, to: lineStart + text.length, text});
    }
  }
  return {comments, indentation};
}

function project(node, source, lines, kind = kindFor(node), boundary = {from: 0, to: source.length}, socketRole) {
  const rawFrom = offset(node.lineno, node.col_offset, lines, source, null);
  const rawTo = offset(node.end_lineno, node.end_col_offset, lines, source, null);
  const range = kind === 'document' ? {from: 0, to: source.length} : rawFrom === null || rawTo === null
    ? boundary
    : boundedRange(rawFrom, rawTo, boundary);
  const statementRange = kind === 'statement' ? expandDecoratorRange(node, source, lines, range) : range;
  const {from, to} = statementRange;
  const children = childNodes(node).map((child) => project(
    child.node, source, lines, child.socketRole ? 'socket' : kindFor(child.node), statementRange, child.socketRole
  ));
  addEmptyCallArgumentSocket(children, node, source, rawFrom, rawTo, lines);
  addNameSocket(children, node, source, rawFrom ?? from);
  relabelParameterSockets(children, node, source, rawFrom ?? from);
  addEmptyParameterSocket(children, node, source, rawFrom, rawTo, lines);
  addEmptyListItemSocket(children, node, source, rawFrom, rawTo, lines);
  if (clauseChainTypes.has(typeOf(node))) children.push(...projectClauses(node, source, lines, statementRange));
  return {
    id: `${kind}:${typeOf(node)}:${from}:${to}`,
    kind, from, to, editable: kind !== 'document',
    children: children.sort(compareProjectedNodes),
    metadata: metadataFor(node, kind, source, rawFrom ?? from, socketRole)
  };
}

// Brython gives a def/class statement's own name as a bare string with no
// source location, unlike every other part of it, so it can never reach a
// socket through the normal located-child walk. A container should only let
// the user edit the parts they actually supplied (the name, the
// parameters), not the surrounding keyword/parenthesis/colon structure that
// makes it the statement kind it is - so find the name's exact range in its
// own header line and add it as a socket by hand.
function addNameSocket(children, node, source, from) {
  const type = typeOf(node);
  const keyword = type === 'ClassDef' ? 'class' : type === 'FunctionDef' || type === 'AsyncFunctionDef' ? 'def' : undefined;
  if (!keyword || typeof node.name !== 'string' || !node.name || from === null) return;
  // node.name comes from pythonToAST, a caller-supplied function (see
  // parsePython's own doc comment) - it is not guaranteed to be a plain
  // identifier, so it cannot be interpolated into a RegExp unescaped. The
  // name always follows the keyword on the header line, so a literal search
  // is both safer and cheaper than building a pattern from it.
  const header = source.slice(from, lineTextEnd(source, from));
  const keywordAt = header.indexOf(keyword);
  if (keywordAt === -1) return;
  const nameAt = header.indexOf(node.name, keywordAt + keyword.length);
  if (nameAt === -1) return;
  const nameFrom = from + nameAt;
  children.push({
    id: `socket:name:${nameFrom}:${nameFrom + node.name.length}`,
    kind: 'socket', from: nameFrom, to: nameFrom + node.name.length, editable: true, children: [],
    metadata: {type: 'Name', socketRole: 'name'}
  });
}

// A zero-argument call (print() included - it's a Call like any other) still
// needs one directly-editable slot to type a first argument into; without
// it there would be nothing to click. Read straight off the AST's own args
// list, not off the projected socket children - a zero-arg call already
// carries its own call-target (function name) socket, and depending on
// other sockets already existing would be fragile (see the parallel
// parameter case below, which hit exactly that bug).
function addEmptyCallArgumentSocket(children, node, source, from, to, lines) {
  if (typeOf(node) !== 'Call' || from === null || to === null) return;
  const closingParenthesis = source.lastIndexOf(')', to - 1);
  if (closingParenthesis < from) return;
  // "+" (insert-sequence-item) splices a "," before the closing parenthesis
  // when real arguments already exist - Brython still reports the same real
  // argument count for the result (the trailing "," is not itself an
  // argument), so without this check the gap it leaves behind would have
  // nothing typed into it, and clicking "+" again would splice a second,
  // invalid leading comma in front of the last real argument. A call's own
  // keyword arguments (f(a, b=1)) are a separate AST field from its
  // positional ones - the last real argument by position can be either.
  const lastArgumentEnd = lastLocatedEnd([
    ...(Array.isArray(node.args) ? node.args : []),
    ...(Array.isArray(node.keywords) ? node.keywords : [])
  ], source, lines);
  if (lastArgumentEnd !== null && !/^\s*,\s*$/.test(source.slice(lastArgumentEnd, closingParenthesis))) return;
  children.push({
    id: `socket:call-argument:${closingParenthesis}:${closingParenthesis}`,
    kind: 'socket', from: closingParenthesis, to: closingParenthesis, editable: true, children: [],
    metadata: {type: 'CallArgument', socketRole: 'call-argument', empty: true}
  });
}

// A def with zero parameters needs the same directly-editable empty slot,
// placed before the closing parenthesis - and, like a call's own arguments
// above, the same trailing-"," gap "+" leaves behind after a real parameter
// also needs one. Checked against the arguments node's own fields directly,
// not against relabelParameterSockets' output - that step depends on a name
// socket existing (needed to bound its own search), which a hand-built
// fixture can omit; this must not.
function addEmptyParameterSocket(children, node, source, from, to, lines) {
  const type = typeOf(node);
  if (type !== 'FunctionDef' && type !== 'AsyncFunctionDef') return;
  if (from === null || to === null) return;
  // A compact single-line def's own parameter list closes before its body
  // even starts (`def f(): g()`) - the physical line also contains the body,
  // and searching backward from the line's end for ")" could match a nested
  // call's own closing paren there instead of this def's own. Depth-tracking
  // through the def's own opening "(" finds its actual matching close
  // regardless of what a same-line body contains.
  const closingParenthesis = matchingDelimiterEnd(source, source.indexOf('(', from), '(', ')');
  if (closingParenthesis < from) return;
  const args = node.args ?? {};
  // A default value expression (def f(a, b=1)) sits further into the source
  // than its own parameter's name - the last real parameter by position can
  // be a default value, not just a bare name.
  const allParameters = [
    ...(Array.isArray(args.posonlyargs) ? args.posonlyargs : []),
    ...(Array.isArray(args.args) ? args.args : []),
    ...(Array.isArray(args.kwonlyargs) ? args.kwonlyargs : []),
    ...(Array.isArray(args.defaults) ? args.defaults : []),
    ...(Array.isArray(args.kw_defaults) ? args.kw_defaults : []),
    args.vararg, args.kwarg
  ];
  const lastParameterEnd = lastLocatedEnd(allParameters, source, lines);
  if (lastParameterEnd !== null && !/^\s*,\s*$/.test(source.slice(lastParameterEnd, closingParenthesis))) return;
  children.push({
    id: `socket:parameter:${closingParenthesis}:${closingParenthesis}`,
    kind: 'socket', from: closingParenthesis, to: closingParenthesis, editable: true, children: [],
    metadata: {type: 'arg', socketRole: 'parameter', empty: true}
  });
}

// An empty list literal (`[]`) needs the same treatment, placed just after
// the opening bracket - and, like a call's own arguments, so does the
// trailing-"," gap "+" leaves behind after a real item.
function addEmptyListItemSocket(children, node, source, from, to, lines) {
  if (typeOf(node) !== 'List' || from === null || to === null) return;
  const openingBracket = source.indexOf('[', from);
  if (openingBracket < 0 || openingBracket >= to) return;
  const lastItemEnd = lastLocatedEnd(node.elts, source, lines);
  if (lastItemEnd === null) {
    const position = openingBracket + 1;
    children.push({
      id: `socket:list-item:${position}:${position}`,
      kind: 'socket', from: position, to: position, editable: true, children: [],
      metadata: {type: 'Name', socketRole: 'list-item', empty: true}
    });
    return;
  }
  const closingBracket = source.lastIndexOf(']', to - 1);
  if (closingBracket < openingBracket || !/^\s*,\s*$/.test(source.slice(lastItemEnd, closingBracket))) return;
  children.push({
    id: `socket:list-item:${closingBracket}:${closingBracket}`,
    kind: 'socket', from: closingBracket, to: closingBracket, editable: true, children: [],
    metadata: {type: 'Name', socketRole: 'list-item', empty: true}
  });
}

// Depth-tracks matching delimiters (this file has no tokenizer to skip
// comments/strings with the way the JavaScript adapter's Acorn-based one
// does, so a delimiter character inside either would still be miscounted -
// an accepted limitation matching this file's existing plain-text scans
// elsewhere) to find where openPosition's own pair actually closes, not just
// the next occurrence of closeChar.
function matchingDelimiterEnd(source, openPosition, openChar, closeChar) {
  if (openPosition === -1) return -1;
  let depth = 0;
  for (let i = openPosition; i < source.length; i += 1) {
    if (source[i] === openChar) depth += 1;
    else if (source[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The furthest end position among a set of Brython AST nodes that are
// actually located (have their own lineno/col_offset) - used to find where a
// sequence's last real item ends, regardless of source/field order. Returns
// null when none are located, matching "there is nothing real here yet".
function lastLocatedEnd(nodes, source, lines) {
  let maxEnd = null;
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (!node || typeof node !== 'object' || !isLocatedNode(node)) continue;
    const end = offset(node.end_lineno, node.end_col_offset, lines, source, null);
    if (end !== null && (maxEnd === null || end > maxEnd)) maxEnd = end;
  }
  return maxEnd;
}

// Brython's parameter arg nodes are individually located, so they already
// reach a socket through the normal walk (via the 'args' key on the
// unlocated 'arguments' wrapper node, which isLocatedNode excludes,
// letting the walk continue into its own args/posonlyargs/kwonlyargs
// fields) - but with a generic 'expression' role indistinguishable from
// any other socket. Relabel them to 'parameter' so the sequence add/remove
// UI can find exactly the def's own parameter list.
function relabelParameterSockets(children, node, source, from) {
  const type = typeOf(node);
  if ((type !== 'FunctionDef' && type !== 'AsyncFunctionDef') || from === null) return;
  const nameSocket = children.find((child) => child.metadata?.socketRole === 'name');
  if (!nameSocket) return;
  const closingParenthesis = source.lastIndexOf(')', lineTextEnd(source, from));
  for (const child of children) {
    if (child.kind === 'socket' && child.metadata?.socketRole === 'expression' &&
        child.from >= nameSocket.to && child.to <= closingParenthesis) {
      child.metadata = {...child.metadata, socketRole: 'parameter'};
    }
  }
}

function metadataFor(node, kind, source, headerFrom, socketRole) {
  const metadata = {type: typeOf(node)};
  if (kind === 'socket') metadata.socketRole = socketRole ?? 'expression';
  if (kind === 'statement' && containerStatementTypes.has(typeOf(node))) {
    metadata.blockRole = 'container';
    metadata.headerTo = lineTextEnd(source, headerFrom);
    Object.assign(metadata, bodyMetadataFor(source, node.body));
  }
  return metadata;
}

// Shared by a container's own primary body and, separately, each elif/else
// clause's own body - both are "a list of statements with a start, an end,
// and possibly a single synthetic pass" and need the identical treatment.
function bodyMetadataFor(source, body) {
  const filtered = (body ?? []).filter((child) => child && typeof child === 'object');
  const first = filtered[0];
  const last = filtered.at(-1);
  const lines = lineStarts(source);
  const lastTo = offset(last?.end_lineno, last?.end_col_offset, lines, source, null);
  const firstFrom = offset(first?.lineno, first?.col_offset, lines, source, null);
  if (lastTo === null || firstFrom === null) return {};
  const metadata = {
    bodyFrom: firstFrom, bodyEnd: lineEndAfter(source, lastTo), bodyIndentation: indentationAt(source, firstFrom)
  };
  if (filtered.length === 1 && typeOf(first) === 'Pass') metadata.emptySuitePass = {from: firstFrom, to: lastTo};
  return metadata;
}

// Python's AST has no distinct "elif" node - `elif cond:` is a nested If
// inside the outer If's orelse, whose own lineno/col_offset point at the
// "elif" keyword itself. Distinguish that from a literal `else:\n  if...:`
// (a genuine nested statement, which must NOT be merged into this chain) by
// checking the actual source text at that position, not just the AST shape.
function projectClauses(node, source, lines, statementRange) {
  const orelse = (node.orelse ?? []).filter((child) => child && typeof child === 'object');
  if (!orelse.length) return [];
  if (typeOf(node) === 'If' && orelse.length === 1 && typeOf(orelse[0]) === 'If' && isElifText(orelse[0], source, lines)) {
    const inner = orelse[0];
    const clause = projectElifClause(inner, source, lines, statementRange);
    return clause ? [clause, ...projectClauses(inner, source, lines, statementRange)] : [];
  }
  const clause = projectElseClause(node, orelse, source, lines, statementRange);
  return clause ? [clause] : [];
}

function isElifText(node, source, lines) {
  const from = offset(node.lineno, node.col_offset, lines, source, null);
  return from !== null && source.slice(from, from + 4) === 'elif';
}

function projectElifClause(inner, source, lines, statementRange) {
  const from = offset(inner.lineno, inner.col_offset, lines, source, null);
  if (from === null) return undefined;
  const headerTo = lineTextEnd(source, from);
  const clauseRange = {from, to: statementRange.to};
  const conditionSocket = project(inner.test, source, lines, 'socket', clauseRange, 'if-condition');
  const body = (inner.body ?? []).filter((child) => child && typeof child === 'object');
  const bodyChildren = body.map((stmt) => project(stmt, source, lines, kindFor(stmt), clauseRange));
  const bodyMetadata = bodyMetadataFor(source, inner.body);
  const to = bodyMetadata.bodyEnd ?? headerTo;
  return {
    id: `clause:elif:${from}:${to}`,
    kind: 'clause', from, to, editable: true,
    children: [conditionSocket, ...bodyChildren],
    metadata: {clauseRole: 'elif', headerTo, ...bodyMetadata}
  };
}

function projectElseClause(node, orelse, source, lines, statementRange) {
  const previousBodyEnd = offset(
    node.body?.at(-1)?.end_lineno, node.body?.at(-1)?.end_col_offset, lines, source, null
  );
  const firstFrom = offset(orelse[0].lineno, orelse[0].col_offset, lines, source, null);
  if (previousBodyEnd === null || firstFrom === null) return undefined;
  const headerMatch = /^[\t \f]*(else)[\t \f]*:/m.exec(source.slice(previousBodyEnd, firstFrom));
  if (!headerMatch) return undefined;
  const from = previousBodyEnd + headerMatch.index + headerMatch[0].indexOf('else');
  const headerTo = lineTextEnd(source, from);
  const clauseRange = {from, to: statementRange.to};
  const bodyChildren = orelse.map((stmt) => project(stmt, source, lines, kindFor(stmt), clauseRange));
  const bodyMetadata = bodyMetadataFor(source, orelse);
  const to = bodyMetadata.bodyEnd ?? headerTo;
  return {
    id: `clause:else:${from}:${to}`,
    kind: 'clause', from, to, editable: true,
    children: bodyChildren,
    metadata: {clauseRole: 'else', headerTo, ...bodyMetadata}
  };
}

function addCommentNodes(root, comments) {
  for (const comment of comments) {
    const parent = triviaParent(root, comment);
    parent.children.push({
      id: `comment:${comment.from}:${comment.to}`,
      kind: 'comment', from: comment.from, to: comment.to, editable: true, children: [],
      metadata: {inline: comment.inline, commentPrefix: '#'}
    });
    parent.children.sort(compareProjectedNodes);
  }
}

function addWhitespaceNodes(root, source) {
  for (const line of physicalLines(source)) {
    if (!/^[\t \f]*$/.test(line.text)) continue;
    const parent = triviaParent(root, line);
    parent.children.push({
      id: `whitespace:${line.from}:${line.to}`,
      kind: 'whitespace', from: line.from, to: line.to, editable: false, children: [],
      metadata: {text: line.text, lineEnding: line.ending}
    });
    parent.children.sort(compareProjectedNodes);
  }
}

function triviaParent(node, range) {
  const child = (node.children ?? []).find((candidate) => (candidate.kind === 'statement' || candidate.kind === 'clause') &&
    candidate.from <= range.from && candidate.to >= range.to);
  return child ? triviaParent(child, range) : node;
}

function expandDecoratorRange(node, source, lines, range) {
  const decoratorFrom = (node.decorator_list ?? []).reduce((from, decorator) => {
    const offsetFrom = offset(decorator?.lineno, decorator?.col_offset, lines, source, -1);
    const lineStart = lines[(decorator?.lineno ?? 0) - 1];
    return offsetFrom < 0 || !Number.isInteger(lineStart) ? from : Math.min(from, lineStart);
  }, range.from);
  return decoratorFrom === range.from ? range : {from: decoratorFrom, to: range.to};
}

function insertStatementChange(source, destination, statementSource, explicitIndentation) {
  // A layout-supplied destination indentation is authoritative over the
  // physical line at `destination` - a container body-end destination is
  // often at EOF or at the next outer-scope line, where indentationAt reads
  // the wrong (often empty) depth entirely.
  const indentation = explicitIndentation ?? indentationAt(source, destination);
  const lineEnding = lineEndingAt(source, destination);
  const text = reindentPythonLines(statementSource, leadingWhitespace(statementSource, 0), indentation);
  if (destination === source.length) {
    const prefix = isLineStart(source, destination) ? indentation : lineEnding + indentation;
    return {from: destination, to: destination, insert: prefix + text};
  }
  return {from: destination, to: destination, insert: `${text}${ensureLineEnding(text, lineEnding)}${indentation}`};
}

function moveLineRangeChanges(source, statementRange, destination, destinationIndentation, removalInsert = '') {
  const sourceIndentation = indentationAt(source, statementRange.from);
  const targetIndentation = destinationIndentation ?? indentationAt(source, destination);
  if (!/^[\t \f]*$/.test(targetIndentation)) throw new TypeError('Destination indentation must contain only whitespace');
  const text = reindentPythonLines(source.slice(statementRange.from, statementRange.to), sourceIndentation, targetIndentation);
  const lineEnding = lineEndingAt(source, destination);
  const prefix = isLineStart(source, destination) ? targetIndentation : '';
  const insert = `${prefix}${text}${ensureLineEnding(text, lineEnding)}${targetIndentation}`;
  return [
    {from: statementRange.from, to: statementRange.to, insert: removalInsert},
    {from: destination, to: destination, insert}
  ];
}

function containerEmptiedByMove(root, statement) {
  const parent = findParent(root, statement);
  // A clause (an elif/else or for/while else branch) is just as much a
  // suite that needs a synthetic pass when its last statement leaves as an
  // ordinary container body is - it just isn't tagged blockRole:'container'
  // (that tag belongs to the whole if/for/while statement, not each branch).
  if (parent?.metadata?.blockRole !== 'container' && parent?.kind !== 'clause') return undefined;
  const bodyStatements = (parent.children ?? []).filter((child) => child.kind === 'statement' &&
    child.from >= parent.metadata.bodyFrom && child.to <= parent.metadata.bodyEnd);
  return bodyStatements.length === 1 && bodyStatements[0] === statement ? parent : undefined;
}

function emptySuiteReplacement(source, statementRange) {
  const indentation = indentationAt(source, statementRange.from);
  return `${indentation}pass${lineEndingAt(source, statementRange.to)}`;
}

function emptySuitePass(parsed, destination) {
  if (!destination?.emptySuitePass) return undefined;
  const pass = findNode(parsed.root, destination.emptySuitePass, 'statement');
  if (pass?.metadata?.type !== 'Pass') throw new RangeError('Empty suite pass is not present in the current projection');
  return pass;
}

function moveStatementIntoEmptySuite(source, statementRange, pass) {
  const passRange = lineRange(source, pass);
  // `passRange.to` includes the line ending. The next statement begins at
  // exactly that offset and is outside the pass, not already in the suite.
  if (statementRange.from >= passRange.from && statementRange.from < passRange.to) return [];
  const sourceIndentation = indentationAt(source, statementRange.from);
  const targetIndentation = indentationAt(source, passRange.from);
  const moved = reindentPythonLines(source.slice(statementRange.from, statementRange.to), sourceIndentation, targetIndentation);
  return [
    {from: statementRange.from, to: statementRange.to, insert: ''},
    {from: passRange.from, to: passRange.to, insert: appendPassComment(source, pass, `${targetIndentation}${moved}`)}
  ];
}

function replaceEmptySuitePass(source, pass, statementSource) {
  const passRange = lineRange(source, pass);
  const indentation = indentationAt(source, passRange.from);
  const statement = reindentPythonLines(statementSource, leadingWhitespace(statementSource, 0), indentation);
  return {from: passRange.from, to: passRange.to, insert: appendPassComment(source, pass, `${indentation}${statement}`)};
}

function appendPassComment(source, pass, statement) {
  const lineEnd = lineTextEnd(source, pass.to);
  const commentFrom = source.indexOf('#', pass.to);
  if (commentFrom < 0 || commentFrom >= lineEnd) return statement;
  const comment = source.slice(commentFrom, lineEnd);
  const firstEnding = /\r\n|\r|\n/.exec(statement);
  const at = firstEnding?.index ?? statement.length;
  return `${statement.slice(0, at)}  ${comment}${statement.slice(at)}`;
}

function lineRange(source, statement) {
  const from = lineStartAt(source, statement.from);
  let to = statement.to;
  while (to < source.length && source[to] !== '\r' && source[to] !== '\n') to += 1;
  if (source[to] === '\r' && source[to + 1] === '\n') to += 2;
  else if (source[to] === '\r' || source[to] === '\n') to += 1;
  return {from, to};
}

function attachCommentToStatement(source, comment, statement) {
  const removal = comment.metadata?.inline ? inlineCommentRange(source, comment) : lineRange(source, comment);
  const destination = lineTextEnd(source, statement.from);
  const text = source.slice(comment.from, comment.to);
  return [
    {from: removal.from, to: removal.to, insert: ''},
    {from: destination, to: destination, insert: `  ${text}`}
  ];
}

function lineEndAfter(source, position) {
  let end = lineTextEnd(source, position);
  if (source[end] === '\r' && source[end + 1] === '\n') return end + 2;
  return source[end] === '\r' || source[end] === '\n' ? end + 1 : end;
}

function inlineCommentRange(source, comment) {
  let from = comment.from;
  while (from > 0 && (source[from - 1] === ' ' || source[from - 1] === '\t')) from -= 1;
  return {from, to: comment.to};
}

function moveInlineCommentChanges(source, comment, commentRange, destination, explicitIndentation) {
  const insertion = insertStatementChange(source, destination, source.slice(comment.from, comment.to), explicitIndentation);
  return [
    {from: commentRange.from, to: commentRange.to, insert: ''},
    insertion
  ];
}

function reindentPythonLines(source, fromIndentation, toIndentation) {
  const protectedRanges = tripleQuotedStringRanges(source);
  let offset = 0;
  return source.split(/(\r\n|\r|\n)/).map((part, index) => {
    const partOffset = offset;
    offset += part.length;
    if (index % 2 === 1 || part === '') return part;
    // A continuation line whose start falls inside a triple-quoted string
    // (e.g. moving `s = """first\nraw"""` into a nested suite) is that
    // string's own raw content, not structural indentation - reindenting it
    // like any other line would change the runtime string value.
    if (index > 0 && protectedRanges.some((range) => partOffset >= range.from && partOffset < range.to)) return part;
    const content = part.startsWith(fromIndentation) ? part.slice(fromIndentation.length) : part;
    return index === 0 ? content : toIndentation + content;
  }).join('');
}

// This file has no tokenizer to identify string ranges precisely the way
// the JavaScript adapter's Acorn-based one does (an accepted limitation
// matching its other plain-text scans) - a paired-delimiter scan still
// protects the common case. A mismatched delimiter found while already
// inside a string of the other kind (a bare '"""' appearing literally
// inside a '''...''' string, or vice versa) is that string's own content,
// not a real delimiter, so it's only ever treated as one when no string is
// currently open.
function tripleQuotedStringRanges(text) {
  const ranges = [];
  const pattern = /'''|"""/g;
  let openStart = null;
  let openDelimiter = null;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    // A backslash immediately before the delimiter's own first quote
    // character escapes it - a literal quote, not a real delimiter attempt
    // - leaving only two bare quote characters right after it, which do not
    // by themselves open or close a triple-quoted string. Left unchecked,
    // this matched anyway, ending an open range early and leaving whatever
    // real string content follows (up to the actual closing delimiter,
    // possibly on a later line) unprotected from reindentation.
    if (isEscapedQuote(text, match.index)) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    if (openStart === null) {
      openStart = match.index;
      openDelimiter = match[0];
    } else if (match[0] === openDelimiter) {
      ranges.push({from: openStart, to: match.index + match[0].length});
      openStart = null;
      openDelimiter = null;
    }
  }
  return ranges;
}

// An even number of consecutive backslashes right before `index` means each
// escapes the next one (a literal backslash), leaving the character at
// `index` itself unescaped - only an odd count actually escapes it.
function isEscapedQuote(text, index) {
  let backslashes = 0;
  let cursor = index - 1;
  while (cursor >= 0 && text[cursor] === '\\') {
    backslashes += 1;
    cursor -= 1;
  }
  return backslashes % 2 === 1;
}

function ensureLineEnding(source, lineEnding) {
  return /(?:\r\n|\r|\n)$/.test(source) ? '' : lineEnding;
}

// A call/list's own argument/item sockets sit directly on the target found
// for a value-nested call/list (a compound socket) or a def's own parameter
// list - but a call used as a whole statement has no socket of its own to
// search from, only the Call/List node itself, one level down, as its sole
// child (see projectNode). findAny also prefers the outer of two nodes
// whose ranges happen to tie (checking the node itself before its
// children), so an ancestor transparently wrapping a single identically-
// ranged child is the same kind of pass-through. Descend through either,
// but not into an already-matched real item's own separate sequence.
function hasRealSequenceItem(node) {
  const direct = (node.children ?? []).some((child) => !child.metadata?.empty && isSequenceItemRole(child.metadata?.socketRole));
  if (direct) return true;
  const wrapper = (node.children ?? []).find((child) =>
    (child.kind === 'socket' && (child.metadata?.type === 'Call' || child.metadata?.type === 'List')) ||
    (child.from === node.from && child.to === node.to));
  return wrapper ? hasRealSequenceItem(wrapper) : false;
}

function isSequenceItemRole(role) {
  return role === 'call-argument' || role === 'parameter' || role === 'list-item';
}

// Removing the last remaining sequence item must not blindly delete
// everything from the *previous*, kept item's own end through this item's
// own end - that whole span can hold trivia (most commonly a trailing "#"
// comment, "f(a,  # keep a\n  b)") that belongs to the previous item, not to
// the one being removed. Only the separating "," itself is structurally tied
// to the removed item. When nothing but whitespace sits between the comma
// and the item, one contiguous deletion (matching a comma with no trivia
// after it) stays tidy; when a comment sits there, only the comma and the
// item's own text are removed as two disjoint changes, leaving the comment
// (and its own surrounding whitespace/indentation) completely alone.
function removeLastSequenceItem(source, previous, item) {
  const comma = commaAfter(source, previous.to);
  if (comma === -1) return [{from: item.from, to: item.to, insert: ''}];
  const commaEnd = comma + 1;
  if (/^\s*$/.test(source.slice(commaEnd, item.from))) {
    return [{from: previous.to, to: item.to, insert: ''}];
  }
  return [
    {from: previous.to, to: commaEnd, insert: ''},
    {from: item.from, to: item.to, insert: ''}
  ];
}

// This file has no tokenizer to skip trivia the way the JavaScript adapter's
// Acorn-based one does (see tripleQuotedStringRanges's own comment) - a
// plain indexOf for "," could match one sitting inside a "#" comment before
// the real separator instead, so any comment spans encountered first are
// skipped over line by line, the accepted text-only equivalent here.
function commaAfter(source, from) {
  let cursor = from;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === ',') return cursor;
    if (char === '#') {
      const lineEnd = source.indexOf('\n', cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    cursor += 1;
  }
  return -1;
}

function indentationAt(source, position) {
  return leadingWhitespace(source, lineStartAt(source, position));
}

function lineStartAt(source, position) {
  return Math.max(source.lastIndexOf('\n', position - 1), source.lastIndexOf('\r', position - 1)) + 1;
}

function lineEndingAt(source, position) {
  const ending = /\r\n|\r|\n/.exec(source.slice(position));
  return ending?.[0] ?? '\n';
}

function isLineStart(source, position) { return position === 0 || source[position - 1] === '\r' || source[position - 1] === '\n'; }

function kindFor(node) {
  const type = typeOf(node);
  if (type === 'Module') return 'document';
  if (statementTypes.has(type)) return 'statement';
  return 'expression';
}

function childNodes(node) {
  const children = [];
  // If/For/AsyncFor/While's orelse is projected explicitly as elif/else
  // 'clause' children (see projectClauses) instead of through this generic
  // walk, which has no notion of branch structure and would otherwise
  // double-project the same statements as flat siblings of the primary
  // body. Try/TryStar also have an 'orelse' field (their own except-else)
  // but are not in clauseChainTypes, so their existing - already broken,
  // out of scope here - behavior is untouched.
  const skipOrelse = clauseChainTypes.has(typeOf(node));
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key.startsWith('$') || locationKeys.has(key) || bookkeepingKeys.has(key)) continue;
    if (skipOrelse && key === 'orelse') continue;
    collectLocatedChildren(value, socketRoleFor(node, key, value), children);
  }
  return children;
}

function collectLocatedChildren(value, socketRole, children) {
  for (const child of Array.isArray(value) ? value : [value]) {
    if (!child || typeof child !== 'object') continue;
    if (isLocatedNode(child)) {
      children.push({node: child, socketRole});
      continue;
    }
    for (const [key, nestedValue] of Object.entries(child)) {
      if (key.startsWith('$') || locationKeys.has(key)) continue;
      collectLocatedChildren(nestedValue, socketRole ?? socketRoleFor(child, key, nestedValue), children);
    }
  }
}

// Brython's `arguments` node carries a lineno but no col_offset at all,
// since it isn't itself a real source-range AST node - only its own args
// (each fully located) are. Requiring col_offset too, not just lineno,
// keeps such structural wrappers from being socketed as though they were,
// which previously fell back to their statement's full range as an
// oversized, effectively-uneditable "socket" (e.g. def name(): swallowing
// its entire header and body). end_lineno/end_col_offset are not required
// here: a node with a real start but a missing or malformed end position
// still gets its end clamped to the containing statement boundary below.
function isLocatedNode(node) {
  return Number.isInteger(node.lineno) && Number.isInteger(node.col_offset);
}

function socketRoleFor(parent, key, value) {
  const type = typeOf(parent);
  if (type === 'Expr' && key === 'value' && isPrintCall(value)) return undefined;
  if ((type === 'Assign' || type === 'AnnAssign' || type === 'AugAssign') &&
      (key === 'target' || key === 'targets')) return 'assignment-target';
  if ((type === 'Assign' || type === 'AnnAssign' || type === 'AugAssign') && key === 'value') {
    return 'assignment-value';
  }
  if (type === 'If' && key === 'test') return 'if-condition';
  // A call's own arguments are already covered by the generic `args` socket
  // key below, but the callee name is user-supplied too - it should be
  // editable like any other identifier the user typed, not fixed structural
  // syntax the way the parentheses around it are. print() is special-cased
  // above as a fixed statement shape with only its own argument sockets, so
  // its own name should stay out of that.
  if (type === 'Call' && key === 'func' && !isPrintCall(parent)) return 'call-target';
  if (type === 'Call' && key === 'args') return 'call-argument';
  if (type === 'List' && key === 'elts') return 'list-item';
  return socketKeys.has(key) ? 'expression' : undefined;
}

function isPrintCall(node) {
  return typeOf(node) === 'Call' && typeOf(node.func) === 'Name' && node.func.id === 'print';
}

const statementTypes = new Set([
  'AnnAssign', 'Assert', 'Assign', 'AsyncFor', 'AsyncFunctionDef', 'AsyncWith',
  'AugAssign', 'Break', 'ClassDef', 'Continue', 'Delete', 'Expr', 'For',
  'FunctionDef', 'Global', 'If', 'Import', 'ImportFrom', 'Match', 'Nonlocal',
  'Pass', 'Raise', 'Return', 'Try', 'TryStar', 'TypeAlias', 'While', 'With'
]);
const containerStatementTypes = new Set([
  'AsyncFor', 'AsyncFunctionDef', 'AsyncWith', 'ClassDef', 'For', 'FunctionDef',
  'If', 'Match', 'Try', 'TryStar', 'While', 'With'
]);
// The subset of containers whose orelse is projected as an explicit
// elif/else clause chain (see projectClauses) rather than left to the
// generic child walk. Try/TryStar also have an orelse field but are not
// included - their handlers/finalbody/orelse structure is a separate,
// larger effort and is intentionally left exactly as it was.
const clauseChainTypes = new Set(['AsyncFor', 'For', 'If', 'While']);
const locationKeys = new Set(['lineno', 'col_offset', 'end_lineno', 'end_col_offset']);
const bookkeepingKeys = new Set(['type_ignores']);
const socketKeys = new Set([
  'args', 'defaults', 'ifs', 'iter', 'kw_defaults', 'kwonlyargs', 'left',
  'operand', 'posonlyargs', 'right', 'target', 'targets', 'test', 'value'
]);
function typeOf(node) { return node?.type ?? node?.$name ?? node?.constructor?.$name ?? node?.constructor?.name ?? 'Unknown'; }
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\r' && source[i + 1] === '\n') i += 1;
    if (source[i] === '\r' || source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}
function leadingWhitespace(source, from) { return /^[\t \f]*/.exec(source.slice(from))?.[0] ?? ''; }
function hasCodeBeforeComment(source, from) {
  const lineStart = Math.max(source.lastIndexOf('\n', from - 1), source.lastIndexOf('\r', from - 1)) + 1;
  return /\S/.test(source.slice(lineStart, from));
}
function boundedRange(from, to, boundary) {
  if (from < boundary.from || from > boundary.to || to < from || to > boundary.to) {
    return boundary;
  }
  return {from, to};
}
function offset(line, column, starts, source, fallback) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || column < 0) return fallback;
  const lineStart = starts[line - 1];
  if (!Number.isInteger(lineStart)) return fallback;
  const lineEnd = sourceLineEnd(starts, line, source);
  return column <= lineEnd - lineStart ? lineStart + column : fallback;
}
function sourceLineEnd(starts, line, source) {
  let end = starts[line] ?? source.length;
  while (end > starts[line - 1] && (source[end - 1] === '\r' || source[end - 1] === '\n')) end -= 1;
  return end;
}

function assertValidPython(source, pythonToAST) {
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST must be a function');
  try {
    pythonToAST(source, 'droplet.py', 'file');
  } catch (error) {
    throw new RangeError(`Python block operation produced invalid source: ${error?.message ?? 'syntax error'}`);
  }
}
