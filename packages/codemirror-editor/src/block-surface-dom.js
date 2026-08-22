import {createBlockLayout, createSubtreePreview, hitTestBlockLayout} from './block-surface.js';

/**
 * DOM/SVG host for a BlockSurface layout. It owns visual geometry only: source
 * and editing remain with the CodeMirror adapter that supplies projections.
 */
export class BlockSurface {
  #parent;
  #dom;
  #svg;
  #onSelect;
  #onOperation;
  #layoutOptions;
  #layout;
  #drag;
  #suppressClick = false;

  constructor({parent, onSelect, onOperation, layoutOptions = {}}) {
    if (!parent?.ownerDocument) throw new TypeError('A BlockSurface parent element is required');
    if (onSelect !== undefined && typeof onSelect !== 'function') throw new TypeError('onSelect must be a function');
    if (onOperation !== undefined && typeof onOperation !== 'function') throw new TypeError('onOperation must be a function');
    this.#parent = parent;
    this.#onSelect = onSelect;
    this.#onOperation = onOperation;
    this.#layoutOptions = layoutOptions;
    this.#dom = parent.ownerDocument.createElement('div');
    this.#dom.className = 'droplet-block-surface';
    Object.assign(this.#dom.style, {
      display: 'none', overflow: 'auto', position: 'relative', minHeight: '100%', userSelect: 'none'
    });
    this.#svg = parent.ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
    this.#svg.setAttribute('role', 'tree');
    this.#svg.setAttribute('aria-label', 'Droplet blocks');
    this.#svg.style.display = 'block';
    this.#dom.append(this.#svg);
    this.#dom.addEventListener('click', (event) => this.#handleClick(event));
    this.#svg.addEventListener('pointerdown', (event) => this.#beginDrag(event));
    this.#svg.addEventListener('pointermove', (event) => this.#continueDrag(event));
    this.#svg.addEventListener('pointerup', (event) => this.#endDrag(event));
    parent.append(this.#dom);
  }

  get element() {
    return this.#dom;
  }

  get layout() {
    return this.#layout;
  }

