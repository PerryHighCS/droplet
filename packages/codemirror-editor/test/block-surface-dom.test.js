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

test('accounts for a scaled SVG when hit-testing a click, matching the socket editor\'s own scale handling', () => {
  // pointFor read event.clientX/Y as if they were already in the SVG's own
  // (unscaled) declared coordinate space - a host page rendering the SVG at
  // a different size than its own declared width (a CSS width override, a
  // transform: scale(), a responsive container) shifts every click's real
  // target away from where it hit-tested, growing with distance from the
  // SVG's own origin. #svgOffset already accounts for exactly this when
  // positioning the inline socket editor; hit-testing now does the same.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const selected = [];
  const surface = new BlockSurface({parent: host, onSelect: (range) => selected.push(range)});
  surface.update(projection());
  surface.setVisible(true);

  const svg = host.querySelector('svg');
  const declaredWidth = Number(svg.getAttribute('width'));
  svg.getBoundingClientRect = () => ({left: 0, top: 0, width: declaredWidth / 2});
  // Half the coordinates that select the same target unscaled (see the test
  // above) - correct only once divided back out by the same 0.5 scale.
  svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, clientX: 13, clientY: 17}));

  assert.deepEqual(selected, [{from: 12, to: 19}]);
  surface.destroy();
});

test('renders every line of a multi-line opaque node, not just its first', () => {
  // createLabel used to truncate a label's text at its own first line break
  // before rendering it as a single SVG <text> - parse recovery keeping a
  // whole malformed multi-line document as one opaque node is the common
  // case where that silently dropped everything past the first line while
  // CodeMirror's own text view stayed hidden underneath the block surface.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const surface = new BlockSurface({parent: host});
  surface.update(opaqueMultiLineProjection());
  surface.setVisible(true);

  const label = host.querySelector('[data-droplet-kind="opaque-statement"] text');
  const tspans = label.querySelectorAll('tspan');
  assert.equal(tspans.length, 3, 'every line must get its own tspan, not just the first');
  assert.deepEqual([...tspans].map((tspan) => tspan.textContent), ['if score >', 'broken second line', 'x']);
  assert.equal(label.textContent, 'if score >broken second linex', 'the full text must still be present, line breaks aside');

  const frame = host.querySelector('[data-droplet-kind="opaque-statement"] rect');
  assert.equal(Number(frame.getAttribute('height')), 28 * 3, 'the frame must be tall enough to hold all three lines');

  surface.destroy();
});

test('steps a multi-line label\'s own tspans by an overridden lineHeight, not a fixed 28', () => {
  // layoutAtomic sizes an opaque node's box using layoutOptions.lineHeight
  // (settings.lineHeight), so a caller overriding it already gets a
  // correctly-tall box - but createLabel used to step each tspan down by a
  // fixed constant regardless, drifting every line after the first out of
  // that box once lineHeight was overridden away from the 28 default.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const surface = new BlockSurface({parent: host, layoutOptions: {lineHeight: 40}});
  surface.update(opaqueMultiLineProjection());
  surface.setVisible(true);

  const label = host.querySelector('[data-droplet-kind="opaque-statement"] text');
  const tspans = label.querySelectorAll('tspan');
  assert.deepEqual([...tspans].map((tspan) => tspan.getAttribute('dy')), [null, '40', '40']);

  const frame = host.querySelector('[data-droplet-kind="opaque-statement"] rect');
  assert.equal(Number(frame.getAttribute('height')), 40 * 3, 'the frame must still match the overridden line height');

  surface.destroy();
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

test('rejects dropping a statement on its own lower half instead of leaving a stray blank line behind', () => {
  // Hovering over the dragged statement's own (still-rendered) lower half
  // resolves to "insert before my own next sibling" - a destination outside
  // the dragged node's own range, so it isn't caught by the transform's
  // "destination inside my own range" no-op guard. Removing the statement's
  // own line and reinserting it right where its old next sibling starts
  // nets out to the same document *content*, but not the same document
  // *text*: it leaves a stray blank line where the original line used to be.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const lowerHalfY = (first.bounds.top + first.bounds.bottom) / 2 + 2;

  drag(svg, dom.window, first, first.bounds.left + 2, lowerHalfY);

  assert.deepEqual(operations, []);
});

test('rejects copying a container onto an insertion zone inside its own body', () => {
  // copy-node has no "destination inside my own range" guard the way
  // move-statement does (copying, unlike moving, never removes the source
  // first) - dropping a Ctrl-dragged container onto one of its own
  // insertion zones would splice a copy of its own text into its own body,
  // nesting it inside itself.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  const source = 'if (x) {\n  a();\n}\n';
  surface.update({source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {
        type: 'IfStatement', blockRole: 'container', headerTo: 9,
        bodyEnd: source.indexOf('}'), blockEnd: source.indexOf('}') + 1
      },
      children: [{id: 'a', kind: 'statement', from: source.indexOf('a()'), to: source.indexOf('a()') + 4, editable: true, metadata: {}, children: []}]
    }]
  }});
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const ifNode = surface.layout.nodes.find((node) => node.id === 'if');
  const bodyEndZone = ifNode.insertionZones.find((zone) => zone.role === 'body-end');

  drag(svg, dom.window, ifNode, bodyEndZone.bounds.left + 2, bodyEndZone.bounds.top + 2, {ctrlKey: true});

  assert.deepEqual(operations, []);
});

