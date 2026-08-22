/**
 * Framework-independent geometry for the modern Droplet block surface.
 *
 * This module deliberately has no CodeMirror or DOM dependency. A renderer
 * supplies text measurement, renders the resulting boxes and paths, and sends
 * the selected source-range intent back through the language adapter.
 */
export function createBlockLayout(projection, options = {}) {
  assertProjection(projection);
  const settings = normalizeOptions(options);
  settings.inlineComments = collectInlineComments(projection.root);
  const root = layoutDocument(projection.root, projection.source, settings);
  return {
    source: projection.source,
    bounds: root.bounds,
    root,
    insertionZones: collectInsertionZones(root).sort((left, right) => right.depth - left.depth),
    nodes: collectLayoutNodes(root)
  };
}

/** Returns a translated layout for a floating or placement subtree preview. */
export function createSubtreePreview(layout, nodeId) {
  const node = layout?.nodes?.find((candidate) => candidate.id === nodeId);
  if (!node) throw new RangeError('A layout node with the requested id is required');
  return translateLayoutNode(node, -node.bounds.left, -node.bounds.top);
}

/**
 * Resolves a block-surface target without DOM overlap or text-layout heuristics.
 * Children always win over their containing block; insertion zones are used only
 * when no rendered child/header owns the pointer.
 */
export function hitTestBlockLayout(layout, point) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new TypeError('Hit testing requires finite x and y coordinates');
  }
  const node = hitTestNode(layout?.root, point);
  if (node) return {kind: node.kind === 'container' ? 'container-header' : node.kind, node};
  const zone = (layout?.insertionZones ?? []).find((candidate) => contains(candidate.bounds, point));
  return zone ? {kind: 'insertion', zone} : undefined;
}

function layoutDocument(node, source, settings) {
  const children = structuralChildren(node);
  const content = layoutChildren(children, source, settings, 0, 0, node.to, {indentation: ''});
  return {
    id: node.id,
    kind: 'document',
    source: rangeOf(node),
    bounds: {
      left: 0, top: 0,
      right: Math.max(settings.minimumWidth, content.right),
      bottom: Math.max(settings.lineHeight, content.bottom)
    },
    children: content.children,
    insertionZones: content.insertionZones
  };
}

function layoutChildren(nodes, source, settings, left, top, bodyEnd, destination = {}) {
  let cursor = top;
  let right = left + settings.minimumWidth;
  const children = [];
  const insertionZones = [];
  for (const node of nodes) {
    insertionZones.push(insertionZone(node.from, left, cursor, right - left, settings, 'before-sibling', destination));
    const child = layoutNode(node, source, settings, left, cursor);
    children.push(child);
    cursor = child.bounds.bottom + settings.rowGap;
    right = Math.max(right, layoutRight(child));
  }
  insertionZones.push(insertionZone(bodyEnd, left, cursor, right - left, settings, 'body-end', destination));
  return {children, insertionZones, right, bottom: Math.max(top + settings.lineHeight, cursor)};
}

function layoutNode(node, source, settings, left, top) {
  if (node.kind === 'whitespace') return layoutWhitespace(node, settings, left, top);
  if (isContainer(node)) return layoutContainer(node, source, settings, left, top);
  return layoutAtomic(node, source, settings, left, top);
}

function layoutAtomic(node, source, settings, left, top) {
  const inlineComment = node.kind === 'statement' ? inlineCommentFor(node, source, settings.inlineComments) : undefined;
  const textEnd = inlineComment ? inlineComment.from : node.kind === 'statement' ? lineEnd(source, node.to) : node.to;
  const text = source.slice(node.from, textEnd).trimEnd();
  const width = Math.max(settings.minimumWidth, settings.measureText(text) + settings.horizontalPadding * 2);
  const sockets = node.kind === 'statement'
    ? (node.children ?? []).filter((child) => child.kind === 'socket' || child.kind === 'recovery-socket')
      .map((child) => layoutSocket(child, node, source, settings, left, top))
    : [];
  const children = [
    ...(inlineComment ? [layoutAtomic(inlineComment, source, settings, left + width + settings.inlineCommentGap, top)] : []),
    ...sockets,
    ...(node.children ?? [])
    .filter((child) => child.kind?.startsWith('opaque-'))
    .map((child) => layoutAtomic(child, source, settings, left + 4, top + 4))
  ];
  return {
    id: node.id,
    kind: node.kind === 'comment' ? 'comment' : node.kind.startsWith('opaque-') ? node.kind : 'statement',
    source: rangeOf(node),
    metadata: node.metadata,
    text,
    bounds: box(left, top, width, settings.lineHeight),
    children,
    insertionZones: []
  };
}

