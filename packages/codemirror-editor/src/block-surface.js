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
  const root = layoutDocument(projection.root, projection.source, settings);
  return {
    source: projection.source,
    bounds: root.bounds,
    root,
    insertionZones: collectInsertionZones(root),
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
  const content = layoutChildren(children, source, settings, 0, 0, node.to);
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

function layoutChildren(nodes, source, settings, left, top, bodyEnd) {
  let cursor = top;
  let right = left + settings.minimumWidth;
  const children = [];
  const insertionZones = [];
  for (const node of nodes) {
    insertionZones.push(insertionZone(node.from, left, cursor, right - left, settings, 'before-sibling'));
    const child = layoutNode(node, source, settings, left, cursor);
    children.push(child);
    cursor = child.bounds.bottom + settings.rowGap;
    right = Math.max(right, child.bounds.right);
  }
  insertionZones.push(insertionZone(bodyEnd, left, cursor, right - left, settings, 'body-end'));
  return {children, insertionZones, right, bottom: Math.max(top + settings.lineHeight, cursor)};
}

function layoutNode(node, source, settings, left, top) {
  if (node.kind === 'whitespace') return layoutWhitespace(node, settings, left, top);
  if (isContainer(node)) return layoutContainer(node, source, settings, left, top);
  return layoutAtomic(node, source, settings, left, top);
}

function layoutAtomic(node, source, settings, left, top) {
  const text = source.slice(node.from, node.to);
  const width = Math.max(settings.minimumWidth, settings.measureText(text) + settings.horizontalPadding * 2);
  return {
    id: node.id,
    kind: node.kind === 'comment' ? 'comment' : 'statement',
    source: rangeOf(node),
    text,
    bounds: box(left, top, width, settings.lineHeight),
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
  const bodyLeft = left + settings.indentWidth;
  const bodyTop = top + settings.lineHeight + settings.containerGap;
  const bodyEnd = Number.isInteger(node.metadata?.bodyEnd) ? node.metadata.bodyEnd : node.to;
  const body = layoutChildren(structuralChildren(node), source, settings, bodyLeft, bodyTop, bodyEnd);
  const right = Math.max(left + headerWidth, body.right + settings.horizontalPadding);
  const footerTop = Math.max(bodyTop, body.bottom);
  const footer = box(left, footerTop, right - left, settings.footerHeight);
  const bounds = {left, top, right, bottom: footer.bottom};
  return {
    id: node.id,
    kind: 'container',
    source: rangeOf(node),
    text: headerText,
    bounds,
    regions: {
      header: box(left, top, headerWidth, settings.lineHeight),
      body: {left: bodyLeft, top: bodyTop, right, bottom: footer.top},
      footer
    },
    children: body.children,
    insertionZones: body.insertionZones
  };
}

function structuralChildren(node) {
  const children = (node.children ?? []).filter((child) =>
    child.kind === 'statement' || child.kind === 'comment' || child.kind === 'whitespace');
  // Acorn represents a JavaScript braced body as a BlockStatement child. It is
  // structural syntax, not a second user-visible C block inside an if/for.
  if (isContainer(node) && children.length === 1 && children[0].metadata?.type === 'BlockStatement') {
    return structuralChildren(children[0]);
  }
  return children;
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

function insertionZone(destination, left, top, width, settings, role) {
  return {
    kind: 'insertion-zone', role, destination: {from: destination, to: destination},
    bounds: box(left, top - settings.insertionHeight / 2, Math.max(settings.minimumWidth, width), settings.insertionHeight)
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

function collectInsertionZones(node) {
  return [
    ...(node.insertionZones ?? []),
    ...(node.children ?? []).flatMap(collectInsertionZones)
  ];
}

function collectLayoutNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectLayoutNodes)];
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
  const measureText = options.measureText ?? ((text) => text.length * 8);
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
    whitespaceWidth: positiveNumber(options.whitespaceWidth, 72)
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
