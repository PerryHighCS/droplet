import assert from 'node:assert/strict';
import test from 'node:test';

import {JSDOM} from 'jsdom';

import {BlockSurface} from '../src/block-surface-dom.js';

test('renders a projection as independent SVG block geometry and sends source-backed selection', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const selected = [];
  const surface = new BlockSurface({parent: host, onSelect: (range) => selected.push(range)});
  surface.update(projection());
  surface.setVisible(true);

  assert.equal(surface.element.style.display, 'block');
  assert.equal(host.querySelectorAll('[data-droplet-kind="container"]').length, 1);
  assert.equal(host.querySelectorAll('[data-droplet-kind="statement"]').length, 1);
  assert.equal(host.querySelectorAll('[data-droplet-kind="whitespace"]').length, 1);

  const svg = host.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, clientX: 26, clientY: 34}));
  assert.deepEqual(selected, [{from: 12, to: 19}]);

  surface.destroy();
  assert.equal(host.children.length, 0);
});

test('uses a layout insertion zone for one statement move intent and matching previews', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const operations = [];
  const surface = new BlockSurface({parent: host, onOperation: (operation) => operations.push(operation)});
  surface.update(twoStatements());
  const svg = host.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0, clientX: 2, clientY: 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0, clientX: 2, clientY: 30}));
  assert.equal(svg.querySelectorAll('.droplet-drag-preview, .droplet-drop-preview, .droplet-drop-guide').length, 3);
  svg.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, button: 0, clientX: 2, clientY: 30}));

  assert.deepEqual(operations, [{
    type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 8, to: 8, indentation: ''}
  }]);
});

test('uses the upper and lower halves of a statement as before and after drop targets', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, first, second.bounds.left + 2, second.bounds.top + 2);
  drag(svg, dom.window, first, second.bounds.left + 2, second.bounds.bottom - 2);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 8, to: 8, indentation: ''}},
    {type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 17, to: 17, indentation: ''}}
  ]);
});

test('deletes a selected block with Delete and a dragged block outside the canvas', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));
  surface.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', {bubbles: true, key: 'Delete'}));
  drag(svg, dom.window, first, -12, first.bounds.top + 2);

  assert.deepEqual(operations, [
    {type: 'delete-node', source: {from: 8, to: 16}, kind: 'statement'},
    {type: 'delete-node', source: {from: 0, to: 7}, kind: 'statement'}
  ]);
});

test('reorders a statement to the top or bottom when dropped above or below the document', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  // Released above the whole document: move to the very top (a no-op here,
  // since "first" is already first, but it proves the drop resolved instead
  // of being swallowed or deleted).
  drag(svg, dom.window, first, first.bounds.left, -20);
  // Released below the whole document: move to the very end.
  drag(svg, dom.window, first, first.bounds.left, surface.layout.bounds.bottom + 20);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 0, to: 0, indentation: ''}},
    {type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 17, to: 17, indentation: ''}}
  ]);
});

test('completes a drop on pointercancel instead of losing the release', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');

  // A trackpad-driven drag can end with the browser delivering pointercancel
  // instead of pointerup (a gesture interrupting the sequence). Its own
  // coordinates are not trustworthy, so the drop must still resolve using
  // the last known pointermove position rather than being silently dropped.
  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0, clientX: -400, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointercancel', {bubbles: true}));

  assert.deepEqual(operations, [{type: 'delete-node', source: {from: 0, to: 7}, kind: 'statement'}]);
});

test('completes a drop released outside the SVG entirely, via the document-level fallback', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');

  // Pointer capture should keep the release targeted at the SVG even once
  // the cursor leaves it (dragging above the surface), but this isn't fully
  // reliable across every browser/input-device combination. Dispatching the
  // release on the document itself, never touching the SVG, simulates that
  // and checks the document-level fallback still completes the drop.
  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0, clientX: first.bounds.left, clientY: -50}));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, clientX: first.bounds.left, clientY: -50}));

  assert.deepEqual(operations, [{type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 0, to: 0, indentation: ''}}]);
});