function layoutSocket(node, statement, source, settings, left, top) {
  const text = source.slice(node.from, node.to);
  const prefix = source.slice(statement.from, node.from);
  const socketLeft = left + settings.horizontalPadding + settings.measureText(prefix) - 2;
  const width = Math.max(settings.socketMinimumWidth, settings.measureText(text) + 4);
  return {
    id: node.id,
    kind: node.kind,
    source: rangeOf(node),
    metadata: node.metadata,
    text,
    bounds: box(socketLeft, top + 3, width, settings.lineHeight - 6),
    children: [],
    insertionZones: []
  };
}

function layoutWhitespace(node, settings, left, top) {
  return {
    id: node.id,
    kind: 'whitespace',
    source: rangeOf(node),
    text: node.metadata?.text ?? '',
    bounds: box(left, top, settings.whitespaceWidth, settings.lineHeight),
    children: [],
    insertionZones: []
  };
}

function layoutContainer(node, source, settings, left, top) {
  const headerTo = validHeaderTo(node, source);
  const headerText = source.slice(node.from, headerTo);
  const headerWidth = Math.max(settings.minimumWidth, settings.measureText(headerText) + settings.horizontalPadding * 2);
  const headerSockets = (node.children ?? []).filter((child) => child.kind === 'socket' || child.kind === 'recovery-socket')
    .map((child) => layoutSocket(child, node, source, settings, left, top));
  const bodyLeft = left + settings.indentWidth;
  const bodyTop = top + settings.lineHeight + settings.containerGap;
  const bodyEnd = Number.isInteger(node.metadata?.bodyEnd) ? node.metadata.bodyEnd : node.to;
  const body = layoutChildren(structuralChildren(node, source), source, settings, bodyLeft, bodyTop, bodyEnd, {
    ...(node.metadata?.bodyIndentation === undefined ? {} : {indentation: node.metadata.bodyIndentation}),
    ...(node.metadata?.emptySuitePass ? {emptySuitePass: node.metadata.emptySuitePass} : {})
  });
  const right = Math.max(left + headerWidth, body.right + settings.horizontalPadding);
  const footerTop = Math.max(bodyTop, body.bottom);
  const footer = box(left, footerTop, right - left, settings.footerHeight);
  const bounds = {left, top, right, bottom: footer.bottom};
  return {
    id: node.id,
    kind: 'container',
    source: rangeOf(node),
    metadata: node.metadata,
    text: headerText,
    bounds,
    regions: {
      header: box(left, top, headerWidth, settings.lineHeight),
      body: {left: bodyLeft, top: bodyTop, right, bottom: footer.top},
      footer
    },
    children: [...headerSockets, ...body.children],
    insertionZones: body.insertionZones
  };
}

function structuralChildren(node, source) {
  const children = (node.children ?? []).filter((child) =>
    child.kind === 'statement' || (child.kind === 'comment' && !child.metadata?.inline) || child.kind === 'whitespace' || child.kind?.startsWith('opaque-'));
  if (source && typeof node.metadata?.bodyIndentation === 'string') {
    // Brython can retain an outer-scope statement beneath an earlier suite in
    // its object tree. Source indentation is the authoritative suite boundary.
    return descendantStructuralNodes(node)
      .filter((child) => leadingIndentation(source, child.from) === node.metadata.bodyIndentation)
      .sort(compareSourceRanges);
  }
  // Acorn represents a JavaScript braced body as a BlockStatement child. It is
  // structural syntax, not a second user-visible C block inside an if/for.
  if (isContainer(node) && children.length === 1 && children[0].metadata?.type === 'BlockStatement') {
    return structuralChildren(children[0], source);
  }
  return children.sort(compareSourceRanges);
}

function descendantStructuralNodes(node) {
  return (node.children ?? []).flatMap((child) => [
    ...(child.kind === 'statement' || (child.kind === 'comment' && !child.metadata?.inline) || child.kind === 'whitespace' ? [child] : []),
    ...descendantStructuralNodes(child)
  ]);
}

function leadingIndentation(source, from) {
  const start = Math.max(0, source.lastIndexOf('\n', from - 1) + 1);
  return /^[\t \f]*/.exec(source.slice(start, from))?.[0] ?? '';
}

function compareSourceRanges(left, right) {
  return left.from - right.from || left.to - right.to || left.id.localeCompare(right.id);
}

