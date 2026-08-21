# @droplet/codemirror-editor

`@droplet/codemirror-editor` is a small, framework-independent CodeMirror 6
wrapper. It owns one CodeMirror document and history; future Droplet block
interactions will dispatch ordinary source transactions through it.

```js
import {createCodeMirrorEditor} from '@droplet/codemirror-editor';
import {javascript} from '@codemirror/lang-javascript';

const editor = createCodeMirrorEditor({
  parent: document.querySelector('#editor'),
  value: 'const score = 0;\n',
  language: javascript(),
  onChange(value) {
    console.log(value);
  }
});

// A controlled external update is annotated and does not call onChange.
editor.setValue('const score = 1;\n');
editor.update({readOnly: true});
editor.destroy();
```

`update()` reconfigures language, theme, read-only state, or consumer
extensions through CodeMirror compartments without recreating the view.
`onUpdate(update, {external})` receives every CodeMirror update, while
`onChange(value, update)` receives local document edits only.

## Droplet projection adapter

The `@droplet/codemirror-editor/droplet` subpath adds
`createDropletCodeMirrorEditor`. Supply a structured language parser and,
optionally, a block-operation transformer. It reparses after every CodeMirror
document transaction, decorates structured statements, expressions, sockets,
and opaque parser failures in block mode, and keeps opaque internal text
read-only. External source updates remain permitted, so a repaired program
automatically returns to a structured projection.

Clicking a rendered range selects its exact source range in CodeMirror.
Dragging one rendered statement onto another produces a `move-statement`
intent; dropping an expression or socket onto a socket produces a
`replace-socket` intent. The language adapter remains responsible for deciding
whether that exact source transformation is valid.

```js
import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

const editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#editor'),
  value: 'if score >',
  blockMode: true,
  parse: parseStructuredLanguage,
  transform: transformBlockOperation
});
```

`applyBlockOperation(operation)` validates the adapter's minimal source changes
and dispatches them as one CodeMirror transaction, preserving ordinary undo and
redo behavior.
