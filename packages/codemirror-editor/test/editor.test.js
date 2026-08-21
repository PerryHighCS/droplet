import assert from 'node:assert/strict';
import test from 'node:test';

import {undo} from '@codemirror/commands';
import {javascript} from '@codemirror/lang-javascript';
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {JSDOM} from 'jsdom';

import {createCodeMirrorEditor} from '../src/index.js';

installDom();

test('creates independent editor views and cleans them up', () => {
  const firstParent = document.createElement('div');
  const secondParent = document.createElement('div');
  document.body.append(firstParent, secondParent);

  const first = createCodeMirrorEditor({parent: firstParent, value: 'first'});
  const second = createCodeMirrorEditor({parent: secondParent, value: 'second'});

  assert.equal(first.getValue(), 'first');
  assert.equal(second.getValue(), 'second');
  assert.notEqual(first.view, second.view);

  first.destroy();
  second.destroy();
  assert.equal(firstParent.childElementCount, 0);
  assert.equal(secondParent.childElementCount, 0);
});

test('rejects a non-string initial editor value', () => {
  const parent = document.createElement('div');

  assert.throws(
    () => createCodeMirrorEditor({parent, value: 42}),
    /Editor value must be a string/
  );
});

test('external values are annotated and local edits notify controlled consumers', () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const changes = [];
  const updates = [];
  const editor = createCodeMirrorEditor({
    parent,
    value: 'one',
    onChange: (value) => changes.push(value),
    onUpdate: (_update, metadata) => updates.push(metadata)
  });

  editor.setValue('two');
  assert.equal(editor.getValue(), 'two');
  assert.deepEqual(changes, []);
  assert.equal(updates.at(-1).external, true);

  editor.dispatch({changes: {from: 3, insert: '!'}});
  assert.equal(editor.getValue(), 'two!');
  assert.deepEqual(changes, ['two!']);
  assert.equal(updates.at(-1).external, false);

  editor.destroy();
});

test('keeps one view while reconfiguring language, theme, read-only state, and extensions', () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createCodeMirrorEditor({parent, value: 'const value = 1;'});
  const view = editor.view;

  editor.update({
    language: javascript(),
    theme: EditorView.theme({'&': {fontSize: '14px'}}),
    readOnly: true,
    extensions: EditorView.lineWrapping
  });

  assert.equal(editor.view, view);
  assert.equal(editor.view.state.facet(EditorState.readOnly), true);

  editor.update({readOnly: false, language: [], theme: [], extensions: []});
  assert.equal(editor.view, view);
  assert.equal(editor.view.state.facet(EditorState.readOnly), false);
  editor.destroy();
});

test('selection, scroll state, focus, and undo use CodeMirror state without recreating the editor', () => {
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createCodeMirrorEditor({parent, value: 'one'});

  editor.setSelection({anchor: 1, head: 3});
  assert.deepEqual(editor.getSelection(), {anchor: 1, head: 3});
  editor.setScrollPosition({left: 12, top: 34});
  assert.deepEqual(editor.getScrollPosition(), {left: 12, top: 34});

  editor.focus();
  assert.equal(document.activeElement, editor.view.contentDOM);
  editor.dispatch({changes: {from: 3, insert: '!'}, userEvent: 'input.type'});
  assert.equal(editor.getValue(), 'one!');
  assert.equal(undo(editor.view), true);
  assert.equal(editor.getValue(), 'one');
  editor.destroy();
});

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true
  });
  const {window} = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: window.navigator
  });
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Window = window.Window;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
}
