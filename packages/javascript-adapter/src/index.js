import {parse} from 'acorn';
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
  physicalLines
} from '@droplet/core';

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
  assertParsedSource(parsed, 'JavaScript');
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
      // A "before this statement" destination is that statement's own `from`,
      // which - like any statement range here - sits after its line's
      // leading whitespace, not at column 0 (see indentLines above). Splicing
      // indentLines' own prefix in there directly would double that
      // whitespace onto the new line while leaving the original statement
      // with none of its own, so normalize to the line's actual start first.
      const point = lineStart(parsed.source, operation.destination.from);
      const indentation = insertionIndentation(parsed.source, point);
      changes = [{from: point, to: point, insert: indentLines(operation.source, indentation)}];
      break;
    }
    case 'move-statement': {
      const statement = findNode(parsed.root, operation.source, 'statement');
      if (!statement) throw new RangeError('Statement source is not present in the current projection');
      assertInsertionPoint(parsed.source, operation.destination);
      if (operation.destination.from >= statement.from && operation.destination.from <= statement.to) return [];
      const text = parsed.source.slice(statement.from, statement.to);
      const point = lineStart(parsed.source, operation.destination.from);
      changes = [
        {from: statement.from, to: statement.to, insert: ''},
        {from: point, to: point, insert: relocatedStatementText(parsed.source, text, point)}
      ];
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
      // An "else if" is always appended after the chain's last existing
      // "else if" (or right after the primary body if there isn't one yet) -
      // never after an "else", even if one already exists, so else-if-before-
      // else ordering holds without the caller needing to know that.
      const previousClause = operation.role === 'elif'
        ? clauses.filter((clause) => clause.metadata?.clauseRole === 'elif').at(-1)
        : clauses.at(-1);
      const insertAt = previousClause ? previousClause.to : closingBraceEnd(parsed.source, statement.metadata?.blockEnd);
      if (!Number.isInteger(insertAt)) throw new RangeError('Clause target has no body to extend');
      const indentation = indentationOf(parsed.source, statement.from);
      const header = operation.role === 'elif' ? 'else if (true)' : 'else';
      changes = [{from: insertAt, to: insertAt, insert: ` ${header} {\n${indentation}}`}];
      break;
    }
    case 'remove-clause': {
      const clause = findNode(parsed.root, operation.target, 'clause');
      if (!clause) throw new RangeError('Clause target is not present in the current projection');
      // Also consume the one leading space "} else {...}" attaches its next
      // clause with, or removal would leave a doubled space where the
      // deleted clause's own leading space and its predecessor's trailing
      // space now sit next to each other.
      const from = parsed.source[clause.from - 1] === ' ' ? clause.from - 1 : clause.from;
      changes = [{from, to: clause.to, insert: ''}];
      break;
    }
    case 'insert-sequence-item': {
      const target = findAny(parsed.root, operation.target);
      if (!target) throw new RangeError('Sequence target is not present in the current projection');
      // A statement target (a function declaration, or a call used as the
      // whole statement - a container is still 'statement' kind at this raw,
      // pre-layout level) searches only its own header/statement line for
      // the closing ")", so a call inside the body/elsewhere on a later line
      // isn't matched instead; a socket target (a call nested as a value)
      // already ends exactly at its own ")".
      const headerEnd = target.kind === 'statement' ? lineTextEnd(parsed.source, target.from) : target.to;
      const closingParenthesis = parsed.source.lastIndexOf(')', headerEnd - 1);
      if (closingParenthesis < target.from) throw new RangeError('Sequence target has no closing delimiter');
      changes = [{from: closingParenthesis, to: closingParenthesis, insert: ', '}];
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
      const range = next ? {from: item.from, to: next.from} : previous ? {from: previous.to, to: item.to} : {from: item.from, to: item.to};
      changes = [{from: range.from, to: range.to, insert: ''}];
      break;
    }
    case 'delete-node': {
      const node = findNode(parsed.root, operation.source, operation.kind);
      if (!node || node.kind !== 'statement') throw new RangeError('Statement deletion source is not present in the current projection');
      changes = [{from: node.from, to: node.to, insert: ''}];
      break;
    }
    case 'copy-node': {
      const node = findNode(parsed.root, operation.source, operation.kind);
      if (!node || node.kind !== 'statement') throw new RangeError('Statement copy source is not present in the current projection');
      assertInsertionPoint(parsed.source, operation.destination);
      const point = lineStart(parsed.source, operation.destination.from);
      const text = parsed.source.slice(node.from, node.to);
      changes = [{from: point, to: point, insert: relocatedStatementText(parsed.source, text, point)}];
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

// A statement/block-scoped range never carries its own leading indentation
// (Acorn's node.start skips past it), so an inserted or moved statement needs
// it added back - matched to the destination's context, not just left at
// column 0. There is no semantic indentation to preserve here the way
// Python's is (a Python move reindents relative to its own source line); this
// only infers what a human would type: one level deeper right after an
// opening brace/paren/bracket, level with the previous line otherwise.
function insertionIndentation(source, destination) {
  const lineStart = source.lastIndexOf('\n', destination - 1) + 1;
  if (lineStart === 0) return '';
  const previousLineEnd = lineStart - 1;
  const previousLineStart = source.lastIndexOf('\n', previousLineEnd - 1) + 1;
  const previousLine = source.slice(previousLineStart, previousLineEnd);
  const indentation = /^[ \t]*/.exec(previousLine)[0];
  return /[{([]\s*$/.test(previousLine) ? `${indentation}  ` : indentation;
}

// Applies one indentation prefix across every line of a (possibly multi-line,
// possibly already internally-nested) statement, shifting its whole structure
// by a constant amount rather than flattening it.
function indentLines(text, indentation) {
  if (!indentation) return text;
  return text.split('\n').map((line) => line.length ? indentation + line : line).join('\n');
}

// A moved/copied statement's own text (unlike insert-statement's caller-
// supplied source) never carries its own trailing newline - node.to excludes
// it, matching delete-node's range, so the same statement can be deleted from
// its old spot without also eating the next line's newline. Splicing it back
// in ahead of a "point" that isn't the very end of the document therefore
// needs one restored, or it runs straight into whatever originally started
// at that line.
function relocatedStatementText(source, text, point) {
  const indentation = insertionIndentation(source, point);
  return indentLines(text, indentation) + (point < source.length ? '\n' : '');
}

// The leading whitespace of the line containing `position`, e.g. the exact
// indentation a statement itself was written at - not `insertionIndentation`,
// which describes indentation *for something landing at* `position` and
// reads the line *before* it instead.
function indentationOf(source, position) {
  return /^[ \t]*/.exec(source.slice(lineStart(source, position)))[0];
}

// A container's own bodyEnd (see metadataFor) is the *start* of the closing
// brace's line, chosen so an insert there doesn't corrupt the brace's own
// leading indentation - but attaching a new "else if"/"else" clause happens
// right *after* that brace, not before it. blockEnd is the block's own AST
// end offset (the position right after "}" itself), used directly instead of
// text-searching for the first "}" at/after bodyEnd, which could just as
// easily match a "}" inside a string or template literal in the body.
function closingBraceEnd(_source, blockEnd) {
  return Number.isInteger(blockEnd) ? blockEnd : undefined;
}

function projectNode(node, kind = nodeKind(node), source, socketRole) {
  const children = childNodes(node).map(({node: child, socketRole: childSocketRole}) =>
    projectNode(child, childSocketRole ? 'socket' : nodeKind(child), source, childSocketRole));
  return {
    id: `${kind}:${node.type}:${node.start}:${node.end}`,
    kind,
    from: node.start,
    to: node.end,
    editable: kind !== 'document',
    children: [
      ...children,
      ...emptyParameterSocket(node, source),
      ...emptyCallArgumentSocket(node, source),
      ...emptyReturnValueSocket(node, source),
      ...(node.type === 'IfStatement' ? ifClauses(node, source) : [])
    ].sort(compareProjectedNodes),
    metadata: metadataFor(node, kind, source, socketRole)
  };
}

// JS's grammar makes an if/else-if/else chain directly visible in the AST -
// `alternate` is another IfStatement for an "else if" continuation
// (unwrapped, with no block of its own) or a BlockStatement for a final
// "else" (wrapped) - unlike Python's `elif`, whose AST has no separate node
// for it and needs sniffing the source text to tell apart from a genuine
// nested if. childNodes() excludes `alternate` from the ordinary recursive
// walk (see its own comment), so this is the only path that ever visits it -
// every IfStatement reached through the ordinary walk is therefore always a
// chain's primary branch, never a link already covered by a parent's call
// here.
function ifClauses(node, source) {
  if (!node.alternate) return [];
  const elseFrom = source.indexOf('else', node.consequent.end);
  if (elseFrom === -1 || elseFrom >= node.alternate.start) return [];
  if (node.alternate.type === 'IfStatement') {
    const clause = ifClause('elif', elseFrom, node.alternate, source);
    return clause ? [clause, ...ifClauses(node.alternate, source)] : [];
  }
  const clause = elseClause(elseFrom, node.alternate, source);
  return clause ? [clause] : [];
}

// An "else if" clause's body is its own inner IfStatement's consequent - kept
// flattened directly into the clause's own children, the same way a plain
// container's single-BlockStatement body is (see structuralChildren in
// block-surface.js), rather than nested as its own separate box.
function ifClause(role, from, inner, source) {
  if (inner.consequent?.type !== 'BlockStatement') return undefined;
  const headerTo = lineTextEnd(source, from);
  const testSocket = projectNode(inner.test, 'socket', source, 'if-condition');
  const bodyChildren = (inner.consequent.body ?? []).map((statement) => projectNode(statement, nodeKind(statement), source));
  const to = inner.consequent.end;
  return {
    id: `clause:${role}:${from}:${to}`,
    kind: 'clause', from, to, editable: true,
    children: [testSocket, ...bodyChildren],
    metadata: {type: 'IfStatement', clauseRole: role, headerTo, bodyEnd: lineStart(source, to - 1)}
  };
}

function elseClause(from, block, source) {
  if (block.type !== 'BlockStatement') return undefined;
  const headerTo = lineTextEnd(source, from);
  const bodyChildren = (block.body ?? []).map((statement) => projectNode(statement, nodeKind(statement), source));
  const to = block.end;
  return {
    id: `clause:else:${from}:${to}`,
    kind: 'clause', from, to, editable: true,
    children: bodyChildren,
    metadata: {type: 'BlockStatement', clauseRole: 'else', headerTo, bodyEnd: lineStart(source, to - 1)}
  };
}

// A zero-parameter function still needs one directly-editable slot to type a
// first parameter name into - without it there is nothing to click, since an
// empty `params` array contributes no child at all. The same slot is needed
// again after "+" (insert-sequence-item) splices in a "," with nothing after
// it yet: that comma is not itself a param, so it does not show up in
// `params` either, and without this the "+" button would add room for a new
// parameter with no way to actually type one in.
function emptyParameterSocket(node, source) {
  if (node.type !== 'FunctionDeclaration' && node.type !== 'FunctionExpression') return [];
  const openParen = source.indexOf('(', node.id ? node.id.end : node.start);
  if (openParen === -1) return [];
  return emptySequenceSocket(source, openParen, node.params, 'parameter');
}

// A zero-argument call - `myFunction()`, `Math.random()` - is syntactically
// complete JavaScript (unlike a while/if condition, a call's argument list
// can be empty), so it gets the same directly-editable empty slot rather
// than requiring a placeholder identifier to have anything to click - and,
// as with a parameter list above, so does the gap "+" leaves behind.
function emptyCallArgumentSocket(node, source) {
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return [];
  const openParen = source.indexOf('(', node.callee.end);
  if (openParen === -1) return [];
  return emptySequenceSocket(source, openParen, node.arguments, 'call-argument');
}

// Shared by both: an empty, directly-editable slot belongs right before the
// closing ")" whenever there is nothing real there yet to click on instead -
// either no items at all, or only a dangling "," (with optional whitespace)
// that "+" left between the last real item and the ")". A "," is required
// here when items already exist - without it, `myFunction(n)` would match
// too (nothing but whitespace between "n" and ")"), producing a phantom
// empty socket alongside "n" before "+" is ever clicked.
function emptySequenceSocket(source, openParen, items, socketRole) {
  const closeParen = source.indexOf(')', openParen);
  if (closeParen === -1) return [];
  const lastItemEnd = items.length ? items.at(-1).end : openParen + 1;
  const between = source.slice(lastItemEnd, closeParen);
  const pattern = items.length ? /^\s*,\s*$/ : /^\s*$/;
  if (!pattern.test(between)) return [];
  return [{
    id: `socket:${socketRole}:${closeParen}:${closeParen}`,
    kind: 'socket', from: closeParen, to: closeParen, editable: true, children: [],
    metadata: {type: 'Identifier', socketRole, empty: true}
  }];
}

// A bare `return;` - a valid, argument-less return - gets the same empty
// slot, so a palette "return ;" block has something to click without a
// placeholder identifier already sitting in the socket.
function emptyReturnValueSocket(node, source) {
  if (node.type !== 'ReturnStatement' || node.argument) return [];
  const semicolon = source.indexOf(';', node.start);
  const position = semicolon === -1 ? node.end : semicolon;
  return [{
    id: `socket:expression:${position}:${position}`,
    kind: 'socket', from: position, to: position, editable: true, children: [],
    metadata: {type: 'Identifier', socketRole: 'expression', empty: true}
  }];
}

function metadataFor(node, kind, source, socketRole) {
  const metadata = {type: node.type};
  if (kind === 'socket') metadata.socketRole = socketRole ?? 'expression';
  if (kind === 'statement' && containerStatementTypes.has(node.type)) {
    metadata.blockRole = 'container';
    metadata.headerTo = lineTextEnd(source, node.start);
    // Without this, a container's own end (node.end, used as the layout
    // engine's default bodyEnd) lands *after* the closing "}" - so a block
    // dropped on the container's body-end insertion zone would land outside
    // it, right after the brace, instead of inside as the last statement.
    // The line *start*, not the brace's own position, matters here: landing
    // right before "}" would insert between the brace's own leading
    // indentation and the brace itself, corrupting both - the existing
    // indentation would become a prefix of the inserted line, and the brace
    // would be left with none of its own.
    const blockBody = node.type === 'BlockStatement' ? node : blockStatementChild(node);
    if (blockBody) {
      metadata.bodyEnd = lineStart(source, blockBody.end - 1);
      metadata.blockEnd = blockBody.end;
    }
  }
  return metadata;
}

function lineStart(source, position) {
  return source.lastIndexOf('\n', position - 1) + 1;
}

function blockStatementChild(node) {
  // An IfStatement's own body is specifically its consequent - relying on
  // Acorn's property order to reach that before a same-shaped `alternate`
  // (a bare "else { }", also a BlockStatement) would be fragile.
  if (node.type === 'IfStatement') return node.consequent?.type === 'BlockStatement' ? node.consequent : undefined;
  for (const value of Object.values(node)) {
    if (isAstNode(value) && value.type === 'BlockStatement') return value;
  }
  return undefined;
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
    // An if/else-if/else chain is projected as 'clause' children by
    // ifClauses (see projectNode) instead of through this generic walk -
    // visiting `alternate` here too would duplicate it.
    if (key === 'alternate' && node.type === 'IfStatement') continue;
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
  if ((parent.type === 'WhileStatement' || parent.type === 'DoWhileStatement') && key === 'test') return 'while-condition';
  if (parent.type === 'ForStatement' && (key === 'init' || key === 'test' || key === 'update')) return 'expression';
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && key === 'id') return 'name';
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && key === 'params') return 'parameter';
  if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'callee') return 'call-target';
  if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && key === 'arguments') return 'call-argument';
  if ((parent.type === 'BinaryExpression' || parent.type === 'LogicalExpression') &&
      (key === 'left' || key === 'right')) return 'expression';
  if (parent.type === 'ReturnStatement' && key === 'argument') return 'expression';
  return undefined;
}

function isAstNode(value) {
  return value && typeof value.type === 'string' &&
    Number.isInteger(value.start) && Number.isInteger(value.end);
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
  // A 'clause' (an else-if/else branch's own children, see ifClause/
  // elseClause) is a valid trivia parent too - without it, a whitespace-only
  // line inside an else/else-if body attaches to the enclosing IfStatement
  // instead of the clause that actually contains it.
  const child = (node.children ?? []).find((candidate) =>
    (candidate.kind === 'statement' || candidate.kind === 'clause') &&
    candidate.from <= range.from && candidate.to >= range.to);
  return child ? triviaParent(child, range) : node;
}

const containerStatementTypes = new Set([
  'BlockStatement', 'ClassDeclaration', 'DoWhileStatement', 'ForInStatement',
  'ForOfStatement', 'ForStatement', 'FunctionDeclaration', 'IfStatement',
  'SwitchStatement', 'TryStatement', 'WhileStatement', 'WithStatement'
]);

function assertSource(source) {
  if (typeof source !== 'string') throw new TypeError('Source must be a string');
}