test('rejects copying a container onto its own body-end zone even when that zone sits past the container\'s own source range', () => {
  // targetWithinDraggedRange used to compare the insertion zone's own
  // destination.from against the dragged node's [from, to) range - but a
  // Python container's own bodyEnd (used for its body-end zone) includes the
  // suite's trailing line ending, so it is routinely greater than the
  // container AST node's own `to`. That put the container's own footer zone
  // outside its own checked range, letting a Ctrl-drag copy nest a copy of
  // the container inside its own body.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  const source = 'if x:\n  a()\n';
  const aFrom = source.indexOf('a()');
  surface.update({source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: aFrom + 3, editable: true,
      metadata: {type: 'If', blockRole: 'container', headerTo: 5, bodyEnd: source.length},
      children: [{id: 'a', kind: 'statement', from: aFrom, to: aFrom + 3, editable: true, metadata: {}, children: []}]
    }]
  }});
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const ifNode = surface.layout.nodes.find((node) => node.id === 'if');
  const bodyEndZone = ifNode.insertionZones.find((zone) => zone.role === 'body-end');
  assert.ok(bodyEndZone.destination.from > ifNode.source.to,
    'the fixture must actually exercise a body-end zone past the container\'s own source range');

  drag(svg, dom.window, ifNode, bodyEndZone.bounds.left + 2, bodyEndZone.bounds.top + 2, {ctrlKey: true});

  assert.deepEqual(operations, []);
});

test('reuses the drag preview elements across pointermoves within the same zone, not on every move', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: () => {}});
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');

  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));
  const floating = svg.querySelector('.droplet-drag-preview');
  const placement = svg.querySelector('.droplet-drop-preview');
  const guide = svg.querySelector('.droplet-drop-guide');
  assert.ok(floating && placement && guide);

  // A second move landing in the same "before second" half - same zone -
  // must not rebuild the placement/guide, only reposition the floating copy.
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0,
    clientX: second.bounds.left + 4, clientY: second.bounds.top + 3}));
  assert.equal(svg.querySelector('.droplet-drag-preview'), floating);
  assert.equal(svg.querySelector('.droplet-drop-preview'), placement);
  assert.equal(svg.querySelector('.droplet-drop-guide'), guide);

  // A move to the opposite half is a different zone: the placement and guide
  // are rebuilt, but the floating preview - which only ever needs a new
  // transform - is still the exact same element.
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.bottom - 2}));
  assert.equal(svg.querySelector('.droplet-drag-preview'), floating);
  assert.notEqual(svg.querySelector('.droplet-drop-preview'), placement);
  assert.notEqual(svg.querySelector('.droplet-drop-guide'), guide);

  svg.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.bottom - 2}));
});

test('draws a drag preview with the surface\'s own tabConnector notch, not a plain rect', () => {
  // updateDragPreviews used to pass only {showSocketText: true} to
  // renderNode, dropping the surface's own layoutOptions entirely - so a
  // consumer using layoutOptions.tabConnector (the notched, interlocking
  // block silhouette) got that shape on the stationary surface but a plain
  // rectangle on both drag-preview copies the moment a drag started.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'),
    onOperation: () => {},
    layoutOptions: {tabConnector: true}
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');
  const second = surface.layout.nodes.find((node) => node.id === 'second');
  assert.ok(svg.querySelector('[data-droplet-kind="statement"] > path'),
    'the stationary surface itself must already use the connector shape for this to be a meaningful comparison');

  svg.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.MouseEvent('pointermove', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));

  const floating = svg.querySelector('.droplet-drag-preview');
  const placement = svg.querySelector('.droplet-drop-preview');
  assert.ok(floating.querySelector('[data-droplet-kind="statement"] > path'),
    'the floating drag preview must use the connector shape too');
  assert.ok(placement.querySelector('[data-droplet-kind="statement"] > path'),
    'the drop-zone placement preview must use the connector shape too');

  svg.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, button: 0,
    clientX: second.bounds.left + 2, clientY: second.bounds.top + 2}));
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

