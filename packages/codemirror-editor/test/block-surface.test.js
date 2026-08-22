import assert from 'node:assert/strict';
import test from 'node:test';

import {createBlockLayout, createSubtreePreview, hitTestBlockLayout} from '../src/block-surface.js';

test('lays out a nested container with a header, independently addressable child, footer, and body-end zone', () => {
  const source = 'if ready:\n  first()\nsecond()\n';
  const layout = createBlockLayout(projection(source), {measureText: (text) => text.length * 10});
  const container = layout.nodes.find((node) => node.id === 'if');
  const first = layout.nodes.find((node) => node.id === 'first');

  assert.equal(container.kind, 'container');
  assert.deepEqual(container.source, {from: 0, to: 20});
  assert.ok(container.regions.header.bottom <= container.regions.body.top);
  assert.ok(container.regions.footer.top >= first.bounds.bottom);
  assert.ok(first.bounds.left > container.bounds.left);
  assert.deepEqual(container.insertionZones.at(-1).destination, {from: 20, to: 20});
});

test('keeps whitespace as a measured sibling and exposes insertion zones around it', () => {
  const source = 'first()\n \t\nsecond()\n';
  const layout = createBlockLayout({
    source,
    root: documentNode(source, [
      statement('first', 0, 7),
      {id: 'blank', kind: 'whitespace', from: 8, to: 11, editable: false, children: [], metadata: {text: ' \t'}},
      statement('second', 11, 19)
    ])
  });
  const blank = layout.nodes.find((node) => node.id === 'blank');

  assert.equal(blank.kind, 'whitespace');
  assert.equal(blank.text, ' \t');
  assert.ok(layout.insertionZones.some((zone) => zone.destination.from === blank.source.from));
  assert.ok(layout.insertionZones.some((zone) => zone.destination.from === source.length));
});

test('uses the same subtree geometry for a drag preview and gives a nested child hit priority', () => {
  const source = 'if ready:\n  first()\nsecond()\n';
  const layout = createBlockLayout(projection(source));
  const first = layout.nodes.find((node) => node.id === 'first');
  const preview = createSubtreePreview(layout, 'if');

  assert.deepEqual(preview.bounds, {
    left: 0, top: 0,
    right: layout.nodes.find((node) => node.id === 'if').bounds.right,
    bottom: layout.nodes.find((node) => node.id === 'if').bounds.bottom
  });
  assert.equal(preview.children[0].bounds.left, first.bounds.left - layout.nodes.find((node) => node.id === 'if').bounds.left);
  assert.equal(hitTestBlockLayout(layout, {
    x: first.bounds.left + 1, y: first.bounds.top + 1
  }).node.id, 'first');
});

test('prefers an inner container insertion zone and retains its source indentation', () => {
  const source = 'if outer:\n  if ready:\n    pass\n';
  const layout = createBlockLayout({
    source,
    root: documentNode(source, [{
      ...statement('outer', 0, source.length, {blockRole: 'container', headerTo: 9, bodyEnd: source.length, bodyIndentation: '  '}),
      children: [{
        ...statement('inner', 12, source.length, {blockRole: 'container', headerTo: 21, bodyEnd: source.length, bodyIndentation: '    '}),
        children: [statement('pass', 26, 30)]
      }]
    }])
  });
  const inner = layout.nodes.find((node) => node.id === 'inner');
  const zone = hitTestBlockLayout(layout, {x: inner.regions.body.left, y: inner.regions.footer.top}).zone;

  assert.equal(zone.depth, 2);
  assert.deepEqual(zone.destination, {from: source.length, to: source.length, indentation: '    '});
});

function projection(source) {
  return {
    source,
    root: documentNode(source, [
      {
        ...statement('if', 0, 20, {blockRole: 'container', headerTo: 9, bodyEnd: 20}),
        children: [statement('first', 12, 19)]
      },
      statement('second', 20, 28)
    ])
  };
}

function documentNode(source, children) {
  return {id: 'document', kind: 'document', from: 0, to: source.length, editable: false, children, metadata: {}};
}

function statement(id, from, to, metadata = {}) {
  return {id, kind: 'statement', from, to, editable: true, children: [], metadata};
}