test('marks the selected block with a visible SVG outline', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host')});
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const [first, second] = surface.layout.nodes.filter((node) => node.kind === 'statement');

  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  assert.equal(svg.dataset.dropletSelectedId, 'first');
  assert.equal(svg.querySelector('.droplet-block-selection').getAttribute('stroke'), '#d97706');

  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));
  assert.equal(svg.dataset.dropletSelectedId, 'second');
  assert.equal(svg.querySelectorAll('.droplet-block-selection').length, 1);
});

test('uses Ctrl-drag to emit a copy operation instead of a move', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, first, second.bounds.left + 2, second.bounds.top + 2, {ctrlKey: true});

  assert.deepEqual(operations, [{
    type: 'copy-node', source: {from: 0, to: 7}, kind: 'statement', destination: {from: 8, to: 8, indentation: ''}
  }]);
});

test('drags an expression socket onto another socket as a replacement operation', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(assignmentSockets());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const target = surface.layout.nodes.find((node) => node.id === 'target');
  const value = surface.layout.nodes.find((node) => node.id === 'value');

  drag(svg, dom.window, target, value.bounds.left + 2, value.bounds.top + 2);

  assert.deepEqual(operations, [{
    type: 'replace-socket', target: {from: 9, to: 14}, source: 'target'
  }]);
});

test('drops an expression palette block onto a socket as a replacement operation', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(assignmentSockets());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const value = surface.layout.nodes.find((node) => node.id === 'value');

  dropPaletteBlock(surface, dom.window, 'application/x-droplet-expression', 'value + value',
    value.bounds.left + 2, value.bounds.top + 2);

  assert.deepEqual(operations, [{type: 'replace-socket', target: {from: 9, to: 14}, source: 'value + value'}]);
});

test('drops an expression palette block into a gap as a standalone statement line', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const bodyEnd = surface.layout.insertionZones.find((zone) => zone.role === 'body-end');

  dropPaletteBlock(surface, dom.window, 'application/x-droplet-expression', 'value + value',
    bodyEnd.bounds.left + 2, bodyEnd.bounds.top + 2);

  // A bare expression is only valid Python as its own statement line, unlike
  // palette statement sources, which already carry a trailing newline.
  assert.deepEqual(operations, [{type: 'insert-statement', destination: bodyEnd.destination, source: 'value + value\n'}]);
});

test('opens the inline editor for a compound socket\'s own leaf socket', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onSocketEdit: () => {}});
  surface.update(compoundAssignmentSockets());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const left = surface.layout.nodes.find((node) => node.id === 'left');

  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
    clientX: left.bounds.left + 2, clientY: left.bounds.top + 2}));

  const input = surface.element.querySelector('.droplet-socket-editor');
  assert.ok(input);
  assert.equal(input.value, 'value');
});

test('selects but does not open a free-text editor for a compound socket as a whole', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onSocketEdit: () => {}});
  surface.update(compoundAssignmentSockets());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const binop = surface.layout.nodes.find((node) => node.id === 'binop');
  const left = surface.layout.nodes.find((node) => node.id === 'left');
  const right = surface.layout.nodes.find((node) => node.id === 'right');
  // A point inside the compound socket's own bounds but between its two
  // nested sockets - i.e. over the "+" operator text, not over "value".
  const operatorX = (left.bounds.right + right.bounds.left) / 2;

  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
    clientX: operatorX, clientY: binop.bounds.top + 2}));

  assert.equal(surface.element.querySelector('.droplet-socket-editor'), null);
  assert.equal(svg.dataset.dropletSelectedId, 'binop');
});

test('renders a compound socket\'s operands once each, not duplicated by its own flat text', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host')});
  surface.update(compoundAssignmentSockets());
  const svg = surface.element.querySelector('svg');

  // The enclosing statement's own label pass used to also draw the compound
  // socket's flat "value + value" text on top of the nested rendering the
  // socket already did for itself, overlapping the second "value".
  const labels = [...svg.querySelectorAll('text')].map((node) => node.textContent);
  assert.deepEqual(labels, ['value', ' + ', 'value', 'target', ' = ']);
});