test('cancels rather than completes a drop on a touch pointercancel', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const first = surface.layout.nodes.find((node) => node.id === 'first');

  // Unlike a trackpad-driven drag (see the test above), a touch pointercancel
  // means the OS took the gesture over for its own purposes (scrolling, a
  // system gesture) rather than the user releasing over a destination -
  // resolving it as a drop could move or delete a block the user never
  // actually let go of.
  svg.dispatchEvent(new dom.window.PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1, pointerType: 'touch',
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.PointerEvent('pointermove', {bubbles: true, button: 0, pointerId: 1, pointerType: 'touch',
    clientX: -400, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.PointerEvent('pointercancel', {bubbles: true, pointerId: 1, pointerType: 'touch'}));

  assert.deepEqual(operations, []);

  // The drag state must actually be cleared, not just left un-dispatched -
  // a fresh pointerdown/up right after should behave like an ordinary new
  // drag, not be swallowed by stale state from the cancelled one.
  svg.dispatchEvent(new dom.window.PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 2,
    clientX: first.bounds.left + 2, clientY: first.bounds.top + 2}));
  svg.dispatchEvent(new dom.window.PointerEvent('pointermove', {bubbles: true, button: 0, pointerId: 2,
    clientX: first.bounds.left, clientY: surface.layout.bounds.bottom + 20}));
  svg.dispatchEvent(new dom.window.PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 2,
    clientX: first.bounds.left, clientY: surface.layout.bounds.bottom + 20}));

  assert.deepEqual(operations, [
    {type: 'move-statement', source: {from: 0, to: 7}, destination: {from: 17, to: 17, indentation: ''}}
  ]);
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

test('an unrelated second pointer does not steer or end a drag the first pointer started', () => {
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

  svg.dispatchEvent(new dom.window.PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerId: 1, clientX: target.bounds.left + 2, clientY: target.bounds.top + 2
  }));
  // A second, unrelated pointer (a second touch, a simultaneous stylus) moves
  // over the surface and releases while pointer 1's drag is still in
  // progress. Neither should touch pointer 1's drag state.
  svg.dispatchEvent(new dom.window.PointerEvent('pointermove', {
    bubbles: true, button: 0, pointerId: 2, clientX: value.bounds.right + 50, clientY: value.bounds.bottom + 50
  }));
  svg.dispatchEvent(new dom.window.PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerId: 2, clientX: value.bounds.right + 50, clientY: value.bounds.bottom + 50
  }));
  assert.equal(operations.length, 0, 'the unrelated pointer must not end pointer 1\'s drag');

  svg.dispatchEvent(new dom.window.PointerEvent('pointermove', {
    bubbles: true, button: 0, pointerId: 1, clientX: value.bounds.left + 2, clientY: value.bounds.top + 2
  }));
  svg.dispatchEvent(new dom.window.PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerId: 1, clientX: value.bounds.left + 2, clientY: value.bounds.top + 2
  }));

  assert.deepEqual(operations, [{
    type: 'replace-socket', target: {from: 9, to: 14}, source: 'target'
  }]);
});

test('a second pointerdown mid-drag does not overwrite the drag the first pointer already started', () => {
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

  svg.dispatchEvent(new dom.window.PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerId: 1, clientX: target.bounds.left + 2, clientY: target.bounds.top + 2
  }));
  // A second, unrelated pointer presses a different movable node while
  // pointer 1's drag is still in progress. It must not replace pointer 1's
  // own drag state (its node, start point, or pointerId).
  svg.dispatchEvent(new dom.window.PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerId: 2, clientX: value.bounds.left + 2, clientY: value.bounds.top + 2
  }));

  svg.dispatchEvent(new dom.window.PointerEvent('pointermove', {
    bubbles: true, button: 0, pointerId: 1, clientX: value.bounds.left + 2, clientY: value.bounds.top + 2
  }));
  svg.dispatchEvent(new dom.window.PointerEvent('pointerup', {
    bubbles: true, button: 0, pointerId: 1, clientX: value.bounds.left + 2, clientY: value.bounds.top + 2
  }));

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

