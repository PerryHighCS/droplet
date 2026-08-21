import {parse} from 'acorn';

/**
 * Produces a source-range JavaScript projection without regenerating source.
 * The supported first block operation is replacement of an expression socket.
 */
export function parseJavaScript(source, options = {}) {
  assertSource(source);
  let tree;
  try {
    tree = parse(source, {
      ecmaVersion: 'latest',
      sourceType: options.sourceType ?? 'script',
      allowReturnOutsideFunction: true,
      ...options
    });
  } catch (error) {
    // Acorn pinpoints the unexpected token, but the unparsed prefix and suffix
    // are one unavailable structure. Keep the complete snapshot visible as one
    // opaque region until the next successful parse.
    error.offset = Number.isInteger(error.pos) ? error.pos : undefined;
    error.from = 0;
    error.to = source.length;
    error.opaqueKind = 'opaque-statement';
    throw error;
  }

  return {
    source,
    root: projectNode(tree, 'document'),
    issues: []
  };
}

/** Returns minimal source changes for supported JavaScript block intents. */
export function transformJavaScript(operation, parsed) {
  if (operation?.type !== 'replace-socket') {
    throw new RangeError(`Unsupported JavaScript block operation: ${operation?.type}`);
  }
  if (typeof operation.source !== 'string') {
    throw new TypeError('Socket replacement source must be a string');
  }
  const socket = findNode(parsed?.root, operation.target, 'socket');
  if (!socket) throw new RangeError('Socket target is not present in the current projection');
  return [{from: socket.from, to: socket.to, insert: operation.source}];
}

function projectNode(node, kind = nodeKind(node)) {
  return {
    id: `${kind}:${node.type}:${node.start}:${node.end}`,
    kind,
    from: node.start,
    to: node.end,
    editable: kind !== 'document',
    children: childNodes(node).map(({node: child, socket}) =>
      projectNode(child, socket ? 'socket' : nodeKind(child))),
    metadata: {type: node.type}
  };
}

function nodeKind(node) {
  if (node.type === 'Program') return 'document';
  if (node.type.endsWith('Statement') || node.type.endsWith('Declaration')) return 'statement';
  return 'expression';
}

function childNodes(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'type') continue;
    if (isAstNode(value)) {
      children.push({node: value, socket: isSocketPosition(node, key)});
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) children.push({node: entry, socket: isSocketPosition(node, key)});
      }
    }
  }
  return children;
}

function isSocketPosition(parent, key) {
  return (parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'arguments' ||
    (parent.type === 'VariableDeclarator' && key === 'init') ||
    (parent.type === 'AssignmentExpression' && key === 'right') ||
    ((parent.type === 'BinaryExpression' || parent.type === 'LogicalExpression') &&
      (key === 'left' || key === 'right')) ||
    (parent.type === 'ReturnStatement' && key === 'argument');
}

function isAstNode(value) {
  return value && typeof value.type === 'string' &&
    Number.isInteger(value.start) && Number.isInteger(value.end);
}

function findNode(node, range, kind) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if (node.kind === kind && node.from === range.from && node.to === range.to) return node;
  for (const child of node.children) {
    const found = findNode(child, range, kind);
    if (found) return found;
  }
  return undefined;
}

function assertSource(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
}
