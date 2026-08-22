import assert from 'node:assert/strict';
import test from 'node:test';

import {undo} from '@codemirror/commands';
import {EditorView} from '@codemirror/view';
import {JSDOM} from 'jsdom';

import {
  createDropletCodeMirrorEditor,
  projectionOperationFromDrop
} from '../src/droplet.js';

installDom();

test('block mode displays opaque source, prevents internal edits, and recovers after an external repair', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: 'if score >',
    blockMode: true,
    parse: parseExample
  });

  assert.equal(editor.getProjection().root.children[0].kind, 'opaque-statement');
  assert.equal(parent.querySelectorAll('[data-droplet-kind="opaque-statement"]').length, 1);
  editor.editor.dispatch({changes: {from: 5, insert: 'new '}});
  assert.equal(editor.getValue(), 'if score >');

  editor.setValue('if score > 10:\n    print(score)\n');
  assert.equal(editor.getProjection().root.children[0].kind, 'statement');
  assert.equal(parent.querySelectorAll('[data-droplet-kind="opaque-statement"]').length, 0);
  editor.destroy();
});

test('text editing can become opaque without forcing a mode change', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({parent, value: 'score = 1\n', parse: parseExample});

  editor.editor.dispatch({changes: {from: 0, to: editor.getValue().length, insert: 'if score >'}});
  assert.equal(editor.isUsingBlocks(), false);
  assert.equal(editor.getProjection().root.children[0].kind, 'opaque-statement');
  editor.setBlockMode(true);
  assert.equal(parent.querySelectorAll('[data-droplet-kind="opaque-statement"]').length, 1);
  editor.destroy();
});

test('block mode displays structured statements on the BlockSurface and hides the text view', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'score = 1\n', blockMode: true, parse: parseExample
  });

  assert.equal(parent.querySelectorAll('.droplet-block-surface [data-droplet-kind="statement"]').length, 1);
  assert.equal(editor.editor.view.dom.style.display, 'none');
  editor.setBlockMode(false);
  assert.equal(parent.querySelector('.droplet-block-surface').style.display, 'none');
  assert.equal(editor.editor.view.dom.style.display, '');
  editor.destroy();
});

test('block mode installs a structural surface for container and whitespace rendering', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: 'for item in items:\n  pass\n\n',
    blockMode: true,
    parse: (source) => ({
      source,
      root: {
        id: 'document', kind: 'document', from: 0, to: source.length, editable: false,
        children: [{
          id: 'loop', kind: 'statement', from: 0, to: 25, editable: true,
          children: [{id: 'pass', kind: 'statement', from: 21, to: 25, editable: true, children: []}],
          metadata: {type: 'For', blockRole: 'container', headerTo: 18}
        }, {
          id: 'blank', kind: 'whitespace', from: 26, to: 27, editable: false, children: [],
          metadata: {text: '', lineEnding: '\n'}
        }]
      },
      issues: []
    })
  });

  assert.ok(parent.querySelector('.droplet-block-surface'));
  assert.equal(parent.querySelectorAll('.droplet-block-surface [data-droplet-kind="container"]').length, 1);
  assert.equal(parent.querySelectorAll('.droplet-block-surface [data-droplet-kind="whitespace"]').length, 1);
  editor.destroy();
  assert.equal(parent.querySelector('.droplet-block-surface'), null);
});

test('clicking a rendered projection selects its exact source range', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'score = 1\n', blockMode: true, parse: parseExample
  });
  const statement = parent.querySelector('.droplet-block-surface [data-droplet-kind="statement"]');
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  statement.dispatchEvent(new window.MouseEvent('click', {bubbles: true, button: 0, clientX: 1, clientY: 1}));
  assert.deepEqual(editor.editor.getSelection(), {anchor: 0, head: 'score = 1\n'.length});
  editor.destroy();
});

test('editing a rendered socket commits one CodeMirror source change on Enter', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample
  });
  const socket = parent.querySelector('.droplet-block-surface [data-droplet-layout-id="value:value"]');
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  socket.dispatchEvent(new window.MouseEvent('click', {bubbles: true, button: 0, clientX: 98, clientY: 5}));
  const input = parent.querySelector('.droplet-socket-editor');
  assert.equal(input.value, 'value');
  input.value = 'answer';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));

  assert.equal(editor.getValue(), 'target = answer\n');
  assert.equal(parent.querySelector('.droplet-socket-editor'), null);
  assert.equal(parent.querySelector('[data-droplet-layout-id="value:answer"]')?.dataset.dropletKind, 'socket');
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), 'target = value\n');
  editor.destroy();
});