test('preserves whitespace in gap text labels so an infix operator does not hug its left operand', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host')});
  surface.update(compoundAssignmentSockets());
  const svg = surface.element.querySelector('svg');

  // SVG text collapses leading/trailing whitespace unless told otherwise; a
  // gap label of " + " rendered without white-space: pre would visually trim
  // down to "+" flush against the preceding socket, even though the layout
  // still reserves the full measured width for it.
  const operatorLabel = [...svg.querySelectorAll('text')].find((node) => node.textContent === ' + ');
  assert.equal(operatorLabel.style.whiteSpace, 'pre');
});

test('uses the upper and lower halves of a standalone comment as sibling drop targets', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(statementsWithStandaloneComment());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const comment = surface.layout.nodes.find((node) => node.id === 'comment');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, second, comment.bounds.left + 2, comment.bounds.top + 2);
  drag(svg, dom.window, second, comment.bounds.left + 2, comment.bounds.bottom - 2);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 21, to: 29}, destination: {from: 8, to: 8, indentation: ''}},
    {type: 'move-statement', source: {from: 21, to: 29}, destination: {from: 21, to: 21, indentation: ''}}
  ]);
});

test('uses the upper and lower halves of a blank line as sibling drop targets', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(statementsWithBlankLine());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const blank = surface.layout.nodes.find((node) => node.id === 'blank');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, second, blank.bounds.left + 2, blank.bounds.top + 2);
  drag(svg, dom.window, second, blank.bounds.left + 2, blank.bounds.bottom - 2);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 9, to: 16}, destination: {from: 8, to: 8, indentation: ''}},
    {type: 'move-statement', source: {from: 9, to: 16}, destination: {from: 9, to: 9, indentation: ''}}
  ]);
});

test('starts a drag by picking up an inline comment directly', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(statementWithInlineComment());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const note = surface.layout.nodes.find((node) => node.id === 'note');
  const bodyEnd = surface.layout.insertionZones.find((zone) => zone.role === 'body-end');

  drag(svg, dom.window, note, bodyEnd.bounds.left + 2, bodyEnd.bounds.top + 2);

  assert.deepEqual(operations, [{type: 'move-comment', source: {from: 11, to: 17}, destination: bodyEnd.destination}]);
});

test('drops a statement onto an inline comment using its owning statement position', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(statementWithInlineComment());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const note = surface.layout.nodes.find((node) => node.id === 'note');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, second, note.bounds.left + 2, note.bounds.top + 2);

  assert.deepEqual(operations, [{type: 'move-statement', source: {from: 18, to: 26}, destination: {from: 0, to: 0, indentation: ''}}]);
});

test('drags a comment to the right of a bare statement to attach it inline', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(statementWithTrailingComment());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const comment = surface.layout.nodes.find((node) => node.id === 'comment');

  drag(svg, dom.window, comment, first.bounds.right + 4, first.bounds.top + 2);

  assert.deepEqual(operations, [{
    type: 'move-comment', source: {from: 17, to: 24}, destination: {from: 0, to: 7}, placement: 'line-end'
  }]);
});

test('drags a comment to the right of a container header to attach it inline', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(containerWithTrailingComment());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const ready = surface.layout.nodes.find((node) => node.id === 'ready');
  const comment = surface.layout.nodes.find((node) => node.id === 'comment');

  drag(svg, dom.window, comment, ready.regions.header.right + 4, ready.regions.header.top + 2);

  assert.deepEqual(operations, [{
    type: 'move-comment', source: {from: 20, to: 27}, destination: {from: 0, to: 20}, placement: 'line-end'
  }]);
});

test('uses the upper and lower halves of a container header as sibling drop targets', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(nestedStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const inner = surface.layout.nodes.find((node) => node.id === 'inner');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, second, inner.regions.header.left + 2, inner.regions.header.top + 2);
  drag(svg, dom.window, second, inner.regions.header.left + 2, inner.regions.header.bottom - 2);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 36, to: 44}, destination: {from: 12, to: 12, indentation: '  '}},
    {type: 'move-statement', source: {from: 36, to: 44}, destination: {from: 26, to: 26, indentation: '    '}}
  ]);
});

