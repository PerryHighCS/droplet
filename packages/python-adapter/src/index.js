import {applySourceChanges, normalizeSourceChanges, parseWithOpaqueRecovery} from '@droplet/core';

/** Creates a source-range Python parser from Brython's browser AST API. */
export function createBrythonPythonParser(pythonToAST) {
  if (typeof pythonToAST !== 'function') throw new TypeError('Brython pythonToAST is required');
  return (source) => parsePython(source, pythonToAST);
}

export function parsePython(source, pythonToAST) {
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
    return {source, root: project(ast, source, lines, 'document'), issues: []};
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
      const socket = findNode(parsed.root, operation.target, 'socket');
      if (!socket) throw new RangeError('Socket target is not present in the current projection');
      changes = [{from: socket.from, to: socket.to, insert: operation.source}];
      break;
    }
    case 'insert-statement': {
      assertOperationSource(operation.source, 'Statement insertion');
      assertInsertionPoint(parsed.source, operation.destination);
      changes = [insertStatementChange(parsed.source, operation.destination.from, operation.source)];
      break;
    }
    case 'move-statement': {
      const statement = findNode(parsed.root, operation.source, 'statement');
      if (!statement) throw new RangeError('Statement source is not present in the current projection');
      assertInsertionPoint(parsed.source, operation.destination);
      const statementRange = statementLineRange(parsed.source, statement);
      if (operation.destination.from >= statementRange.from && operation.destination.from <= statementRange.to) return [];
      changes = moveStatementChanges(parsed.source, statementRange, operation.destination.from);
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

function project(node, source, lines, kind = kindFor(node), boundary = {from: 0, to: source.length}) {
  const rawFrom = offset(node.lineno, node.col_offset, lines, source, null);
  const rawTo = offset(node.end_lineno, node.end_col_offset, lines, source, null);
  const range = kind === 'document' ? {from: 0, to: source.length} : rawFrom === null || rawTo === null
    ? boundary
    : boundedRange(rawFrom, rawTo, boundary);
  const statementRange = kind === 'statement' ? expandDecoratorRange(node, source, lines, range) : range;
  const {from, to} = statementRange;
  return {
    id: `${kind}:${typeOf(node)}:${from}:${to}`,
    kind, from, to, editable: kind !== 'document',
    children: childNodes(node).map((child) => project(
      child.node, source, lines, child.socket ? 'socket' : kindFor(child.node), statementRange
    )).sort(compareProjectedNodes),
    metadata: {type: typeOf(node)}
  };
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

function moveStatementChanges(source, statementRange, destination) {
  const sourceIndentation = indentationAt(source, statementRange.from);
  const destinationIndentation = indentationAt(source, destination);
  const text = reindentPythonLines(source.slice(statementRange.from, statementRange.to), sourceIndentation, destinationIndentation);
  const lineEnding = lineEndingAt(source, destination);
  const insert = `${text}${ensureLineEnding(text, lineEnding)}${destinationIndentation}`;
  return [
    {from: statementRange.from, to: statementRange.to, insert: ''},
    {from: destination, to: destination, insert}
  ];
}

function statementLineRange(source, statement) {
  const from = lineStartAt(source, statement.from);
  let to = statement.to;
  while (to < source.length && source[to] !== '\r' && source[to] !== '\n') to += 1;
  if (source[to] === '\r' && source[to + 1] === '\n') to += 2;
  else if (source[to] === '\r' || source[to] === '\n') to += 1;
  return {from, to};
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
    collectLocatedChildren(value, socketKeys.has(key), children);
  }
  return children;
}

function collectLocatedChildren(value, socket, children) {
  for (const child of Array.isArray(value) ? value : [value]) {
    if (!child || typeof child !== 'object') continue;
    if (Number.isInteger(child.lineno)) {
      children.push({node: child, socket});
      continue;
    }
    for (const [key, nestedValue] of Object.entries(child)) {
      if (key.startsWith('$') || locationKeys.has(key)) continue;
      collectLocatedChildren(nestedValue, socket || socketKeys.has(key), children);
    }
  }
}

const statementTypes = new Set([
  'AnnAssign', 'Assert', 'Assign', 'AsyncFor', 'AsyncFunctionDef', 'AsyncWith',
  'AugAssign', 'Break', 'ClassDef', 'Continue', 'Delete', 'Expr', 'For',
  'FunctionDef', 'Global', 'If', 'Import', 'ImportFrom', 'Match', 'Nonlocal',
  'Pass', 'Raise', 'Return', 'Try', 'TryStar', 'TypeAlias', 'While', 'With'
]);
const locationKeys = new Set(['lineno', 'col_offset', 'end_lineno', 'end_col_offset']);
const bookkeepingKeys = new Set(['type_ignores']);
const socketKeys = new Set([
  'args', 'defaults', 'ifs', 'iter', 'kw_defaults', 'kwonlyargs', 'left',
  'posonlyargs', 'right', 'target', 'targets', 'test', 'value'
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

function findNode(node, range, kind) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if (node.kind === kind && node.from === range.from && node.to === range.to) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, range, kind);
    if (found) return found;
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
