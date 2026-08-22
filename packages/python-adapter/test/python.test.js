import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';

import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

import {
  collectPythonTrivia,
  createBrythonPythonParser,
  parsePython
} from '../src/index.js';

installDom();

test('maps Brython line and column locations to exact source ranges', () => {
  const source = 'value = outer(1)\n';
  const ast = {type: 'Module', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: source.length - 1,
    body: [{type: 'Assign', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: source.length - 1,
      value: {type: 'Call', lineno: 1, col_offset: 8, end_lineno: 1, end_col_offset: source.length - 1, args: []}}]};
  const parsed = parsePython(source, () => ast);
  assert.equal(parsed.source, source);
  assert.equal(parsed.root.children[0].kind, 'statement');
  assert.deepEqual(parsed.root.children[0].children[0], {
    id: 'socket:Call:8:16', kind: 'socket', from: 8, to: 16, editable: true,
    children: [], metadata: {type: 'Call'}
  });
});

test('converts Brython syntax failures into an opaque source projection', () => {
  const parsed = parsePython('if score >', () => { throw new Error('invalid syntax'); });
  assert.deepEqual(parsed.root.children[0], {
    id: 'opaque-statement:0:10:0', kind: 'opaque-statement', from: 0, to: 10,
    editable: false, children: [], metadata: {movable: false}
  });
  assert.deepEqual(parsed.issues, [{
    from: 0, to: 10, message: 'invalid syntax', severity: 'error'
  }]);
});

test('falls back to the containing source boundary for invalid AST locations', () => {
  const source = 'pass\n';
  const ast = {type: 'Module', body: [{type: 'Pass', lineno: 9, col_offset: 0, end_lineno: 9, end_col_offset: 4}]};
  const parsed = parsePython(source, () => ast);
  assert.deepEqual(parsed.root.children[0], {
    id: 'statement:Pass:0:5', kind: 'statement', from: 0, to: 5, editable: true,
    children: [], metadata: {type: 'Pass'}
  });
});

test('uses raw source indentation while retaining inline and standalone comments', () => {
  const source = '# heading\nif value:\n\tresult = value  # inline\n';
  const tokens = [
    {type: 65, string: '# heading', lineno: 1, col_offset: 0, end_lineno: 1, end_col_offset: 9},
    {type: 5, string: '', lineno: 3, col_offset: 0, end_lineno: 3, end_col_offset: 8},
    {type: 65, string: '# inline', lineno: 3, col_offset: 17, end_lineno: 3, end_col_offset: 25}
  ];

  assert.deepEqual(collectPythonTrivia(source, () => tokens), {
    comments: [
      {kind: 'comment', from: 0, to: 9, inline: false},
      {kind: 'comment', from: 37, to: 45, inline: true}
    ],
    indentation: [{kind: 'indentation', from: 20, to: 21, text: '\t'}]
  });
});

test('CodeMirror block-mode toggles retain quoted Python source exactly', () => {
  const source = "label = 'single quoted'\nmessage = \"\"\"first line\nsecond line\"\"\"\n";
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: source,
    parse: createBrythonPythonParser(sourceAst)
  });

  editor.setBlockMode(true);
  assert.equal(editor.isUsingBlocks(), true);
  assert.equal(editor.getValue(), source);
  assert.ok(parent.querySelectorAll('.droplet-block-statement').length > 0);

  editor.setBlockMode(false);
  assert.equal(editor.isUsingBlocks(), false);
  assert.equal(editor.getValue(), source);
  assert.equal(parent.querySelectorAll('.droplet-block').length, 0);
  editor.destroy();
});

test('CodeMirror block-mode displays invalid Python as exact opaque source', () => {
  const source = 'if score >';
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: source,
    parse: createBrythonPythonParser((python) => {
      if (python === source) throw new Error('invalid syntax');
      return sourceAst(python);
    })
  });

  editor.setBlockMode(true);
  assert.equal(editor.getValue(), source);
  assert.equal(editor.getProjection().root.children[0].kind, 'opaque-statement');
  assert.equal(parent.querySelectorAll('.droplet-opaque').length, 1);
  editor.destroy();
});

function sourceAst(source) {
  const text = source.endsWith('\n') ? source.slice(0, -1) : source;
  const lines = text.split('\n');
  return {
    type: 'Module',
    body: [{
      type: 'Expr', lineno: 1, col_offset: 0,
      end_lineno: lines.length, end_col_offset: lines.at(-1).length,
      value: {type: 'Constant', lineno: 1, col_offset: 0, end_lineno: lines.length, end_col_offset: lines.at(-1).length}
    }]
  };
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
}
