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

test('a text-mode edit does not rebuild the hidden block surface, only a block-mode one does', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({parent, value: 'score = 1\n', parse: parseExample});

  editor.editor.dispatch({changes: {from: 0, to: editor.getValue().length, insert: 'other = 2\n'}});
  assert.equal(editor.isUsingBlocks(), false);
  assert.equal(
    parent.querySelectorAll('.droplet-block-surface [data-droplet-kind]').length, 0,
    'the hidden surface must not be laid out or rendered for a text-mode edit'
  );

  editor.setBlockMode(true);
  assert.ok(parent.querySelectorAll('.droplet-block-surface [data-droplet-kind]').length > 0);
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

  clickRenderedSocket(socket);
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

test('clicking again inside an already-open socket editor repositions the cursor instead of reopening it', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample
  });
  const socket = parent.querySelector('.droplet-block-surface [data-droplet-layout-id="value:value"]');
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  clickRenderedSocket(socket);
  const input = parent.querySelector('.droplet-socket-editor');
  assert.equal(input.selectionStart, 0);
  assert.equal(input.selectionEnd, input.value.length);

  // The browser's own click-to-position-cursor behavior isn't simulated by a
  // dispatched event in this test environment, so set the resulting
  // selection directly, then dispatch the click and check our own handlers
  // left it alone instead of reopening (and re-selecting) the editor.
  input.selectionStart = 2;
  input.selectionEnd = 2;
  input.dispatchEvent(new window.MouseEvent('click', {bubbles: true, button: 0, clientX: 1, clientY: 1}));

  assert.equal(parent.querySelector('.droplet-socket-editor'), input);
  assert.equal(input.selectionStart, 2);
  assert.equal(input.selectionEnd, 2);
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
    clickRenderedSocket(parent.querySelector(selector));
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

test('an unrelated change after a still-broken socket commit does not reuse its stale recovery target', () => {
  // #socketRecovery is armed by #replaceSocketText immediately before its own
  // dispatch. If left set once that edit's own reparse still finds an opaque
  // node, an unrelated later change (here setValue, to a document that also
  // happens to still be opaque) would incorrectly recompute a projection from
  // the stale target/previous-projection snapshot instead of the fresh parse.
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseRecoveringSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  input.value = '(';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));
  assert.ok(parent.querySelector('[data-droplet-kind="recovery-socket"]'));

  editor.setValue('other = (\n');

  assert.equal(editor.getProjection().root.children[0].kind, 'opaque-statement');
  assert.equal(editor.getProjection().root.children[0].to, 'other = (\n'.length);
  assert.equal(parent.querySelector('[data-droplet-kind="recovery-socket"]'), null);
  editor.destroy();
});

test('a rejected socket commit does not leave a stale recovery target for a later unrelated edit to reuse', () => {
  // #socketRecovery is armed by #replaceSocketText immediately before its own
  // dispatch, valid only for the one #reparse a *successful* dispatch
  // triggers. The projection's own transactionFilter can reject a change
  // that touches an opaque node instead - no docChanged update reaches
  // #reparse then, so #socketRecovery was left stale until some later,
  // unrelated edit happened to also produce an opaque node and incorrectly
  // reused it (recomputing a "recovered" projection from the wrong
  // snapshot/target instead of just the fresh parse).
  const parent = appendParent();
  // A deliberately malformed projection: an opaque-statement spans the whole
  // statement, overlapping a real socket nested inside it - parsing does not
  // itself validate that a socket and an opaque region never overlap.
  function parseOverlappingOpaque(source) {
    return {
      source,
      root: {
        id: 'document', kind: 'document', from: 0, to: source.length, editable: false, metadata: {}, children: [{
          id: 'stmt', kind: 'statement', from: 0, to: source.length, editable: true, metadata: {},
          children: [
            {id: 'broken', kind: 'opaque-statement', from: 0, to: source.length, editable: false, children: []},
            {id: 'target', kind: 'socket', from: 2, to: 5, editable: true, children: [], metadata: {socketRole: 'expression'}}
          ]
        }]
      },
      issues: []
    };
  }
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'ab123cd', blockMode: true, parse: parseOverlappingOpaque
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  clickRenderedSocket(parent.querySelector('[data-droplet-kind="socket"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  input.value = 'xxx';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));
  assert.equal(editor.getValue(), 'ab123cd', 'the overlapping edit must have been rejected, not applied');

  const end = editor.getValue().length;
  editor.editor.dispatch({changes: {from: end, to: end, insert: 'Z'}});

  function hasRecoverySocket(node) {
    return node.kind === 'recovery-socket' || (node.children ?? []).some(hasRecoverySocket);
  }
  assert.equal(hasRecoverySocket(editor.getProjection().root), false, 'the stale recovery target must not be reused');
  editor.destroy();
});

test('deleting a selected socket commits an empty editable recovery range', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseRecoveringSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  input.selectionStart = 0;
  input.selectionEnd = input.value.length;
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Delete'}));

  assert.equal(editor.getValue(), 'target = \n');
  assert.equal(parent.querySelector('[data-droplet-kind="recovery-socket"]')?.dataset.dropletFrom, '9');
  editor.destroy();
});

test('selecting all and pressing Delete in a socket editor commits exactly one change', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseRecoveringSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  input.selectionStart = 0;
  input.selectionEnd = input.value.length;
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Delete'}));

  // The keydown bubbles from the input up through the block surface, whose
  // own Delete/Backspace shortcut for the currently-selected socket must not
  // also fire and commit a second, redundant change.
  assert.equal(editor.getValue(), 'target = \n');
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), 'target = value\n');
  editor.destroy();
});

