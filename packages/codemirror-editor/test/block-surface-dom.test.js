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
