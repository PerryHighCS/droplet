import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';

import {DropletEditor} from '../src/index.js';

installDom();

const language = {
  id: 'example',
  parse: (source) => ({source, root: {id: 'document', kind: 'document', from: 0, to: source.length, editable: false, children: []}, issues: []}),
  transform: () => []
};

test('provides a plain-DOM editor API with mode, value, selection, and history', () => {
  const parent = document.body.appendChild(document.createElement('div'));
  const changes = [];
  const editor = new DropletEditor(parent, {language, value: 'one', onChange: (value) => changes.push(value)});

  assert.equal(editor.value, 'one');
  assert.equal(editor.mode, 'text');
  assert.equal(editor.readOnly, false);
  editor.setSelection({anchor: 1, head: 3});
  assert.deepEqual(editor.getSelection(), {anchor: 1, head: 3});
  editor.value = 'two';
  assert.equal(editor.value, 'two');
  assert.deepEqual(changes, [], 'external values do not echo through onChange');
  editor.setMode('blocks');
  assert.equal(editor.mode, 'blocks');
  editor.toggleMode();
  assert.equal(editor.mode, 'text');
  editor.update({readOnly: true});
  assert.equal(editor.readOnly, true);
  editor.destroy();
});

test('updates language and filename without replacing its editor instance', () => {
  const parent = document.body.appendChild(document.createElement('div'));
  const editor = new DropletEditor(parent, {language, value: 'source', filename: 'one.js'});
  const view = editor.getProjection();
  editor.update({filename: 'two.js', language: {...language, id: 'replacement'}});
  assert.equal(editor.filename, 'two.js');
  assert.equal(editor.language.id, 'replacement');
  assert.equal(editor.getProjection().source, view.source);
  editor.destroy();
});

test('rejects an invalid initial mode', () => {
  const parent = document.body.appendChild(document.createElement('div'));
  assert.throws(() => new DropletEditor(parent, {language, mode: 'block'}), /Mode must be "text" or "blocks"/);
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
}