test('extends sibling drop target rows to either side of their rendered blocks', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(nestedStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  drag(svg, dom.window, first, second.bounds.right + 12, second.bounds.top + 2);
  drag(svg, dom.window, first, second.bounds.left - 8, second.bounds.bottom - 2);

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 26, to: 33}, destination: {from: 36, to: 36, indentation: '  '}},
    {type: 'move-statement', source: {from: 26, to: 33}, destination: {from: 45, to: 45, indentation: '  '}}
  ]);
});

test('accepts an outer sibling dropped in the lower interior of a nested container footer', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(nestedStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const inner = surface.layout.nodes.find((node) => node.id === 'inner');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0,
    clientX: inner.regions.body.left + 2, clientY: inner.regions.footer.top + 8}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, button: 0,
    clientX: inner.regions.body.left + 2, clientY: inner.regions.footer.top + 8}));

  assert.deepEqual(operations, [{type: 'move-statement', source: {from: 36, to: 44},
    destination: {from: 34, to: 34, indentation: '    '}}]);
});

test('treats a synthetic pass as an empty-suite replacement target', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)});
  surface.update(passSuite());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const pass = surface.layout.nodes.find((node) => node.id === 'pass');

  drag(svg, dom.window, first, pass.bounds.left + 2, pass.bounds.top + 2);
  assert.deepEqual(operations, [{type: 'move-statement', source: {from: 18, to: 27},
    destination: {from: 18, to: 18, indentation: '  ', emptySuitePass: {from: 12, to: 16}}}]);
});

function projection() {
  const source = 'if ready:\n  first()\n\n';
  return {
    source,
    root: {
      id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
        id: 'if', kind: 'statement', from: 0, to: 20, editable: true,
        metadata: {blockRole: 'container', headerTo: 9, bodyEnd: 20},
        children: [
          {id: 'first', kind: 'statement', from: 12, to: 19, editable: true, metadata: {}, children: []},
          {id: 'blank', kind: 'whitespace', from: 20, to: 21, editable: false, metadata: {text: ''}, children: []}
        ]
      }]
    }
  };
}

function twoStatements() {
  const source = 'first()\nsecond()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'first', kind: 'statement', from: 0, to: 7, editable: true, metadata: {}, children: []},
      {id: 'second', kind: 'statement', from: 8, to: 16, editable: true, metadata: {}, children: []}
    ]
  }};
}

function statementsWithStandaloneComment() {
  const source = 'first()\n# standalone\nsecond()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'first', kind: 'statement', from: 0, to: 7, editable: true, metadata: {}, children: []},
      {id: 'comment', kind: 'comment', from: 8, to: 20, editable: true, metadata: {inline: false}, children: []},
      {id: 'second', kind: 'statement', from: 21, to: 29, editable: true, metadata: {}, children: []}
    ]
  }};
}

function statementsWithBlankLine() {
  const source = 'first()\n\nsecond()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'first', kind: 'statement', from: 0, to: 7, editable: true, metadata: {}, children: []},
      {id: 'blank', kind: 'whitespace', from: 8, to: 8, editable: false, metadata: {text: ''}, children: []},
      {id: 'second', kind: 'statement', from: 9, to: 16, editable: true, metadata: {}, children: []}
    ]
  }};
}

function statementWithInlineComment() {
  const source = 'first = 1  # note\nsecond()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'first', kind: 'statement', from: 0, to: 9, editable: true, metadata: {}, children: [
        {id: 'note', kind: 'comment', from: 11, to: 17, editable: true, metadata: {inline: true}, children: []}
      ]},
      {id: 'second', kind: 'statement', from: 18, to: 26, editable: true, metadata: {}, children: []}
    ]
  }};
}

function statementWithTrailingComment() {
  const source = 'first()\nsecond()\n# aside\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'first', kind: 'statement', from: 0, to: 7, editable: true, metadata: {}, children: []},
      {id: 'second', kind: 'statement', from: 8, to: 16, editable: true, metadata: {}, children: []},
      {id: 'comment', kind: 'comment', from: 17, to: 24, editable: true, metadata: {inline: false}, children: []}
    ]
  }};
}

