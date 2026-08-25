import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import React, {createRef} from 'react';
import {act} from 'react';
import {createRoot} from 'react-dom/client';

import {DropletEditor} from '../src/index.js';

installDom();

const language = {
  id: 'example',
  parse: (source) => ({source, root: {id: 'document', kind: 'document', from: 0, to: source.length, editable: false, children: []}, issues: []}),
  transform: () => []
};

test('mounts one editor, synchronizes controlled value, forwards updates, and exposes the imperative API', async () => {
  const parent = document.body.appendChild(document.createElement('div'));
  const root = createRoot(parent);
  const ref = createRef();
  const changes = [];
  const updates = [];

  await act(() => root.render(React.createElement(DropletEditor, {
    ref,
    language,
    value: 'one',
    filename: 'one.js',
    onChange: (value) => changes.push(value),
    onUpdate: (update) => updates.push(update)
  })));

  const editor = ref.current.editor;
  assert.equal(ref.current.getValue(), 'one');
  ref.current.setMode('blocks');
  assert.equal(editor.mode, 'blocks');

  await act(() => root.render(React.createElement(DropletEditor, {
    ref,
    language,
    value: 'two',
    filename: 'two.js',
    mode: 'text',
    readOnly: true,
    onChange: (value) => changes.push(value),
    onUpdate: (update) => updates.push(update)
  })));

  assert.equal(ref.current.editor, editor, 'prop updates must not recreate the editor');
  assert.equal(ref.current.getValue(), 'two');
  assert.equal(editor.filename, 'two.js');
  assert.equal(editor.mode, 'text');
  assert.equal(editor.readOnly, true);
  assert.deepEqual(changes, [], 'controlled updates do not echo through onChange');
  assert.ok(updates.length > 0);

  await act(() => root.unmount());
  assert.equal(parent.querySelector('.cm-editor'), null, 'unmount destroys the CodeMirror view');
});

test('mounts independent editor instances', async () => {
  const parent = document.body.appendChild(document.createElement('div'));
  const root = createRoot(parent);

  await act(() => root.render(React.createElement(React.Fragment, null,
    React.createElement(DropletEditor, {language, value: 'first'}),
    React.createElement(DropletEditor, {language, value: 'second'})
  )));

  assert.equal(parent.querySelectorAll('.cm-editor').length, 2);
  await act(() => root.unmount());
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {pretendToBeVisual: true});
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: dom.window.navigator});
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Window = dom.window.Window;
  globalThis.getComputedStyle = dom.window.getComputedStyle;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