test('steps a compound socket\'s own multi-line label by an overridden lineHeight too', () => {
  // renderCompoundSocket's own renderSourceLabels call omitted the options
  // argument entirely (every other call site passes it through), so a
  // compound socket's own gap text (here the multi-line "+..." between its
  // two operand sockets) always stepped its tspans by the fixed 28 default,
  // ignoring layoutOptions.lineHeight, unlike every other label on the surface.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.querySelector('#host');
  const surface = new BlockSurface({parent: host, layoutOptions: {lineHeight: 40}});
  const source = 'target = value +\n  value\n';
  surface.update({source, root: {
    id: 'document', kind: 'document', from: 0, to: 24, editable: false, metadata: {}, children: [{
      id: 'assign', kind: 'statement', from: 0, to: 24, editable: true, metadata: {}, children: [
        {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, metadata: {socketRole: 'assignment-target'}, children: []},
        {id: 'binop', kind: 'socket', from: 9, to: 24, editable: true, metadata: {socketRole: 'assignment-value'}, children: [
          {id: 'left', kind: 'socket', from: 9, to: 14, editable: true, metadata: {socketRole: 'expression'}, children: []},
          {id: 'right', kind: 'socket', from: 19, to: 24, editable: true, metadata: {socketRole: 'expression'}, children: []}
        ]}
      ]
    }]
  }});
  surface.setVisible(true);

  const gapLabel = [...host.querySelectorAll('text')].find((text) => text.textContent.includes('+'));
  const tspans = gapLabel.querySelectorAll('tspan');
  assert.deepEqual([...tspans].map((tspan) => tspan.getAttribute('dy')), [null, '40']);
  surface.destroy();
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

test('positions the inline editor using local, scroll-invariant coordinates', () => {
  // #svgOffset's own left/top become the socket-editor input's CSS
  // position - an absolutely positioned sibling within #dom, the
  // scrollable element (overflow: auto), so they must be in #dom's own
  // local content coordinates, not raw viewport ones. #dom's own rect does
  // not move as its content scrolls, but the SVG's does, so their raw
  // difference alone drifts by exactly however far the surface has been
  // scrolled - doubling that drift once the browser also scrolls the
  // (already-local) input along with the rest of #dom's content.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onSocketEdit: () => {}});
  surface.update(compoundAssignmentSockets());
  const svg = surface.element.querySelector('svg');
  const left = surface.layout.nodes.find((node) => node.id === 'left');
  const openEditor = (clientY) => {
    svg.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0,
      clientX: left.bounds.left + 2, clientY}));
    return surface.element.querySelector('.droplet-socket-editor').style.top;
  };

  svg.getBoundingClientRect = () => ({left: 0, top: 0, width: Number(svg.getAttribute('width'))});
  const unscrolled = openEditor(left.bounds.top + 2);

  // A 30px scroll shifts the SVG's own viewport position up by 30, the same
  // way it would in a real browser once #dom actually scrolls - clicking the
  // same socket now takes a proportionally smaller clientY, exactly as a
  // real click would once its on-screen position has moved up with it.
  const scrollDelta = 30;
  surface.element.scrollTop = scrollDelta;
  svg.getBoundingClientRect = () => ({left: 0, top: -scrollDelta, width: Number(svg.getAttribute('width'))});
  const scrolled = openEditor(left.bounds.top + 2 - scrollDelta);

  assert.equal(scrolled, unscrolled);
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

test('clicking "+ elif" emits an add-clause operation targeting the whole if statement', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(bareIf());
  const svg = surface.element.querySelector('svg');
  const button = svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="elif"]');
  assert.ok(button);

  button.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  const ifStatement = surface.layout.nodes.find((node) => node.id === 'if');
  assert.deepEqual(operations, [{type: 'add-clause', target: {from: ifStatement.source.from, to: ifStatement.source.to}, role: 'elif'}]);
});

test('hides "+ elif" and "+ else" for an unbraced JavaScript if with no clause yet, where add-clause would throw', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: () => {}});
  surface.update(bareUnbracedJsIf());
  const svg = surface.element.querySelector('svg');

  assert.equal(svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="elif"]'), null);
  assert.equal(svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="else"]'), null);
});

test('hides "+ elif" for an unbraced JavaScript if that already has a braced else, where add-clause would still throw', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: () => {}});
  surface.update(unbracedJsIfWithBracedElse());
  const svg = surface.element.querySelector('svg');

  assert.equal(svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="elif"]'), null);
});