test('an incomplete socket commit remains an editable recovery socket until it parses', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseRecoveringSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const edit = (selector, value) => {
    parent.querySelector(selector).dispatchEvent(new window.MouseEvent('click', {bubbles: true, button: 0, clientX: 98, clientY: 5}));
    const input = parent.querySelector('.droplet-socket-editor');
    input.value = value;
    input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));
  };

  edit('[data-droplet-layout-id="value:value"]', '(');
  assert.equal(editor.getValue(), 'target = (\n');
  const recovery = parent.querySelector('[data-droplet-kind="recovery-socket"]');
  assert.ok(recovery);

  edit('[data-droplet-kind="recovery-socket"]', 'answer');
  assert.equal(editor.getValue(), 'target = answer\n');
  assert.equal(parent.querySelector('[data-droplet-kind="recovery-socket"]'), null);
  assert.equal(parent.querySelector('[data-droplet-layout-id="value:answer"]')?.dataset.dropletKind, 'socket');
  editor.destroy();
});

test('rendered block drops become source operations without a second document', () => {
  assert.deepEqual(
    projectionOperationFromDrop(
      {kind: 'statement', from: 0, to: 8},
      {kind: 'statement', from: 9, to: 18},
      'first();\nsecond();\n'
    ),
    {type: 'move-statement', source: {from: 0, to: 8}, destination: {from: 9, to: 9}}
  );
  assert.deepEqual(
    projectionOperationFromDrop(
      {kind: 'expression', from: 10, to: 15},
      {kind: 'socket', from: 20, to: 25},
      '0123456789value12345target'
    ),
    {type: 'replace-socket', target: {from: 20, to: 25}, source: 'value'}
  );
  assert.equal(
    projectionOperationFromDrop(
      {kind: 'opaque-statement', from: 0, to: 4},
      {kind: 'statement', from: 5, to: 9},
      'bad\ngood'
    ),
    undefined
  );
});

test('block operations use one CodeMirror source transaction and its existing undo history', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: 'score = 1\n',
    blockMode: true,
    parse: parseExample,
    transform: (operation, parsed) => {
      assert.equal(parsed.source, 'score = 1\n');
      assert.deepEqual(operation, {type: 'replace-score'});
      return [{from: 8, to: 9, insert: '2 + 3'}];
    }
  });

  editor.applyBlockOperation({type: 'replace-score'});
  assert.equal(editor.getValue(), 'score = 2 + 3\n');
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), 'score = 1\n');
  editor.destroy();
});

test('consumer extension updates retain opaque projection behavior', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: 'if score >',
    blockMode: true,
    parse: parseExample
  });

  editor.update({extensions: EditorView.lineWrapping});
  assert.equal(parent.querySelectorAll('[data-droplet-kind="opaque-statement"]').length, 1);
  editor.editor.dispatch({changes: {from: 5, insert: 'new '}});
  assert.equal(editor.getValue(), 'if score >');
  editor.destroy();
});

test('opaque children of structured nodes are also displayed and protected', () => {
  const parent = appendParent();
  const source = 'score = ???\n';
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: source,
    blockMode: true,
    parse: (value) => ({
      source: value,
      root: {
        id: 'document', kind: 'document', from: 0, to: value.length, editable: false,
        children: [{
          id: 'statement', kind: 'statement', from: 0, to: value.length, editable: true,
          children: [{
            id: 'opaque-expression', kind: 'opaque-expression', from: 8, to: 11,
            editable: false, children: []
          }]
        }]
      },
      issues: []
    })
  });

  assert.equal(parent.querySelectorAll('[data-droplet-kind="opaque-expression"]').length, 1);
  editor.editor.dispatch({changes: {from: 9, insert: '!'}});
  assert.equal(editor.getValue(), source);
  editor.destroy();
});

function parseExample(source) {
  if (source === 'if score >') {
    const error = new Error('Expected an expression');
    error.from = 0;
    error.to = source.length;
    error.opaqueKind = 'opaque-statement';
    throw error;
  }
  return {
    source,
    root: {
      id: `document:0:${source.length}`,
      kind: 'document', from: 0, to: source.length, editable: false,
      children: [{id: 'statement:0', kind: 'statement', from: 0, to: source.length, editable: true, children: []}]
    },
    issues: []
  };
}

function parseSocketExample(source) {
  const targetEnd = source.indexOf(' = ');
  const valueFrom = targetEnd + 3;
  const valueTo = source.indexOf('\n');
  return {
    source,
    root: {
      id: `document:0:${source.length}`, kind: 'document', from: 0, to: source.length, editable: false,
      children: [{
        id: 'assign', kind: 'statement', from: 0, to: source.length, editable: true, metadata: {}, children: [
          {id: 'target', kind: 'socket', from: 0, to: targetEnd, editable: true, children: [], metadata: {socketRole: 'assignment-target'}},
          {id: `value:${source.slice(valueFrom, valueTo)}`, kind: 'socket', from: valueFrom, to: valueTo,
            editable: true, children: [], metadata: {socketRole: 'assignment-value'}}
        ]
      }]
    }, issues: []
  };
}

function parseRecoveringSocketExample(source) {
  if (source.includes('(')) {
    const error = new Error('Expected an expression');
    error.from = 0;
    error.to = source.length;
    error.opaqueKind = 'opaque-statement';
    throw error;
  }
  return parseSocketExample(source);
}

function appendParent() {
  const parent = document.createElement('div');
  document.body.append(parent);
  return parent;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual: true});
  const {window} = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: window.navigator});
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Window = window.Window;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
}