test('pressing Backspace mid-edit in a socket only edits its text, not the whole block', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  input.selectionStart = input.value.length;
  input.selectionEnd = input.value.length;
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Backspace'}));

  // Ordinary text editing with the cursor mid-field (not a full selection)
  // must not bubble into the block surface's "delete this socket" shortcut.
  assert.equal(editor.getValue(), 'target = value\n');
  editor.destroy();
});

test('an initially read-only editor blocks socket edits and block deletion through the surface', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample, readOnly: true
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  const socket = parent.querySelector('[data-droplet-layout-id="value:value"]');

  clickRenderedSocket(socket);
  assert.equal(parent.querySelector('.droplet-socket-editor'), null, 'read-only must not open the inline editor');

  parent.querySelector('.droplet-block-surface').dispatchEvent(
    new window.KeyboardEvent('keydown', {bubbles: true, key: 'Delete'})
  );
  assert.equal(editor.getValue(), 'target = value\n');

  assert.throws(
    () => editor.applyBlockOperation({type: 'delete-node', source: {from: 0, to: 15}, kind: 'statement'}),
    TypeError
  );
  editor.destroy();
});

test('update({readOnly}) blocks then re-allows socket edits through the surface', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  editor.update({readOnly: true});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  assert.equal(parent.querySelector('.droplet-socket-editor'), null, 'read-only must not open the inline editor');
  assert.equal(editor.getValue(), 'target = value\n');

  editor.update({readOnly: false});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  const input = parent.querySelector('.droplet-socket-editor');
  assert.ok(input, 'normal editing resumes once readOnly is lifted');
  input.value = 'answer';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));
  assert.equal(editor.getValue(), 'target = answer\n');
  editor.destroy();
});

test('update({readOnly: true}) closes an inline socket editor that was already open', () => {
  // Flipping the surface's readOnly flag alone only gates *future*
  // interaction - an editor already open when readOnly turns on would
  // otherwise stay live, and committing it would reach #replaceSocketText,
  // which throws for a read-only editor.
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'target = value\n', blockMode: true, parse: parseSocketExample
  });
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});
  clickRenderedSocket(parent.querySelector('[data-droplet-layout-id="value:value"]'));
  assert.ok(parent.querySelector('.droplet-socket-editor'), 'the editor must actually be open before the transition');

  editor.update({readOnly: true});

  assert.equal(parent.querySelector('.droplet-socket-editor'), null, 'the open editor must close, not stay live');
  assert.equal(editor.getValue(), 'target = value\n');
  editor.destroy();
});

test('editing a rendered comment commits one CodeMirror source change on Enter', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent, value: 'first()\n# note\n', blockMode: true, parse: parseCommentExample
  });
  const comment = parent.querySelector('.droplet-block-surface [data-droplet-kind="comment"]');
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  clickRenderedSocket(comment);
  const input = parent.querySelector('.droplet-socket-editor');
  // The leading "#" is not part of the editable value.
  assert.equal(input.value, ' note');
  input.value = ' updated';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));

  assert.equal(editor.getValue(), 'first()\n# updated\n');
  assert.equal(parent.querySelector('.droplet-socket-editor'), null);
  assert.equal(undo(editor.editor.view), true);
  assert.equal(editor.getValue(), 'first()\n# note\n');
  editor.destroy();
});

test('emptying a rendered comment through its inline editor deletes it instead of leaving it blank', () => {
  const parent = appendParent();
  const editor = createDropletCodeMirrorEditor({
    parent,
    value: 'first()\n# note\n',
    blockMode: true,
    parse: parseCommentExample,
    transform: (operation, parsed) => {
      assert.equal(parsed.source, 'first()\n# note\n');
      assert.deepEqual(operation, {type: 'delete-node', source: {from: 8, to: 14}, kind: 'comment'});
      return [{from: 8, to: 15, insert: ''}];
    }
  });
  const comment = parent.querySelector('.droplet-block-surface [data-droplet-kind="comment"]');
  const svg = parent.querySelector('.droplet-block-surface svg');
  svg.getBoundingClientRect = () => ({left: 0, top: 0});

  clickRenderedSocket(comment);
  const input = parent.querySelector('.droplet-socket-editor');
  input.value = '';
  input.dispatchEvent(new window.KeyboardEvent('keydown', {bubbles: true, key: 'Enter'}));

  assert.equal(editor.getValue(), 'first()\n');
  editor.destroy();
});

function clickRenderedSocket(socket) {
  const frame = socket.querySelector('rect');
  socket.dispatchEvent(new window.MouseEvent('click', {
    bubbles: true,
    button: 0,
    clientX: Number(frame.getAttribute('x')) + 2,
    clientY: Number(frame.getAttribute('y')) + 2
  }));
}

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

function parseCommentExample(source) {
  const commentFrom = source.indexOf('#');
  const commentTo = source.indexOf('\n', commentFrom);
  return {
    source,
    root: {
      id: `document:0:${source.length}`, kind: 'document', from: 0, to: source.length, editable: false,
      children: [
        {id: 'first', kind: 'statement', from: 0, to: commentFrom - 1, editable: true, metadata: {}, children: []},
        {id: `comment:${commentFrom}`, kind: 'comment', from: commentFrom, to: commentTo, editable: true, children: [], metadata: {inline: false}}
      ]
    }, issues: []
  };
}

function parseRecoveringSocketExample(source) {
  if (source.includes('(') || source === 'target = \n') {
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