test('a keyboard-focused "+ elif" button is a real button and activates on Enter and Space', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(bareIf());
  const svg = surface.element.querySelector('svg');
  const button = svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="elif"]');
  assert.equal(button.getAttribute('tabindex'), '0');
  assert.equal(button.getAttribute('role'), 'button');
  assert.ok(button.getAttribute('aria-label'));

  const ifStatement = surface.layout.nodes.find((node) => node.id === 'if');
  const expected = {type: 'add-clause', target: {from: ifStatement.source.from, to: ifStatement.source.to}, role: 'elif'};

  button.dispatchEvent(new dom.window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));
  assert.deepEqual(operations, [expected]);

  button.dispatchEvent(new dom.window.KeyboardEvent('keydown', {bubbles: true, key: ' '}));
  assert.deepEqual(operations, [expected, expected]);
});

test('clicking "+ else" emits an add-clause operation, and hides once an else already exists', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(ifWithElifClause());
  const svg = surface.element.querySelector('svg');
  const addElse = svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="else"]');
  assert.ok(addElse);

  addElse.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  const ifStatement = surface.layout.nodes.find((node) => node.id === 'if');
  assert.deepEqual(operations, [{type: 'add-clause', target: {from: ifStatement.source.from, to: ifStatement.source.to}, role: 'else'}]);
});

test('hides "+ else" but keeps "+ elif" once an else branch already exists', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(ifWithElseClause());
  const svg = surface.element.querySelector('svg');

  assert.equal(svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="else"]'), null);
  const addElif = svg.querySelector('[data-droplet-action="add-clause"][data-droplet-role="elif"]');
  assert.ok(addElif);

  // Python only requires elif before else, not that else be absent - a new
  // elif must still be insertable, ending up before the existing else.
  addElif.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));
  const ifStatement = surface.layout.nodes.find((node) => node.id === 'if');
  assert.deepEqual(operations, [{type: 'add-clause', target: {from: ifStatement.source.from, to: ifStatement.source.to}, role: 'elif'}]);
});

test('clicking a clause\'s remove badge emits a remove-clause operation targeting that clause', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(ifWithElifClause());
  const svg = surface.element.querySelector('svg');
  const removeButton = svg.querySelector('[data-droplet-action="remove-clause"]');
  assert.ok(removeButton);

  removeButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  const elif = surface.layout.nodes.find((node) => node.id === 'elif');
  assert.deepEqual(operations, [{type: 'remove-clause', target: {from: elif.source.from, to: elif.source.to}}]);
});

test('a keyboard-focused clause remove badge is a real button and activates on Enter', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(ifWithElifClause());
  const svg = surface.element.querySelector('svg');
  const removeButton = svg.querySelector('[data-droplet-action="remove-clause"]');
  assert.equal(removeButton.getAttribute('tabindex'), '0');
  assert.equal(removeButton.getAttribute('role'), 'button');
  assert.ok(removeButton.getAttribute('aria-label'));

  removeButton.dispatchEvent(new dom.window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));

  const elif = surface.layout.nodes.find((node) => node.id === 'elif');
  assert.deepEqual(operations, [{type: 'remove-clause', target: {from: elif.source.from, to: elif.source.to}}]);
});

test('clicking a call\'s "+" button emits an insert-sequence-item operation', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(callWithArguments());
  const svg = surface.element.querySelector('svg');
  const addButton = svg.querySelector('[data-droplet-action="insert-sequence-item"]');
  assert.ok(addButton);

  addButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  const call = surface.layout.nodes.find((node) => node.id === 'call');
  assert.deepEqual(operations, [{type: 'insert-sequence-item', target: {from: call.source.from, to: call.source.to}}]);
});

test('hides both "+" and "-" on a call with only the synthetic empty argument socket', () => {
  // Both adapters reject insert-sequence-item as a no-op until a real
  // argument exists (see hasRealSequenceItem) - a "+" button here used to
  // render anyway, sitting there focusable and doing nothing when pressed.
  // The empty socket itself is already the affordance for typing the first
  // argument; "-" stays hidden too, since the synthetic placeholder is not
  // a real argument to remove.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host')});
  surface.update(emptyCall());
  const svg = surface.element.querySelector('svg');

  assert.equal(svg.querySelector('[data-droplet-action="insert-sequence-item"]'), null);
  assert.equal(svg.querySelector('[data-droplet-action="remove-sequence-item"]'), null);
});

test('hides the "+" button on a function declaration with zero parameters', () => {
  // Same reasoning as the empty-call case above: insert-sequence-item is a
  // no-op until a real parameter exists, so the button must not render for
  // a def whose only parameter socket is the synthetic empty one.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host')});
  surface.update(functionDeclarationWithoutParameters());
  const svg = surface.element.querySelector('svg');

  assert.equal(svg.querySelector('[data-droplet-action="insert-sequence-item"]'), null);
});

