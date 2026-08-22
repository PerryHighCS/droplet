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
  #onSocketEdit;
  #layoutOptions;
  #layout;
  #drag;
  #socketEditor;
  #selectedNode;
  #suppressClick = false;
  #document;
  #endDragFromDocument;

  constructor({parent, onSelect, onOperation, onSocketEdit, layoutOptions = {}}) {
    if (!parent?.ownerDocument) throw new TypeError('A BlockSurface parent element is required');
    if (onSelect !== undefined && typeof onSelect !== 'function') throw new TypeError('onSelect must be a function');
    if (onOperation !== undefined && typeof onOperation !== 'function') throw new TypeError('onOperation must be a function');
    if (onSocketEdit !== undefined && typeof onSocketEdit !== 'function') throw new TypeError('onSocketEdit must be a function');
    this.#parent = parent;
    this.#onSelect = onSelect;
    this.#onOperation = onOperation;
    this.#onSocketEdit = onSocketEdit;
    this.#layoutOptions = layoutOptions;
    this.#dom = parent.ownerDocument.createElement('div');
    this.#dom.className = 'droplet-block-surface';
    Object.assign(this.#dom.style, {
      display: 'none', overflow: 'auto', position: 'relative', minHeight: '100%', userSelect: 'none'
    });
    this.#dom.tabIndex = 0;
    this.#svg = parent.ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
    this.#svg.setAttribute('role', 'tree');
    this.#svg.setAttribute('aria-label', 'Droplet blocks');
    this.#svg.style.display = 'block';
    // A snake-styled container's wavy edge can dip a pixel or two past its
    // nominal bounds; let that overshoot paint instead of clipping at the
    // SVG's own viewBox edge. A host page provides the surrounding padding.
    this.#svg.style.overflow = 'visible';
    this.#dom.append(this.#svg);
    this.#dom.addEventListener('click', (event) => this.#handleClick(event));
    this.#dom.addEventListener('keydown', (event) => this.#handleKeydown(event));
    this.#svg.addEventListener('pointerdown', (event) => this.#beginDrag(event));
    this.#svg.addEventListener('pointermove', (event) => this.#continueDrag(event));
    this.#svg.addEventListener('pointerup', (event) => this.#endDrag(event));
    // A trackpad drag toward the canvas edge can end with the OS or browser
    // delivering pointercancel instead of pointerup (a gesture interrupting
    // the sequence, or the pointer briefly leaving the capturing element).
    // Without handling it, the drag state never clears and the release the
    // user just made is silently lost.
    this.#svg.addEventListener('pointercancel', (event) => this.#endDrag(event));
    // Pointer capture on the SVG normally keeps a release targeted at it even
    // once the cursor leaves its bounds (dragging above/below the surface),
    // but that is not perfectly reliable across every browser/input-device
    // combination. A document-level fallback keeps a drag from getting stuck
    // - and the user's release from being silently dropped - when it isn't.
    this.#document = parent.ownerDocument;
    this.#endDragFromDocument = (event) => this.#endDrag(event);
    this.#document.addEventListener('pointerup', this.#endDragFromDocument, true);
    this.#document.addEventListener('pointercancel', this.#endDragFromDocument, true);
    this.#dom.addEventListener('dragover', (event) => this.#continuePaletteDrag(event));
    this.#dom.addEventListener('dragleave', (event) => this.#leavePaletteDrag(event));
    this.#dom.addEventListener('drop', (event) => this.#dropPaletteBlock(event));
    parent.append(this.#dom);
  }

  get element() {
    return this.#dom;
  }

  get layout() {
    return this.#layout;
  }

  update(projection) {
    this.#closeSocketEditor();
    this.#selectedNode = undefined;
    delete this.#svg.dataset.dropletSelectedId;
    this.#layout = createBlockLayout(projection, this.#layoutOptions);
    renderLayout(this.#svg, this.#layout, this.#dom.ownerDocument);
  }

  setVisible(visible) {
    this.#dom.style.display = visible ? 'block' : 'none';
  }

  destroy() {
    this.#closeSocketEditor();
    this.#document.removeEventListener('pointerup', this.#endDragFromDocument, true);
    this.#document.removeEventListener('pointercancel', this.#endDragFromDocument, true);
    this.#dom.remove();
    this.#layout = undefined;
  }

  #handleClick(event) {
    if (this.#suppressClick) {
      this.#suppressClick = false;
      return;
    }
    if (!this.#layout || event.defaultPrevented) return;
    const directNode = layoutNodeForElement(this.#layout, event.target);
    if (directNode?.kind === 'socket' || directNode?.kind === 'recovery-socket') {
      this.#selectNode(directNode);
      this.#openSocketEditor(directNode);
      return;
    }
    const bounds = this.#svg.getBoundingClientRect();
    const target = hitTestBlockLayout(this.#layout, {x: event.clientX - bounds.left, y: event.clientY - bounds.top});
    if (target?.node?.kind === 'socket' || target?.node?.kind === 'recovery-socket') {
      this.#selectNode(target.node);
      this.#openSocketEditor(target.node);
      return;
    }
    if (target?.node?.source) this.#selectNode(target.node);
  }

  #handleKeydown(event) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const node = this.#selectedNode;
    if (!node || !isDeletable(node)) return;
    event.preventDefault();
    this.#deleteNode(node);
  }

  #selectNode(node) {
    this.#selectedNode = node;
    renderSelection(this.#svg, node, this.#dom.ownerDocument);
    this.#dom.focus();
    this.#onSelect?.(node.source);
  }

  #deleteNode(node) {
    if (isSocketNode(node)) {
      this.#onSocketEdit?.({target: node.source, source: ''});
      return;
    }
    this.#onOperation?.({
      type: 'delete-node',
      source: node.source,
      kind: node.kind === 'container' ? 'statement' : node.kind
    });
  }

  #openSocketEditor(socket) {
    if (!this.#onSocketEdit) return;
    this.#closeSocketEditor();
    // The input is an absolutely positioned sibling of the SVG, not part of
    // its coordinate system, so a host page adding padding/border around the
    // SVG (or scaling it) would otherwise leave the input misaligned with
    // the socket it edits.
    const {left, top, scale} = this.#svgOffset();
    const input = this.#dom.ownerDocument.createElement('input');
    input.className = 'droplet-socket-editor';
    input.value = this.#layout.source.slice(socket.source.from, socket.source.to);
    input.setAttribute('aria-label', `${socket.metadata?.socketRole ?? 'expression'} socket`);
    Object.assign(input.style, {
      position: 'absolute', left: `${left + socket.bounds.left * scale}px`, top: `${top + socket.bounds.top * scale}px`,
      width: `${Math.max(24, (socket.bounds.right - socket.bounds.left) * scale)}px`,
      height: `${(socket.bounds.bottom - socket.bounds.top) * scale}px`, boxSizing: 'border-box',
      border: '1px solid #246ca8', borderRadius: '3px', padding: '0 3px',
      font: '16px ui-monospace, SFMono-Regular, Menlo, monospace', color: '#24344d', background: '#fff'
    });
    const editing = {input, source: socket.source, original: input.value};
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#commitSocketEditor(editing);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#closeSocketEditor();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && input.selectionStart === 0 &&
          input.selectionEnd === input.value.length) {
        event.preventDefault();
        input.value = '';
        this.#commitSocketEditor(editing);
      }
    });
    input.addEventListener('blur', () => this.#commitSocketEditor(editing));
    this.#socketEditor = editing;
    this.#dom.append(input);
    input.focus();
    input.select();
  }

  #svgOffset() {
    const svgRect = this.#svg.getBoundingClientRect();
    const hostRect = this.#dom.getBoundingClientRect();
    const declaredWidth = Number(this.#svg.getAttribute('width'));
    const scale = declaredWidth && svgRect.width ? svgRect.width / declaredWidth : 1;
    return {left: (svgRect.left || 0) - (hostRect.left || 0), top: (svgRect.top || 0) - (hostRect.top || 0), scale};
  }

  #commitSocketEditor(editing) {
    if (this.#socketEditor !== editing) return;
    this.#socketEditor = undefined;
    editing.input.remove();
    if (editing.input.value !== editing.original) {
      this.#onSocketEdit({target: editing.source, source: editing.input.value});
    }
  }

  #closeSocketEditor() {
    const editing = this.#socketEditor;
    this.#socketEditor = undefined;
    editing?.input.remove();
  }

  #beginDrag(event) {
    if (event.button !== 0 || !this.#layout || !this.#onOperation) return;
    const target = hitTestBlockLayout(this.#layout, pointFor(this.#svg, event));
    if (!target?.node || !isMovable(target.node)) return;
    this.#drag = {
      node: target.node,
      copy: event.ctrlKey || event.metaKey,
      start: pointFor(this.#svg, event),
      lastPoint: pointFor(this.#svg, event),
      moved: false,
      destination: undefined,
      operation: undefined
    };
    this.#svg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  #continueDrag(event) {
    if (!this.#drag) return;
    const point = pointFor(this.#svg, event);
    this.#drag.lastPoint = point;
    if (!this.#drag.moved && Math.hypot(point.x - this.#drag.start.x, point.y - this.#drag.start.y) < 4) return;
    this.#drag.moved = true;
    const target = dropTargetAtPoint(this.#layout, point);
    const resolved = destinationForTarget(this.#layout, target, point, this.#drag.node) ??
      escapeDestination(this.#layout, point, this.#drag.node, this.#drag.copy);
    this.#drag.destination = resolved?.destination;
    this.#drag.operation = resolved?.operation;
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
    if (drag.operation) {
      this.#onOperation(drag.operation);
    } else if (drag.destination) {
      this.#onOperation(drag.copy ? {
        type: 'copy-node',
        source: drag.node.source,
        kind: drag.node.kind === 'container' ? 'statement' : drag.node.kind,
        destination: drag.destination
      } : {
        type: drag.node.kind === 'comment' ? 'move-comment' : 'move-statement',
        source: drag.node.source,
        destination: drag.destination
      });
    } else if (!drag.copy && isOutsideCanvas(this.#layout, drag.lastPoint ?? pointFor(this.#svg, event))) {
      this.#deleteNode(drag.node);
    }
    event.preventDefault();
  }

  #continuePaletteDrag(event) {
    if (!this.#layout || !this.#onOperation || !isPaletteDrag(event)) return;
    event.dataTransfer.dropEffect = 'move';
    const point = pointFor(this.#svg, event);
    const target = dropTargetAtPoint(this.#layout, point);
    const resolved = destinationForTarget(this.#layout, target, point, {kind: 'statement'});
    renderExternalDropGuide(this.#svg, resolved?.zone);
    event.preventDefault();
  }

  #leavePaletteDrag(event) {
    if (!this.#dom.contains(event.relatedTarget)) clearDragPreviews(this.#svg);
  }

  #dropPaletteBlock(event) {
    const source = paletteSource(event);
    if (!this.#layout || !this.#onOperation || !source) return;
    const point = pointFor(this.#svg, event);
    const target = dropTargetAtPoint(this.#layout, point);
    const resolved = destinationForTarget(this.#layout, target, point, {kind: 'statement'});
    clearDragPreviews(this.#svg);
    if (resolved?.destination) {
      this.#onOperation({type: 'insert-statement', destination: resolved.destination, source});
    }
    event.preventDefault();
  }
}

function destinationForTarget(layout, target, point, dragNode) {
  if (target?.kind === 'insertion') return {destination: target.zone.destination, zone: target.zone};
  if (isExpressionNode(dragNode) && isSocketNode(target?.node)) {
    if (sameRange(dragNode.source, target.node.source)) return undefined;
    return {
      operation: {
        type: 'replace-socket',
        target: target.node.source,
        source: layout.source.slice(dragNode.source.from, dragNode.source.to)
      },
      zone: {bounds: target.node.bounds}
    };
  }
  // Dropping a comment to the right of a bare statement, or a container's
  // header line (`if x:`, `for y in z:`, ...), attaches it inline instead of
  // reordering it as a sibling line.
  if (dragNode?.kind === 'comment' && (target?.node?.kind === 'statement' || target?.kind === 'container-header')) {
    const headerBounds = target.kind === 'container-header' ? target.node.regions.header : target.node.bounds;
    if (point.x >= headerBounds.right && !sameRange(dragNode.source, target.node.source)) {
      return {
        operation: {
          type: 'move-comment', source: dragNode.source,
          destination: {from: target.node.source.from, to: target.node.source.to},
          placement: 'line-end'
        },
        zone: {bounds: headerBounds}
      };
    }
  }
  // Standalone comments and container headers participate in their suite's
  // vertical sibling order. A container body/footer retains its structural
  // insertion zones; only the header gets before/after behavior. An inline
  // comment is a child of its statement rather than a suite-level sibling, so
  // it borrows its owning statement's position for this purpose.
  const inlineOwner = target?.node?.kind === 'comment' && target.node.metadata?.inline
    ? findParent(layout.root, target.node.id) : undefined;
  const targetNode = inlineOwner ?? target?.node;
  if (targetNode?.kind !== 'statement' && targetNode?.kind !== 'comment' && target?.kind !== 'container-header') return undefined;
  const targetBounds = target.kind === 'container-header' ? target.node.regions.header : targetNode.bounds;
  const before = point.y < (targetBounds.top + targetBounds.bottom) / 2;
  if (target.kind === 'container-header' && !before) {
    const zone = target.node.insertionZones.find((candidate) => candidate.role === 'before-sibling') ??
      target.node.insertionZones.find((candidate) => candidate.role === 'body-end');
    return zone ? {destination: zone.destination, zone} : undefined;
  }
  const parent = findParent(layout.root, targetNode.id);
  if (!parent) return undefined;
  if (targetNode.metadata?.type === 'Pass' && parent.metadata?.emptySuitePass) {
    const from = parent.metadata.bodyEnd ?? parent.source.to;
    return {
      destination: {
        from, to: from,
        indentation: parent.metadata.bodyIndentation ?? '',
        emptySuitePass: parent.metadata.emptySuitePass
      },
      zone: {bounds: targetNode.bounds}
    };
  }
  const index = parent.children.findIndex((child) => child.id === targetNode.id);
  const zone = before
    ? parent.insertionZones.find((candidate) => candidate.role === 'before-sibling' && candidate.destination.from === targetNode.source.from)
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

// A release above or below the whole rendered document — not just a gap
// between two rows — reorders a top-level statement or comment to the very
// start or end instead of requiring a pixel-precise drop on a thin gap.
// Sockets and other expression drags fall through to the ordinary outside-
// canvas delete instead, since "top/bottom of the document" is meaningless
// for them.
function escapeDestination(layout, point, dragNode, copy) {
  if (dragNode?.kind !== 'statement' && dragNode?.kind !== 'container' && dragNode?.kind !== 'comment') return undefined;
  const zones = layout.root.insertionZones;
  const zone = point.y < 0 ? zones.at(0) : point.y > layout.bounds.bottom ? zones.at(-1) : undefined;
  if (!zone) return undefined;
  const kind = dragNode.kind === 'container' ? 'statement' : dragNode.kind;
  return {
    operation: copy
      ? {type: 'copy-node', source: dragNode.source, kind, destination: zone.destination}
      : {type: dragNode.kind === 'comment' ? 'move-comment' : 'move-statement', source: dragNode.source, destination: zone.destination},
    zone
  };
}

function dropTargetAtPoint(layout, point) {
  const direct = hitTestBlockLayout(layout, point);
  if (direct?.kind === 'insertion' || isSiblingDropTarget(direct) || isSocketNode(direct?.node)) return direct;
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
  return node.kind === 'statement' || node.kind === 'container' || node.kind === 'comment' || isExpressionNode(node);
}

function isDeletable(node) {
  return node.kind === 'statement' || node.kind === 'container' || node.kind === 'comment' || isSocketNode(node);
}

function isExpressionNode(node) { return node?.kind === 'socket' || node?.kind === 'recovery-socket'; }
function isSocketNode(node) { return node?.kind === 'socket' || node?.kind === 'recovery-socket'; }
function sameRange(left, right) { return left?.from === right?.from && left?.to === right?.to; }

function layoutNodeForElement(layout, element) {
  const id = element?.closest?.('[data-droplet-layout-id]')?.dataset.dropletLayoutId;
  return id ? layout.nodes.find((node) => node.id === id) : undefined;
}

function paletteSource(event) {
  const source = event.dataTransfer?.getData('application/x-droplet-statement');
  return typeof source === 'string' && source.length ? source : undefined;
}

function isPaletteDrag(event) {
  return [...(event.dataTransfer?.types ?? [])].includes('application/x-droplet-statement');
}

function pointFor(svg, event) {
  const bounds = svg.getBoundingClientRect();
  return {x: event.clientX - bounds.left, y: event.clientY - bounds.top};
}

function isOutsideCanvas(layout, point) {
  return point.x < 0 || point.y < 0 || point.x > layout.bounds.right + 16 || point.y > layout.bounds.bottom + 16;
}

function renderDragPreviews(svg, layout, node, point, zone) {
  clearDragPreviews(svg);
  const document = svg.ownerDocument;
  const preview = createSubtreePreview(layout, node.id);
  const floating = document.createElementNS(SVG_NAMESPACE, 'g');
  floating.classList.add('droplet-drag-preview');
  floating.setAttribute('transform', `translate(${point.x + 12} ${point.y + 12})`);
  floating.setAttribute('opacity', '.85');
  floating.append(renderNode(preview, document, {showSocketText: true}));
  svg.append(floating);
  if (!zone) return;
  const placement = document.createElementNS(SVG_NAMESPACE, 'g');
  placement.classList.add('droplet-drop-preview');
  placement.setAttribute('transform', `translate(${zone.bounds.left} ${zone.bounds.top})`);
  placement.setAttribute('opacity', '.55');
  placement.append(renderNode(preview, document, {showSocketText: true}));
  const guide = document.createElementNS(SVG_NAMESPACE, 'rect');
  guide.classList.add('droplet-drop-guide');
  guide.setAttribute('x', String(zone.bounds.left));
  guide.setAttribute('y', String(zone.bounds.top + 4));
  guide.setAttribute('width', String(zone.bounds.right - zone.bounds.left));
  guide.setAttribute('height', '3');
  guide.setAttribute('fill', '#4d7fb5');
  svg.append(placement, guide);
}

function renderExternalDropGuide(svg, zone) {
  clearDragPreviews(svg);
  if (!zone) return;
  const guide = svg.ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
  guide.classList.add('droplet-drop-guide');
  guide.setAttribute('x', String(zone.bounds.left));
  guide.setAttribute('y', String(zone.bounds.top + 4));
  guide.setAttribute('width', String(zone.bounds.right - zone.bounds.left));
  guide.setAttribute('height', '3');
  guide.setAttribute('fill', '#4d7fb5');
  svg.append(guide);
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

function renderSelection(svg, node, document) {
  svg.querySelector('.droplet-block-selection')?.remove();
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.classList.add('droplet-block-selection');
  rect.setAttribute('x', String(node.bounds.left - 3));
  rect.setAttribute('y', String(node.bounds.top - 3));
  rect.setAttribute('width', String(node.bounds.right - node.bounds.left + 6));
  rect.setAttribute('height', String(node.bounds.bottom - node.bounds.top + 6));
  rect.setAttribute('rx', '6');
  rect.setAttribute('fill', 'rgba(245, 158, 11, .10)');
  rect.setAttribute('stroke', '#d97706');
  rect.setAttribute('stroke-width', '2.5');
  rect.setAttribute('stroke-dasharray', '4 2');
  rect.setAttribute('pointer-events', 'none');
  svg.dataset.dropletSelectedId = node.id;
  svg.append(rect);
}

function renderNode(node, document, options = {}) {
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('data-droplet-layout-id', node.id);
  group.setAttribute('data-droplet-kind', node.kind);
  group.setAttribute('data-droplet-from', String(node.source.from));
  group.setAttribute('data-droplet-to', String(node.source.to));
  group.setAttribute('role', 'treeitem');
  const socketChildren = node.children.filter((child) => child.kind === 'socket' || child.kind === 'recovery-socket');
  const otherChildren = node.children.filter((child) => child.kind !== 'socket' && child.kind !== 'recovery-socket');
  if (node.kind === 'container') {
    renderContainerFrame(group, node, document);
    for (const child of socketChildren) group.append(renderNode(child, document, options));
    renderSourceLabels(group, node, node.regions.header.left + 8, node.regions.header.top + 20, document);
  } else if (node.kind === 'whitespace') {
    renderWhitespace(group, node, document);
  } else if (node.kind === 'socket' || node.kind === 'recovery-socket') {
    renderSocket(group, node, document, options);
  } else {
    renderAtomicFrame(group, node, document);
    for (const child of socketChildren) group.append(renderNode(child, document, options));
    renderSourceLabels(group, node, node.bounds.left + 8, node.bounds.top + 20, document);
  }
  for (const child of otherChildren) group.append(renderNode(child, document, options));
  return group;
}

function renderContainerFrame(group, node, document) {
  const {header, footer} = node.regions;
  // A colon-terminated header (Python's `if x:`, `for y in z:`, ...) is the
  // only shape this "snake" styling targets; brace-bodied languages such as
  // JavaScript keep the plain frame.
  const isSnake = isColonHeader(node);
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  const radius = 4;
  // The box corners share the footer's fixed 10px height with each other, so
  // their radius stays small; the wave-to-bar blends have a full body height
  // to work with and can afford a much more generous curve.
  const blendRadius = 12;
  const spine = footer.left + 18;
  path.setAttribute('d', [
    // The top-left corner is where the closing wavy edge blends back in, so
    // it starts at blendRadius rather than the smaller box-corner radius.
    `M ${header.left + (isSnake ? blendRadius : radius)} ${header.top}`,
    `H ${header.right - radius}`,
    `Q ${header.right} ${header.top} ${header.right} ${header.top + radius}`,
    `V ${header.bottom - radius}`,
    `Q ${header.right} ${header.bottom} ${header.right - radius} ${header.bottom}`,
    // Round each place a wavy edge meets a flat bar, so the wave blends into
    // the top/bottom bars instead of turning a sharp corner into the curve.
    isSnake ? `H ${spine + blendRadius}` : `H ${spine}`,
    ...(isSnake ? [
      `Q ${spine} ${header.bottom} ${spine} ${header.bottom + blendRadius}`,
      ...wavySpine(spine, header.bottom + blendRadius, footer.top - blendRadius),
      `Q ${spine} ${footer.top} ${spine + blendRadius} ${footer.top}`
    ] : [`V ${footer.top}`]),
    `H ${footer.right - radius}`,
    `Q ${footer.right} ${footer.top} ${footer.right} ${footer.top + radius}`,
    `V ${footer.bottom - radius}`,
    `Q ${footer.right} ${footer.bottom} ${footer.right - radius} ${footer.bottom}`,
    isSnake ? `H ${header.left + blendRadius}` : `H ${spine}`,
    // Close the snake's body with a wavy outer-left edge back up to the header.
    ...(isSnake ? [
      `Q ${header.left} ${footer.bottom} ${header.left} ${footer.bottom - blendRadius}`,
      ...wavySpine(header.left, footer.bottom - blendRadius, header.top + blendRadius),
      `Q ${header.left} ${header.top} ${header.left + blendRadius} ${header.top}`,
      'Z'
    ] : [])
  ].join(' '));
  path.setAttribute('fill', isSnake ? SNAKE_FILL : 'none');
  path.setAttribute('stroke', isSnake ? SNAKE_STROKE : '#246ca8');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  group.append(path);
  if (isSnake) renderSnakeFace(group, header, document);
}

function isColonHeader(node) {
  return typeof node.text === 'string' && node.text.trimEnd().endsWith(':');
}

// A gentle wave down a body edge, in place of a straight line, so a wrapping
// if/for block reads as a snake curled around its children. The offset is a
// function of absolute document y (not distance travelled), so every edge —
// including a nested container's own spine and left border — ripples in the
// same phase instead of each restarting its own wave at a different height.
function wavySpine(x, yFrom, yTo, amplitude = 1.1, wavelength = 40) {
  if (yFrom === yTo) return [];
  const direction = yTo > yFrom ? 1 : -1;
  const sampleStep = wavelength / 6;
  const commands = [];
  let y = yFrom;
  while (direction > 0 ? y < yTo : y > yTo) {
    y = direction > 0 ? Math.min(y + sampleStep, yTo) : Math.max(y - sampleStep, yTo);
    commands.push(`L ${x + amplitude * Math.sin((2 * Math.PI * y) / wavelength)} ${y}`);
  }
  return commands;
}

// The colon that ends the header already reads as the snake's eyes; add
// only a small forked tongue flicking out past it.
function renderSnakeFace(group, header, document) {
  const centerY = (header.top + header.bottom) / 2;
  const tongue = document.createElementNS(SVG_NAMESPACE, 'path');
  const tongueLeft = header.right + 2;
  const tongueY = centerY + 4;
  tongue.setAttribute('d', [
    `M ${tongueLeft} ${tongueY}`,
    `L ${tongueLeft + 8} ${tongueY}`,
    `L ${tongueLeft + 13} ${tongueY - 3}`,
    `M ${tongueLeft + 8} ${tongueY}`,
    `L ${tongueLeft + 13} ${tongueY + 3}`
  ].join(' '));
  tongue.setAttribute('fill', 'none');
  tongue.setAttribute('stroke', SNAKE_TONGUE);
  tongue.setAttribute('stroke-width', '1.5');
  tongue.setAttribute('stroke-linecap', 'round');
  group.append(tongue);
}

function renderAtomicFrame(group, node, document) {
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.setAttribute('x', String(node.bounds.left));
  rect.setAttribute('y', String(node.bounds.top));
  rect.setAttribute('width', String(node.bounds.right - node.bounds.left));
  rect.setAttribute('height', String(node.bounds.bottom - node.bounds.top));
  rect.setAttribute('rx', '4');
  rect.setAttribute('fill', node.kind === 'comment' ? '#f0f0f0' : '#fff');
  rect.setAttribute('stroke', node.kind === 'comment' ? '#999' : '#7a9ec4');
  group.append(rect);
}

function renderSocket(group, node, document, {showSocketText = false} = {}) {
  const rect = document.createElementNS(SVG_NAMESPACE, 'rect');
  rect.setAttribute('x', String(node.bounds.left));
  rect.setAttribute('y', String(node.bounds.top));
  rect.setAttribute('width', String(node.bounds.right - node.bounds.left));
  rect.setAttribute('height', String(node.bounds.bottom - node.bounds.top));
  rect.setAttribute('rx', '3');
  rect.setAttribute('fill', node.kind === 'recovery-socket' ? '#ffecd7' : '#eaf4ff');
  rect.setAttribute('stroke', node.kind === 'recovery-socket' ? '#b96b25' : '#4d7fb5');
  rect.setAttribute('stroke-width', '1.25');
  group.append(rect);
  if (showSocketText) {
    const label = createLabel(node.text, (node.bounds.left + node.bounds.right) / 2, node.bounds.top + 20, document);
    label.setAttribute('text-anchor', 'middle');
    group.append(label);
  }
}

function renderSourceLabels(group, node, left, top, document) {
  const sockets = node.children.filter((child) => child.kind === 'socket' || child.kind === 'recovery-socket')
    .sort((first, second) => first.source.from - second.source.from);
  if (!sockets.length) {
    group.append(createLabel(node.text, left, top, document));
    return;
  }
  let sourceCursor = node.source.from;
  let visualCursor = left;
  for (const socket of sockets) {
    const from = sourceCursor - node.source.from;
    const to = socket.source.from - node.source.from;
    const prefix = node.text.slice(from, to);
    if (prefix) group.append(createLabel(prefix, visualCursor, top, document));
    group.append(createLabel(socket.text, socket.textLeft, top, document));
    sourceCursor = socket.source.to;
    visualCursor = socket.bounds.right + 4;
  }
  const suffix = node.text.slice(sourceCursor - node.source.from);
  if (suffix) group.append(createLabel(suffix, visualCursor, top, document));
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
const SNAKE_STROKE = '#5f8a41';
const SNAKE_FILL = 'rgba(122, 163, 88, .12)';
const SNAKE_TONGUE = '#c23b3b';
