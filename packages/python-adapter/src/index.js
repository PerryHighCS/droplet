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
const socketKeys = new Set(['value', 'args', 'targets', 'test', 'iter', 'left', 'right']);
function typeOf(node) { return node?.type ?? node?.$name ?? node?.constructor?.$name ?? node?.constructor?.name ?? 'Unknown'; }
function lineStarts(source) { const starts = [0]; for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1); return starts; }
function offset(line, column, starts, length, fallback) {
  if (!Number.isInteger(line) || !Number.isInteger(column)) return fallback;
  const lineStart = starts[line - 1];
  return Number.isInteger(lineStart) ? Math.min(lineStart + column, length) : fallback;
}