test('marks add/remove action buttons non-focusable and aria-disabled while read-only, live and on rerender', () => {
  // #dispatchAction already silently no-ops these while readOnly, but
  // nothing signaled that to a keyboard or screen-reader user - the button
  // stayed tabbable and announced as an enabled control regardless. Needs a
  // def with a real parameter (not functionDeclarationWithoutParameters) -
  // insert-sequence-item's own button is now hidden entirely once every
  // parameter socket is synthetic, and this test is about the button's own
  // read-only behavior, not that visibility rule.
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), readOnly: false});
  surface.update(functionDeclarationWithParameter());
  const svg = surface.element.querySelector('svg');
  const button = () => svg.querySelector('[data-droplet-action="insert-sequence-item"]');

  assert.equal(button().getAttribute('tabindex'), '0');
  assert.equal(button().hasAttribute('aria-disabled'), false);

  surface.setReadOnly(true);
  assert.equal(button().getAttribute('tabindex'), '-1');
  assert.equal(button().getAttribute('aria-disabled'), 'true');

  // A rerender while still read-only (e.g. an external text edit) must not
  // let a freshly rendered button slip back to enabled.
  surface.update(functionDeclarationWithParameter());
  assert.equal(button().getAttribute('tabindex'), '-1');
  assert.equal(button().getAttribute('aria-disabled'), 'true');

  surface.setReadOnly(false);
  assert.equal(button().getAttribute('tabindex'), '0');
  assert.equal(button().hasAttribute('aria-disabled'), false);
});

test('clicking a call argument\'s remove badge emits a remove-sequence-item operation for that argument', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(callWithArguments());
  const svg = surface.element.querySelector('svg');
  const removeButtons = [...svg.querySelectorAll('[data-droplet-action="remove-sequence-item"]')];
  assert.equal(removeButtons.length, 2);
  const a = surface.layout.nodes.find((node) => node.id === 'a');

  removeButtons[0].dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  assert.deepEqual(operations, [{type: 'remove-sequence-item', target: {from: a.source.from, to: a.source.to}}]);
});

test('a press on a remove badge does not also start a drag of the socket underneath it', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const operations = [];
  const surface = new BlockSurface({
    parent: dom.window.document.querySelector('#host'), onOperation: (operation) => operations.push(operation)
  });
  surface.update(callWithArguments());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const removeButton = svg.querySelector('[data-droplet-action="remove-sequence-item"]');

  removeButton.dispatchEvent(new dom.window.MouseEvent('pointerdown', {bubbles: true, button: 0, clientX: 0, clientY: 0}));
  removeButton.dispatchEvent(new dom.window.MouseEvent('pointerup', {bubbles: true, button: 0, clientX: 0, clientY: 0}));
  removeButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, button: 0}));

  assert.deepEqual(operations.map((operation) => operation.type), ['remove-sequence-item']);
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

test('Ctrl-drags a comment past a statement\'s line end as a copy, not a move', () => {
  // destinationForTarget's own comment-to-line-end branch resolved straight
  // to a move-comment operation with no regard for the drag's own `copy`
  // flag - #endDrag only consults `copy` in its generic destination
  // fallback, so a Ctrl-drag onto this specific target always moved the
  // original instead of copying it, unlike every other Ctrl-drag target.
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

  drag(svg, dom.window, comment, first.bounds.right + 4, first.bounds.top + 2, {ctrlKey: true});

  assert.deepEqual(operations, [{
    type: 'copy-node', source: {from: 17, to: 24}, kind: 'comment', destination: {from: 0, to: 0, indentation: ''}
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

test('dragging an expression palette block over a socket sets dropEffect and guides to the socket itself', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: () => {}});
  surface.update(assignmentSockets());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const value = surface.layout.nodes.find((node) => node.id === 'value');

  const dropEffect = dragOverSurface(surface, dom.window, 'application/x-droplet-expression',
    value.bounds.left + 2, value.bounds.top + 2);

  assert.equal(dropEffect, 'move');
  const guide = surface.element.querySelector('.droplet-drop-guide');
  assert.ok(guide);
  assert.equal(Number(guide.getAttribute('width')), value.bounds.right - value.bounds.left);

  dragLeaveSurface(surface, dom.window, null);
  assert.equal(surface.element.querySelector('.droplet-drop-guide'), null);
});

test('dragging a statement palette block over a gap guides to the resolved insertion zone', () => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const surface = new BlockSurface({parent: dom.window.document.querySelector('#host'), onOperation: () => {}});
  surface.update(twoStatements());
  const svg = surface.element.querySelector('svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const bodyEnd = surface.layout.insertionZones.find((zone) => zone.role === 'body-end');

  const dropEffect = dragOverSurface(surface, dom.window, 'application/x-droplet-statement',
    bodyEnd.bounds.left + 2, bodyEnd.bounds.top + 2);

  assert.equal(dropEffect, 'move');
  const guide = surface.element.querySelector('.droplet-drop-guide');
  assert.ok(guide);
  assert.equal(Number(guide.getAttribute('width')), bodyEnd.bounds.right - bodyEnd.bounds.left);
});

function opaqueMultiLineProjection() {
  const source = 'if score >\nbroken second line\nx\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
      {id: 'broken', kind: 'opaque-statement', from: 0, to: source.length, editable: false, metadata: {}, children: []}
    ]
  }};
}

