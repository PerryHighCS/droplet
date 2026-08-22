import {parseWithOpaqueRecovery} from '@droplet/core';

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
      const from = offset(token.lineno, token.col_offset, starts, source.length, 0);
      const to = offset(token.end_lineno, token.end_col_offset, starts, source.length, source.length);
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
  const range = kind === 'document' ? {from: 0, to: source.length} : boundedRange(
    offset(node.lineno, node.col_offset, lines, source.length, boundary.from),
    offset(node.end_lineno, node.end_col_offset, lines, source.length, boundary.to),
    boundary
  );
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
    const offsetFrom = offset(decorator?.lineno, decorator?.col_offset, lines, source.length, -1);
    const lineStart = lines[(decorator?.lineno ?? 0) - 1];
    return offsetFrom < 0 || !Number.isInteger(lineStart) ? from : Math.min(from, lineStart);
  }, range.from);
  return decoratorFrom === range.from ? range : {from: decoratorFrom, to: range.to};
}

function compareProjectedNodes(left, right) {
  return left.from - right.from || left.to - right.to || left.id.localeCompare(right.id);
}

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
function lineStarts(source) { const starts = [0]; for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1); return starts; }
function leadingWhitespace(source, from) { return /^[\t \f]*/.exec(source.slice(from))?.[0] ?? ''; }
function hasCodeBeforeComment(source, from) {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1;
  return /\S/.test(source.slice(lineStart, from));
}
function boundedRange(from, to, boundary) {
  if (from < boundary.from || from > boundary.to || to < from || to > boundary.to) {
    return boundary;
  }
  return {from, to};
}
function offset(line, column, starts, length, fallback) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || column < 0) return fallback;
  const lineStart = starts[line - 1];
  if (!Number.isInteger(lineStart)) return fallback;
  const lineEnd = sourceLineEnd(starts, line, length);
  return column <= lineEnd - lineStart ? lineStart + column : fallback;
}
function sourceLineEnd(starts, line, length) { return starts[line] === undefined ? length : starts[line] - 1; }
