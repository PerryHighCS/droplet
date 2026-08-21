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
      comments.push({kind: 'comment', from, to, inline: token.col_offset > 0});
    }
    if (token?.type === indentTokenType && Number.isInteger(token.lineno)) {
      const lineStart = starts[token.lineno - 1];
      const text = leadingWhitespace(source, lineStart);
      if (text.length) indentation.push({kind: 'indentation', from: lineStart, to: lineStart + text.length, text});
    }
  }
  return {comments, indentation};
}

function project(node, source, lines, kind = kindFor(node)) {
  const from = offset(node.lineno, node.col_offset, lines, source.length, 0);
  const to = offset(node.end_lineno, node.end_col_offset, lines, source.length, source.length);
  return {
    id: `${kind}:${typeOf(node)}:${from}:${to}`,
    kind, from, to, editable: kind !== 'document',
    children: childNodes(node).map((child) => project(child.node, source, lines, child.socket ? 'socket' : kindFor(child.node))),
    metadata: {type: typeOf(node)}
  };
}

function kindFor(node) {
  const type = typeOf(node);
  if (type === 'Module') return 'document';
  if (/^(Assign|AnnAssign|AugAssign|Expr|If|For|While|FunctionDef|Return|Import|ImportFrom|Pass|Break|Continue|ClassDef)$/.test(type)) return 'statement';
  return 'expression';
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (key.startsWith('$') || locationKeys.has(key)) continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && Number.isInteger(child.lineno)) {
        children.push({node: child, socket: socketKeys.has(key)});
      }
    }
  }
  return children;
}

const locationKeys = new Set(['lineno', 'col_offset', 'end_lineno', 'end_col_offset']);
const socketKeys = new Set(['value', 'args', 'target', 'targets', 'test', 'iter', 'left', 'right']);
function typeOf(node) { return node?.type ?? node?.$name ?? node?.constructor?.$name ?? node?.constructor?.name ?? 'Unknown'; }
function lineStarts(source) { const starts = [0]; for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1); return starts; }
function leadingWhitespace(source, from) { return /^[\t ]*/.exec(source.slice(from))?.[0] ?? ''; }
function offset(line, column, starts, length, fallback) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || column < 0) return fallback;
  const lineStart = starts[line - 1];
  return Number.isInteger(lineStart) ? Math.min(lineStart + column, length) : fallback;
}