function projection() {
  const source = 'if ready:\n  first()\n\n';
  return {
    source,
    root: {
      id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [
        {
          id: 'if', kind: 'statement', from: 0, to: 20, editable: true,
          metadata: {blockRole: 'container', headerTo: 9, bodyEnd: 20},
          children: [
            {id: 'first', kind: 'statement', from: 12, to: 19, editable: true, metadata: {}, children: []}
          ]
        },
        // A blank line after the container's own body (bodyEnd: 20) belongs
        // to the document, not the container's suite - it sits outside the
        // "if" node's own [0, 20) range, so it is a sibling here, not nested
        // inside "if"'s own children the way it was previously (an invalid
        // projection shape the layout code happened not to validate).
        {id: 'blank', kind: 'whitespace', from: 20, to: 21, editable: false, metadata: {text: ''}, children: []}
      ]
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

function bareUnbracedJsIf() {
  // Acorn only sets blockEnd (see metadataFor in the JavaScript adapter)
  // when the primary consequent is itself a BlockStatement - `if (x)
  // work();` has none, and add-clause has no closing brace to anchor a
  // brand-new clause on.
  const source = 'if (ready) pass();\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {type: 'IfStatement', blockRole: 'container', headerTo: source.length - 1},
      children: [{id: 'pass', kind: 'statement', from: 11, to: 18, editable: true, metadata: {}, children: []}]
    }]
  }};
}

function unbracedJsIfWithBracedElse() {
  // add-clause anchors a new elif on the last existing *elif* clause
  // specifically, never an else - an else-only chain is not an anchor it can
  // use, so "+ else if" must still be hidden even though a (braced,
  // otherwise-valid) else clause already exists.
  const source = 'if (ready) pass();\nelse {\n  other();\n}\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {type: 'IfStatement', blockRole: 'container', headerTo: 18},
      children: [
        {id: 'pass', kind: 'statement', from: 11, to: 18, editable: true, metadata: {}, children: []},
        {
          id: 'else', kind: 'clause', from: 19, to: source.length - 1, editable: true,
          metadata: {type: 'BlockStatement', clauseRole: 'else', headerTo: 25, bodyEnd: 37},
          children: [{id: 'other', kind: 'statement', from: 28, to: 36, editable: true, metadata: {}, children: []}]
        }
      ]
    }]
  }};
}

function bareIf() {
  const source = 'if ready:\n  pass\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {type: 'If', blockRole: 'container', headerTo: 9, bodyFrom: 12, bodyEnd: source.length, bodyIndentation: '  '},
      children: [{id: 'pass', kind: 'statement', from: 12, to: 16, editable: true, metadata: {}, children: []}]
    }]
  }};
}

function ifWithElifClause() {
  const source = 'if ready:\n  pass\nelif retry:\n  pass\n';
  const elifFrom = source.indexOf('elif retry:');
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {type: 'If', blockRole: 'container', headerTo: 9, bodyFrom: 12, bodyEnd: elifFrom, bodyIndentation: '  '},
      children: [
        {id: 'pass', kind: 'statement', from: 12, to: 16, editable: true, metadata: {}, children: []},
        {
          id: 'elif', kind: 'clause', from: elifFrom, to: source.length, editable: true,
          metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:'.length, bodyEnd: source.length, bodyIndentation: '  '},
          children: [{id: 'elif-pass', kind: 'statement', from: source.lastIndexOf('pass'), to: source.lastIndexOf('pass') + 4, editable: true, metadata: {}, children: []}]
        }
      ]
    }]
  }};
}

