import assert from 'node:assert/strict';
import test from 'node:test';

import {JSDOM} from 'jsdom';
import {redo, undo} from '@codemirror/commands';
import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

import {parseJavaScript, transformJavaScript} from '../src/index.js';

installDom();

test('a JavaScript socket operation becomes one source-preserving CodeMirror transaction', () => {
  const source = 'announce("total", total); // preserve this comment\n';
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: source,
    blockMode: true,
    parse: parseJavaScript,
    transform: transformJavaScript
  });
  const socket = findSocket(editor.getProjection(), source, 'total');

  editor.applyBlockOperation({
    type: 'replace-socket',
    target: {from: socket.from, to: socket.to},
    source: 'score + 1'
  });

  assert.equal(editor.getValue(), 'announce("total", score + 1); // preserve this comment\n');
  assert.equal(editor.getProjection().source, editor.getValue());
  editor.destroy();
});

test('JavaScript statement movement uses the same CodeMirror undo history', () => {
  const source = 'first();\nsecond();\n';
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createDropletCodeMirrorEditor({
    parent, value: source, blockMode: true,
    parse: parseJavaScript, transform: transformJavaScript
  });
  const [first] = editor.getProjection().root.children;

  editor.applyBlockOperation({
    type: 'move-statement',
    source: {from: first.from, to: first.to},
    destination: {from: source.length, to: source.length}
  });

  assert.equal(editor.getValue(), '\nsecond();\nfirst();');
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), source);
  editor.destroy();
});

test('a selection maps through a JavaScript block operation and reparse', () => {
  const source = 'announce("total", total);\n';
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createDropletCodeMirrorEditor({
    parent, value: source, blockMode: true,
    parse: parseJavaScript, transform: transformJavaScript
  });
  const socket = findSocket(editor.getProjection(), source, 'total');
  editor.editor.setSelection({anchor: socket.from, head: socket.to});

  editor.applyBlockOperation({
    type: 'replace-socket',
    target: {from: socket.from, to: socket.to},
    source: 'score + 1'
  });

  const selection = editor.editor.getSelection();
  assert.equal(editor.getValue().slice(selection.anchor, selection.head), 'score + 1');
  editor.destroy();
});

test('text and block edits share one CodeMirror history', () => {
  const source = 'announce("total", total);\n';
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createDropletCodeMirrorEditor({
    parent, value: source, blockMode: true,
    parse: parseJavaScript, transform: transformJavaScript
  });
  editor.editor.dispatch({changes: {from: source.length, insert: '// text edit\n'}, userEvent: 'input.type'});
  const socket = findSocket(editor.getProjection(), editor.getValue(), 'total');
  editor.applyBlockOperation({
    type: 'replace-socket',
    target: {from: socket.from, to: socket.to}, source: 'score + 1'
  });

  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), `${source}// text edit\n`);
  assert.equal(redo(editor.editor.view), true);
  assert.equal(editor.getValue(), 'announce("total", score + 1);\n// text edit\n');
  assert.equal(undo(editor.editor.view), true);
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), source);
  editor.destroy();
});

function findSocket(parsed, source, text) {
  const stack = [parsed.root];
  while (stack.length) {
    const node = stack.pop();
    if (node.kind === 'socket' && source.slice(node.from, node.to) === text) return node;
    stack.push(...node.children);
  }
  throw new Error(`Socket with source ${text} was not found`);
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
