import {createBlockLayout, hitTestBlockLayout} from './block-surface.js';

/**
 * DOM/SVG host for a BlockSurface layout. It owns visual geometry only: source
 * and editing remain with the CodeMirror adapter that supplies projections.
 */
export class BlockSurface {
  #parent;
  #dom;
  #svg;
  #onSelect;
  #layoutOptions;
  #layout;

  constructor({parent, onSelect, layoutOptions = {}}) {
    if (!parent?.ownerDocument) throw new TypeError('A BlockSurface parent element is required');
    if (onSelect !== undefined && typeof onSelect !== 'function') throw new TypeError('onSelect must be a function');
    this.#parent = parent;
    this.#onSelect = onSelect;
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
    if (!this.#layout || event.defaultPrevented) return;
    const bounds = this.#svg.getBoundingClientRect();
    const target = hitTestBlockLayout(this.#layout, {x: event.clientX - bounds.left, y: event.clientY - bounds.top});
    if (target?.node?.source) this.#onSelect?.(target.node.source);
  }
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
    `Q ${footer.right} ${footer.top} ${footer.right} ${footer.top + radius}`
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