  update(projection) {
    this.#layout = createBlockLayout(projection, this.#layoutOptions);
    renderLayout(this.#svg, this.#layout, this.#dom.ownerDocument);
  }

  setVisible(visible) {
    this.#dom.style.display = visible ? 'block' : 'none';
  }

  destroy() {
    this.#dom.remove();
    this.#layout = undefined;
  }

  #handleClick(event) {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      return;
    }
    if (!this.#layout || event.defaultPrevented) return;
    const bounds = this.#svg.getBoundingClientRect();
    const target = hitTestBlockLayout(this.#layout, {x: event.clientX - bounds.left, y: event.clientY - bounds.top});
    if (target?.node?.source) this.#onSelect?.(target.node.source);
  }

  #beginDrag(event) {
    if (event.button !== 0 || !this.#layout || !this.#onOperation) return;
    const target = hitTestBlockLayout(this.#layout, pointFor(this.#svg, event));
    if (!target?.node || !isMovable(target.node)) return;
    this.#drag = {node: target.node, start: pointFor(this.#svg, event), moved: false, destination: undefined};
    this.#svg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  #continueDrag(event) {
    if (!this.#drag) return;
    const point = pointFor(this.#svg, event);
    if (!this.#drag.moved && Math.hypot(point.x - this.#drag.start.x, point.y - this.#drag.start.y) < 4) return;
    this.#drag.moved = true;
    const target = dropTargetAtPoint(this.#layout, point);
    const resolved = destinationForTarget(this.#layout, target, point);
    this.#drag.destination = resolved?.destination;
    renderDragPreviews(this.#svg, this.#layout, this.#drag.node, point, resolved?.zone);
    event.preventDefault();
  }

  #endDrag(event) {
    const drag = this.#drag;
    this.#drag = undefined;
    if (!drag) return;
    this.#svg.releasePointerCapture?.(event.pointerId);
    clearDragPreviews(this.#svg);
    if (!drag.moved) return;
    this.#suppressClick = true;
    if (drag.destination) {
      const operation = {
        type: drag.node.kind === 'comment' ? 'move-comment' : 'move-statement',
        source: drag.node.source,
        destination: drag.destination
      };
      this.#onOperation(operation);
    }
    event.preventDefault();
  }
}

function destinationForTarget(layout, target, point) {
  if (target?.kind === 'insertion') return {destination: target.zone.destination, zone: target.zone};
  // Standalone comments and container headers participate in their suite's
  // vertical sibling order. A container body/footer retains its structural
  // insertion zones; only the header gets before/after behavior.
  // Inline comments remain children of their statement and are not targets here.
  if (target?.node?.kind !== 'statement' && target?.node?.kind !== 'comment' && target?.kind !== 'container-header') return undefined;
  const targetBounds = target.kind === 'container-header' ? target.node.regions.header : target.node.bounds;
  const before = point.y < (targetBounds.top + targetBounds.bottom) / 2;
  if (target.kind === 'container-header' && !before) {
    const zone = target.node.insertionZones.find((candidate) => candidate.role === 'before-sibling') ??
      target.node.insertionZones.find((candidate) => candidate.role === 'body-end');
    return zone ? {destination: zone.destination, zone} : undefined;
  }
  const parent = findParent(layout.root, target.node.id);
  if (!parent) return undefined;
  if (target.node.metadata?.type === 'Pass' && parent.metadata?.emptySuitePass) {
    const from = parent.metadata.bodyEnd ?? parent.source.to;
    return {
      destination: {
        from, to: from,
        indentation: parent.metadata.bodyIndentation ?? '',
        emptySuitePass: parent.metadata.emptySuitePass
      },
      zone: {bounds: target.node.bounds}
    };
  }
  const index = parent.children.findIndex((child) => child.id === target.node.id);
  const zone = before
    ? parent.insertionZones.find((candidate) => candidate.role === 'before-sibling' && candidate.destination.from === target.node.source.from)
    : index + 1 < parent.children.length
      ? parent.insertionZones.find((candidate) => candidate.role === 'before-sibling' &&
        candidate.destination.from === parent.children[index + 1].source.from)
      : parent.insertionZones.find((candidate) => candidate.role === 'body-end');
  if (!zone) return undefined;
  return {
    destination: zone.destination,
    zone: {...zone, bounds: statementHalfBounds(targetBounds, before)}
  };
}

function dropTargetAtPoint(layout, point) {
  const direct = hitTestBlockLayout(layout, point);
  if (direct?.kind === 'insertion' || isSiblingDropTarget(direct)) return direct;
  // renderLayout adds a 16px right gutter around the layout bounds.
  if (point.x < 0 || point.x > layout.bounds.right + 16) return direct;
  // The target row extends across the visible block-surface lane. This makes
  // before/after dropping practical beside a narrow block, while preserving
  // the more specific structural insertion zones inside container bodies.
  const candidate = layout.nodes
    .filter((node) => node.kind === 'statement' || node.kind === 'comment' || node.kind === 'container')
    .map((node) => ({node, bounds: node.kind === 'container' ? node.regions.header : node.bounds}))
    .filter(({bounds}) => point.y >= bounds.top && point.y <= bounds.bottom)
    .sort((left, right) => (left.bounds.right - left.bounds.left) - (right.bounds.right - right.bounds.left))[0];
  return candidate ? {
    kind: candidate.node.kind === 'container' ? 'container-header' : candidate.node.kind,
    node: candidate.node
  } : direct;
}

function isSiblingDropTarget(target) {
  return target?.node?.kind === 'statement' || target?.node?.kind === 'comment' || target?.kind === 'container-header';
}

function findParent(node, childId) {
  for (const child of node.children ?? []) {
    if (child.id === childId) return node;
    const parent = findParent(child, childId);
    if (parent) return parent;
  }
  return undefined;
}

function statementHalfBounds(bounds, before) {
  const middle = (bounds.top + bounds.bottom) / 2;
  return {...bounds, top: before ? bounds.top : middle, bottom: before ? middle : bounds.bottom};
}

function isMovable(node) {
  return node.kind === 'statement' || node.kind === 'container' || node.kind === 'comment';
}

function pointFor(svg, event) {
  const bounds = svg.getBoundingClientRect();
  return {x: event.clientX - bounds.left, y: event.clientY - bounds.top};
}

function renderDragPreviews(svg, layout, node, point, zone) {
  clearDragPreviews(svg);
  const document = svg.ownerDocument;
  const preview = createSubtreePreview(layout, node.id);
  const floating = document.createElementNS(SVG_NAMESPACE, 'g');
  floating.classList.add('droplet-drag-preview');
  floating.setAttribute('transform', `translate(${point.x + 12} ${point.y + 12})`);
  floating.setAttribute('opacity', '.85');
  floating.append(renderNode(preview, document));
  svg.append(floating);
  if (!zone) return;
  const placement = document.createElementNS(SVG_NAMESPACE, 'g');
  placement.classList.add('droplet-drop-preview');
  placement.setAttribute('transform', `translate(${zone.bounds.left} ${zone.bounds.top})`);
  placement.setAttribute('opacity', '.55');
  placement.append(renderNode(preview, document));
  const guide = document.createElementNS(SVG_NAMESPACE, 'rect');
  guide.classList.add('droplet-drop-guide');
  guide.setAttribute('x', String(zone.bounds.left));
  guide.setAttribute('y', String(zone.bounds.top + 4));
  guide.setAttribute('width', String(zone.bounds.right - zone.bounds.left));
  guide.setAttribute('height', '3');
  guide.setAttribute('fill', '#4d7fb5');
  svg.append(placement, guide);
}

function clearDragPreviews(svg) {
  svg.querySelectorAll('.droplet-drag-preview, .droplet-drop-preview, .droplet-drop-guide').forEach((element) => element.remove());
}

function renderLayout(svg, layout, document) {
  svg.replaceChildren();
  const width = Math.ceil(layout.bounds.right + 16);
  const height = Math.ceil(layout.bounds.bottom + 16);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  for (const child of layout.root.children) svg.append(renderNode(child, document));
}

function renderNode(node, document) {
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('data-droplet-layout-id', node.id);
  group.setAttribute('data-droplet-kind', node.kind);
  group.setAttribute('data-droplet-from', String(node.source.from));
  group.setAttribute('data-droplet-to', String(node.source.to));
  group.setAttribute('role', 'treeitem');
  if (node.kind === 'container') renderContainer(group, node, document);
  else if (node.kind === 'whitespace') renderWhitespace(group, node, document);
  else renderAtomic(group, node, document);
  for (const child of node.children) group.append(renderNode(child, document));
  return group;
}

function renderContainer(group, node, document) {
  const {header, footer} = node.regions;
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  const radius = 4;
  path.setAttribute('d', [
    `M ${header.left + radius} ${header.top}`,
    `H ${header.right - radius}`,
    `Q ${header.right} ${header.top} ${header.right} ${header.top + radius}`,
    `V ${header.bottom - radius}`,
    `Q ${header.right} ${header.bottom} ${header.right - radius} ${header.bottom}`,
    `H ${footer.left + 18}`,
    `V ${footer.top}`,
    `H ${footer.right - radius}`,
    `Q ${footer.right} ${footer.top} ${footer.right} ${footer.top + radius}`,
    `V ${footer.bottom - radius}`,
    `Q ${footer.right} ${footer.bottom} ${footer.right - radius} ${footer.bottom}`,
    `H ${footer.left + 18}`
  ].join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#246ca8');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  group.append(path, createLabel(node.text, header.left + 8, header.top + 20, document));
}

function renderAtomic(group, node, document) {
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.setAttribute('x', String(node.bounds.left));
  rect.setAttribute('y', String(node.bounds.top));
  rect.setAttribute('width', String(node.bounds.right - node.bounds.left));
  rect.setAttribute('height', String(node.bounds.bottom - node.bounds.top));
  rect.setAttribute('rx', '4');
  rect.setAttribute('fill', node.kind === 'comment' ? '#f0f0f0' : '#fff');
  rect.setAttribute('stroke', node.kind === 'comment' ? '#999' : '#7a9ec4');
  group.append(rect, createLabel(node.text, node.bounds.left + 8, node.bounds.top + 20, document));
}

function renderWhitespace(group, node, document) {
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.setAttribute('x', String(node.bounds.left));
  rect.setAttribute('y', String(node.bounds.top + 8));
  rect.setAttribute('width', String(node.bounds.right - node.bounds.left));
  rect.setAttribute('height', String(Math.max(4, node.bounds.bottom - node.bounds.top - 16)));
  rect.setAttribute('rx', '3');
  rect.setAttribute('fill', 'rgba(196, 196, 196, .18)');
  rect.setAttribute('stroke', '#9aa5b1');
  rect.setAttribute('stroke-dasharray', '3 3');
  group.append(rect);
}

function createLabel(text, x, y, document) {
  const label = document.createElementNS(SVG_NAMESPACE, 'text');
  label.setAttribute('x', String(x));
  label.setAttribute('y', String(y));
  label.setAttribute('fill', '#24344d');
  label.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
  label.setAttribute('font-size', '16');
  label.textContent = text.replace(/[\r\n].*$/, '');
  return label;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