function containerWithTrailingComment() {
  const source = 'if ready:\n  first()\n# aside\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'ready', kind: 'statement', from: 0, to: 20, editable: true,
        metadata: {blockRole: 'container', headerTo: 9, bodyEnd: 20, bodyIndentation: '  '},
        children: [{id: 'first', kind: 'statement', from: 12, to: 19, editable: true, metadata: {}, children: []}]},
      {id: 'comment', kind: 'comment', from: 20, to: 27, editable: true, metadata: {inline: false}, children: []}
    ]
  }};
}

function assignmentSockets() {
  const source = 'target = value\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'assign', kind: 'statement', from: 0, to: 14, editable: true, metadata: {}, children: [
        {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, metadata: {socketRole: 'assignment-target'}, children: []},
        {id: 'value', kind: 'socket', from: 9, to: 14, editable: true, metadata: {socketRole: 'assignment-value'}, children: []}
      ]
    }]
  }};
}

function compoundAssignmentSockets() {
  const source = 'target = value + value\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'assign', kind: 'statement', from: 0, to: 22, editable: true, metadata: {}, children: [
        {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, metadata: {socketRole: 'assignment-target'}, children: []},
        {id: 'binop', kind: 'socket', from: 9, to: 22, editable: true, metadata: {socketRole: 'assignment-value'}, children: [
          {id: 'left', kind: 'socket', from: 9, to: 14, editable: true, metadata: {socketRole: 'expression'}, children: []},
          {id: 'right', kind: 'socket', from: 17, to: 22, editable: true, metadata: {socketRole: 'expression'}, children: []}
        ]}
      ]
    }]
  }};
}

function nestedStatements() {
  const source = 'if outer:\n  if ready:\n    first()\n  second()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'outer', kind: 'statement', from: 0, to: source.length, editable: true,
      metadata: {blockRole: 'container', headerTo: 9, bodyEnd: source.length, bodyIndentation: '  '}, children: [{
        id: 'inner', kind: 'statement', from: 12, to: 34, editable: true,
        metadata: {blockRole: 'container', headerTo: 21, bodyEnd: 34, bodyIndentation: '    '},
        children: [{id: 'first', kind: 'statement', from: 26, to: 33, editable: true, metadata: {}, children: []}
        ]
      }, {id: 'second', kind: 'statement', from: 36, to: 44, editable: true, metadata: {}, children: []}]
    }]
  }};
}

function passSuite() {
  const source = 'if ready:\n  pass\nfirst = 1\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'ready', kind: 'statement', from: 0, to: 18, editable: true,
      metadata: {blockRole: 'container', headerTo: 9, bodyEnd: 18, bodyIndentation: '  ', emptySuitePass: {from: 12, to: 16}},
      children: [{id: 'pass', kind: 'statement', from: 12, to: 16, editable: true, metadata: {type: 'Pass'}, children: []}]
    }, {id: 'first', kind: 'statement', from: 18, to: 27, editable: true, metadata: {}, children: []}]
  }};
}

function drag(svg, window, source, x, y, modifiers = {}) {
  svg.dispatchEvent(new window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: source.bounds.left + 2, clientY: source.bounds.top + 2, ...modifiers}));
  svg.dispatchEvent(new window.MouseEvent('pointermove', {bubbles: true, button: 0, clientX: x, clientY: y}));
  svg.dispatchEvent(new window.MouseEvent('pointerup', {bubbles: true, button: 0, clientX: x, clientY: y}));
}

// JSDOM doesn't implement DataTransfer/DragEvent, so mimic the parts the
// palette-drop handlers actually read: dataTransfer.types (checked during
// dragover, before getData is reliably readable in real browsers) and
// dataTransfer.getData (read at drop).
function dropPaletteBlock(surface, window, mimeType, source, x, y) {
  const event = new window.Event('drop', {bubbles: true, cancelable: true});
  Object.assign(event, {clientX: x, clientY: y});
  event.dataTransfer = {types: [mimeType], getData: (type) => (type === mimeType ? source : '')};
  surface.element.dispatchEvent(event);
}