function ifWithElseClause() {
  const source = 'if ready:\n  pass\nelse:\n  pass\n';
  const elseFrom = source.indexOf('else:');
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'if', kind: 'statement', from: 0, to: source.length - 1, editable: true,
      metadata: {type: 'If', blockRole: 'container', headerTo: 9, bodyFrom: 12, bodyEnd: elseFrom, bodyIndentation: '  '},
      children: [
        {id: 'pass', kind: 'statement', from: 12, to: 16, editable: true, metadata: {}, children: []},
        {
          id: 'else', kind: 'clause', from: elseFrom, to: source.length, editable: true,
          metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '},
          children: [{id: 'else-pass', kind: 'statement', from: source.lastIndexOf('pass'), to: source.lastIndexOf('pass') + 4, editable: true, metadata: {}, children: []}]
        }
      ]
    }]
  }};
}

function callWithArguments() {
  const source = 'first(a, b)\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'call-statement', kind: 'statement', from: 0, to: source.length - 1, editable: true, metadata: {}, children: [{
        id: 'call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, editable: true,
        metadata: {type: 'Call', socketRole: 'expression'}, children: [
          {id: 'a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, editable: true, metadata: {socketRole: 'call-argument'}, children: []},
          {id: 'b', kind: 'socket', from: source.indexOf('b'), to: source.indexOf('b') + 1, editable: true, metadata: {socketRole: 'call-argument'}, children: []}
        ]
      }]
    }]
  }};
}

function emptyCall() {
  const source = 'first()\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'call-statement', kind: 'statement', from: 0, to: source.length - 1, editable: true, metadata: {}, children: [{
        id: 'call', kind: 'socket', from: 0, to: source.indexOf(')') + 1, editable: true,
        metadata: {type: 'Call', socketRole: 'expression'}, children: [
          {id: 'empty', kind: 'socket', from: source.indexOf(')'), to: source.indexOf(')'), editable: true, metadata: {socketRole: 'call-argument', empty: true}, children: []}
        ]
      }]
    }]
  }};
}

function functionDeclarationWithoutParameters() {
  const source = 'function myFunction() {\n}\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'def', kind: 'statement', from: 0, to: source.length, editable: true,
      metadata: {
        type: 'FunctionDeclaration', blockRole: 'container',
        headerTo: source.indexOf('\n'), bodyEnd: source.indexOf('}')
      },
      children: [
        {id: 'empty-param', kind: 'socket', from: source.indexOf(')'), to: source.indexOf(')'), editable: true, metadata: {socketRole: 'parameter', empty: true}, children: []}
      ]
    }]
  }};
}

function functionDeclarationWithParameter() {
  const source = 'function myFunction(a) {\n}\n';
  return {source, root: {
    id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
      id: 'def', kind: 'statement', from: 0, to: source.length, editable: true,
      metadata: {
        type: 'FunctionDeclaration', blockRole: 'container',
        headerTo: source.indexOf('\n'), bodyEnd: source.indexOf('}')
      },
      children: [
        {id: 'a', kind: 'socket', from: source.indexOf('a'), to: source.indexOf('a') + 1, editable: true, metadata: {socketRole: 'parameter'}, children: []}
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
  // A plain MouseEvent leaves event.pointerId/pointerType undefined, so
  // #continueDrag/#endDrag's own `event.pointerId !== this.#drag.pointerId`
  // checks (see the dedicated pointer-identity tests below) would pass
  // trivially - undefined !== undefined is always false - without actually
  // exercising real pointer-identity matching. PointerEvent populates both.
  svg.dispatchEvent(new window.PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse',
    clientX: source.bounds.left + 2, clientY: source.bounds.top + 2, ...modifiers}));
  svg.dispatchEvent(new window.PointerEvent('pointermove', {bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y}));
  svg.dispatchEvent(new window.PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y}));
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

// dragover only ever reads dataTransfer.types (getData isn't reliably
// readable until drop in real browsers, so #continuePaletteDrag doesn't try);
// dropEffect is read back afterward to confirm the handler set it.
function dragOverSurface(surface, window, mimeType, x, y) {
  const event = new window.Event('dragover', {bubbles: true, cancelable: true});
  Object.assign(event, {clientX: x, clientY: y});
  event.dataTransfer = {types: [mimeType], dropEffect: 'none'};
  surface.element.dispatchEvent(event);
  return event.dataTransfer.dropEffect;
}

function dragLeaveSurface(surface, window, relatedTarget) {
  const event = new window.Event('dragleave', {bubbles: true, cancelable: true});
  Object.assign(event, {relatedTarget});
  surface.element.dispatchEvent(event);
}
