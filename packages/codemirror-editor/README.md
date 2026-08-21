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
