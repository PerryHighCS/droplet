import {parse} from 'acorn';
import {applySourceChanges, normalizeSourceChanges} from '@droplet/core';

/**
 * Produces a source-range JavaScript projection without regenerating source.
 * Its transforms replace sockets and insert or move statements.
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

  const root = projectNode(tree, 'document', source);
  addWhitespaceNodes(root, source);
  return {
    source,
    root,
    issues: []
  };
}

/** Returns minimal source changes for supported JavaScript block intents. */
export function transformJavaScript(operation, parsed) {
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
      changes = [{from: operation.destination.from, to: operation.destination.to, insert: operation.source}];
      break;
    }
    case 'move-statement': {
      const statement = findNode(parsed.root, operation.source, 'statement');
      if (!statement) throw new RangeError('Statement source is not present in the current projection');
      assertInsertionPoint(parsed.source, operation.destination);
      if (operation.destination.from >= statement.from && operation.destination.from <= statement.to) return [];
      const text = parsed.source.slice(statement.from, statement.to);
      changes = [
        {from: statement.from, to: statement.to, insert: ''},
        {from: operation.destination.from, to: operation.destination.to, insert: text}
      ];
      break;
    }
    default:
      throw new RangeError(`Unsupported JavaScript block operation: ${operation?.type}`);
  }

  // Do not emit a transformation that produces invalid JavaScript. This is
  // validation only; parseJavaScript never becomes a source serializer.
  const normalizedChanges = normalizeSourceChanges(parsed.source, changes);
  parseJavaScript(applySourceChanges(parsed.source, normalizedChanges));
  return normalizedChanges;
}

function projectNode(node, kind = nodeKind(node), source, socketRole) {
  return {
    id: `${kind}:${node.type}:${node.start}:${node.end}`,
    kind,
    from: node.start,
    to: node.end,
    editable: kind !== 'document',
    children: childNodes(node).map(({node: child, socketRole: childSocketRole}) =>
      projectNode(child, childSocketRole ? 'socket' : nodeKind(child), source, childSocketRole)),
    metadata: metadataFor(node, kind, source, socketRole)
  };
}

function metadataFor(node, kind, source, socketRole) {
  const metadata = {type: node.type};
  if (kind === 'socket') metadata.socketRole = socketRole ?? 'expression';
  if (kind === 'statement' && containerStatementTypes.has(node.type)) {
    metadata.blockRole = 'container';
    metadata.headerTo = lineTextEnd(source, node.start);
  }
  return metadata;
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
      children.push({node: value, socketRole: socketRoleFor(node, key)});
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) children.push({node: entry, socketRole: socketRoleFor(node, key)});
      }
    }
  }
  return children;
}

function socketRoleFor(parent, key) {
  if (parent.type === 'AssignmentExpression' && key === 'left') return 'assignment-target';
  if (parent.type === 'VariableDeclarator' && key === 'id') return 'assignment-target';
  if ((parent.type === 'VariableDeclarator' || parent.type === 'AssignmentExpression') &&
      (key === 'init' || key === 'right')) return 'assignment-value';
  if (parent.type === 'IfStatement' && key === 'test') return 'if-condition';
  if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'arguments') return 'expression';
  if ((parent.type === 'BinaryExpression' || parent.type === 'LogicalExpression') &&
      (key === 'left' || key === 'right')) return 'expression';
  if (parent.type === 'ReturnStatement' && key === 'argument') return 'expression';
  return undefined;
}

function isAstNode(value) {
  return value && typeof value.type === 'string' &&
    Number.isInteger(value.start) && Number.isInteger(value.end);
}

function lineTextEnd(source, position) {
  let end = position;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
  return end;
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

function compareProjectedNodes(left, right) {
  return left.from - right.from || left.to - right.to || left.id.localeCompare(right.id);
}

const containerStatementTypes = new Set([
  'BlockStatement', 'ClassDeclaration', 'DoWhileStatement', 'ForInStatement',
  'ForOfStatement', 'ForStatement', 'FunctionDeclaration', 'IfStatement',
  'SwitchStatement', 'TryStatement', 'WhileStatement', 'WithStatement'
]);

function findNode(node, range, kind) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if (node.kind === kind && node.from === range.from && node.to === range.to) return node;
  for (const child of node.children) {
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
  for (const child of node.children) {
    const found = findSocket(child, range);
    if (found) return found;
  }
  return undefined;
}

function assertParsedSource(parsed) {
  if (typeof parsed?.source !== 'string' || !parsed?.root) {
    throw new TypeError('A current JavaScript projection is required');
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

function assertSource(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
}