function lineEnd(source, offset) {
  const ending = source.slice(offset).search(/[\r\n]/);
  return ending === -1 ? source.length : offset + ending;
}

function isContainer(node) {
  return node.kind === 'statement' && node.metadata?.blockRole === 'container';
}

function validHeaderTo(node, source) {
  const headerTo = node.metadata?.headerTo;
  return Number.isInteger(headerTo) && headerTo >= node.from && headerTo <= node.to
    ? headerTo
    : source.indexOf('\n', node.from) === -1 ? node.to : source.indexOf('\n', node.from);
}

function insertionZone(destination, left, top, width, settings, role, details) {
  const bodyEnd = role === 'body-end';
  return {
    kind: 'insertion-zone', role, destination: {from: destination, to: destination, ...details},
    // A container footer is a drop region, not a one-pixel separator. Its
    // interior must accept a drop at the end of the suite.
    bounds: box(
      left,
      top - (bodyEnd ? settings.insertionHeight : settings.insertionHeight / 2),
      Math.max(settings.minimumWidth, width),
      bodyEnd ? settings.insertionHeight * 2 : settings.insertionHeight
    )
  };
}

function hitTestNode(node, point) {
  if (!node || !contains(node.bounds, point)) return undefined;
  for (const child of node.children ?? []) {
    const result = hitTestNode(child, point);
    if (result) return result;
  }
  if (node.kind === 'container' && !contains(node.regions.header, point)) return undefined;
  return node.kind === 'document' ? undefined : node;
}

function collectInsertionZones(node, depth = 0) {
  return [
    ...(node.insertionZones ?? []).map((zone) => ({...zone, depth})),
    ...(node.children ?? []).flatMap((child) => collectInsertionZones(child, depth + 1))
  ];
}

function collectLayoutNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectLayoutNodes)];
}

function layoutRight(node) {
  return Math.max(node.bounds.right, ...(node.children ?? []).map(layoutRight));
}

function collectInlineComments(node) {
  return [
    ...(node.kind === 'comment' && node.metadata?.inline ? [node] : []),
    ...(node.children ?? []).flatMap(collectInlineComments)
  ];
}

function inlineCommentFor(statement, source, comments) {
  const lineEndOffset = lineEnd(source, statement.from);
  return comments.find((comment) => comment.from >= statement.to && comment.from <= lineEndOffset);
}

function translateLayoutNode(node, x, y) {
  return {
    ...node,
    bounds: translateBox(node.bounds, x, y),
    regions: node.regions && Object.fromEntries(Object.entries(node.regions).map(([key, value]) => [key, translateBox(value, x, y)])),
    insertionZones: (node.insertionZones ?? []).map((zone) => ({...zone, bounds: translateBox(zone.bounds, x, y)})),
    children: (node.children ?? []).map((child) => translateLayoutNode(child, x, y))
  };
}

function box(left, top, width, height) {
  return {left, top, right: left + width, bottom: top + height};
}

function translateBox(bounds, x, y) {
  return {left: bounds.left + x, top: bounds.top + y, right: bounds.right + x, bottom: bounds.bottom + y};
}

function contains(bounds, point) {
  return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom;
}

function rangeOf(node) {
  return {from: node.from, to: node.to};
}

function normalizeOptions(options) {
  const measureText = options.measureText ?? ((text) => text.length * 10);
  if (typeof measureText !== 'function') throw new TypeError('measureText must be a function');
  return {
    measureText,
    lineHeight: positiveNumber(options.lineHeight, 28),
    indentWidth: positiveNumber(options.indentWidth, 24),
    horizontalPadding: positiveNumber(options.horizontalPadding, 8),
    footerHeight: positiveNumber(options.footerHeight, 10),
    containerGap: nonNegativeNumber(options.containerGap, 4),
    rowGap: nonNegativeNumber(options.rowGap, 4),
    insertionHeight: positiveNumber(options.insertionHeight, 12),
    minimumWidth: positiveNumber(options.minimumWidth, 56),
    whitespaceWidth: positiveNumber(options.whitespaceWidth, 72),
    inlineCommentGap: positiveNumber(options.inlineCommentGap, 6),
    socketMinimumWidth: positiveNumber(options.socketMinimumWidth, 20)
  };
}

function positiveNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Layout dimensions must be positive finite numbers');
  return value;
}

function nonNegativeNumber(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new TypeError('Layout dimensions must be non-negative finite numbers');
  return value;
}

function assertProjection(projection) {
  if (typeof projection?.source !== 'string' || !projection.root || projection.root.kind !== 'document') {
    throw new TypeError('A source-backed document projection is required');
  }
}
