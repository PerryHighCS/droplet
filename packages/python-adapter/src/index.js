import {applySourceChanges, normalizeSourceChanges, parseWithOpaqueRecovery} from '@droplet/core';

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
  assertParsedSource(parsed);
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
        : [insertStatementChange(parsed.source, operation.destination.from, operation.source)];
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
        ? moveInlineCommentChanges(parsed.source, comment, commentRange, operation.destination.from)
        : moveLineRangeChanges(parsed.source, commentRange, operation.destination.from);
      break;
    }
    case 'copy-node': {
      const node = findNode(parsed.root, operation.source, operation.kind);
      if (!node || (node.kind !== 'statement' && node.kind !== 'comment')) {
        throw new RangeError('Copy source is not present in the current projection');
      }
      assertInsertionPoint(parsed.source, operation.destination);
      const copiedSource = parsed.source.slice(node.from, node.to);
      const emptyPass = emptySuitePass(parsed, operation.destination);
      changes = emptyPass
        ? [replaceEmptySuitePass(parsed.source, emptyPass, copiedSource)]
        : [insertStatementChange(parsed.source, operation.destination.from, copiedSource)];
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
  addEmptyPrintArgumentSocket(children, node, source, rawFrom, rawTo);
  return {
    id: `${kind}:${typeOf(node)}:${from}:${to}`,
    kind, from, to, editable: kind !== 'document',
    children: children.sort(compareProjectedNodes),
    metadata: metadataFor(node, kind, source, rawFrom ?? from, socketRole)
  };
}

function addEmptyPrintArgumentSocket(children, node, source, from, to) {
  if (!isPrintCall(node) || children.some((child) => child.kind === 'socket') || from === null || to === null) return;
  const closingParenthesis = source.lastIndexOf(')', to - 1);
  if (closingParenthesis < from) return;
  children.push({
    id: `socket:print-argument:${closingParenthesis}:${closingParenthesis}`,
    kind: 'socket', from: closingParenthesis, to: closingParenthesis, editable: true, children: [],
    metadata: {type: 'CallArgument', socketRole: 'call-argument', empty: true}
  });
}

function metadataFor(node, kind, source, headerFrom, socketRole) {
  const metadata = {type: typeOf(node)};
  if (kind === 'socket') metadata.socketRole = socketRole ?? 'expression';
  if (kind === 'statement' && containerStatementTypes.has(typeOf(node))) {
    metadata.blockRole = 'container';
    metadata.headerTo = lineTextEnd(source, headerFrom);
    const body = (node.body ?? []).filter((child) => child && typeof child === 'object');
    const first = body[0];
    const last = body.at(-1);
    const lastTo = offset(last?.end_lineno, last?.end_col_offset, lineStarts(source), source, null);
    const firstFrom = offset(first?.lineno, first?.col_offset, lineStarts(source), source, null);
    if (lastTo !== null && firstFrom !== null) {
      metadata.bodyFrom = firstFrom;
      metadata.bodyEnd = lineEndAfter(source, lastTo);
      metadata.bodyIndentation = indentationAt(source, firstFrom);
      if (body.length === 1 && typeOf(first) === 'Pass') {
        metadata.emptySuitePass = {from: firstFrom, to: lastTo};
      }
    }
  }
  return metadata;
}

function addCommentNodes(root, comments) {
  for (const comment of comments) {
    const parent = triviaParent(root, comment);
    parent.children.push({
      id: `comment:${comment.from}:${comment.to}`,
      kind: 'comment', from: comment.from, to: comment.to, editable: true, children: [],
      metadata: {inline: comment.inline}
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
  const child = (node.children ?? []).find((candidate) => candidate.kind === 'statement' &&
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

function compareProjectedNodes(left, right) {
  return left.from - right.from || left.to - right.to || left.id.localeCompare(right.id);
}

function insertStatementChange(source, destination, statementSource) {
  const indentation = indentationAt(source, destination);
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
  if (parent?.metadata?.blockRole !== 'container') return undefined;
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

function lineTextEnd(source, position) {
  let end = position;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
  return end;
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

function moveInlineCommentChanges(source, comment, commentRange, destination) {
  const insertion = insertStatementChange(source, destination, source.slice(comment.from, comment.to));
  return [
    {from: commentRange.from, to: commentRange.to, insert: ''},
    insertion
  ];
}

function reindentPythonLines(source, fromIndentation, toIndentation) {
  return source.split(/(\r\n|\r|\n)/).map((part, index) => {
    if (index % 2 === 1 || part === '') return part;
    const content = part.startsWith(fromIndentation) ? part.slice(fromIndentation.length) : part;
    return index === 0 ? content : toIndentation + content;
  }).join('');
}

function ensureLineEnding(source, lineEnding) {
  return /(?:\r\n|\r|\n)$/.test(source) ? '' : lineEnding;
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
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key.startsWith('$') || locationKeys.has(key) || bookkeepingKeys.has(key)) continue;
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
function physicalLines(source) {
  const lines = [];
  let from = 0;
  for (let index = 0; index < source.length;) {
    const match = /\r\n|\r|\n/.exec(source.slice(index));
    if (!match) break;
    const endingFrom = index + match.index;
    const to = endingFrom + match[0].length;
    lines.push({from, to, text: source.slice(from, endingFrom), ending: match[0]});
    from = to;
    index = to;
  }
  if (from < source.length) lines.push({from, to: source.length, text: source.slice(from), ending: ''});
  return lines;
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

function findNode(node, range, kind) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if (node.kind === kind && node.from === range.from && node.to === range.to) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, range, kind);
    if (found) return found;
  }
  return undefined;
}

function findSocket(node, range) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if ((node.kind === 'socket' || node.kind === 'recovery-socket') && node.from === range.from && node.to === range.to) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findSocket(child, range);
    if (found) return found;
  }
  return undefined;
}

function findParent(node, target) {
  for (const child of node.children ?? []) {
    if (child === target) return node;
    const parent = findParent(child, target);
    if (parent) return parent;
  }
  return undefined;
}

function assertParsedSource(parsed) {
  if (typeof parsed?.source !== 'string' || !parsed?.root) {
    throw new TypeError('A current Python projection is required');
  }
}

function assertOperationSource(source, label) {
  if (typeof source !== 'string') throw new TypeError(`${label} source must be a string`);
}

function assertInsertionPoint(source, destination) {
  if (!Number.isInteger(destination?.from) || destination.from !== destination.to ||
      destination.from < 0 || destination.from > source.length) {
    throw new RangeError('Statement destination must be a zero-width source position');
  }
}

function assertValidPython(source, pythonToAST) {
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST must be a function');
  try {
    pythonToAST(source, 'droplet.py', 'file');
  } catch (error) {
    throw new RangeError(`Python block operation produced invalid source: ${error?.message ?? 'syntax error'}`);
  }
}
