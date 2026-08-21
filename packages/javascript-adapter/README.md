# @droplet/javascript-adapter

The initial modern JavaScript language adapter for Droplet. It uses current
Acorn, returns a source-range projection, and never serializes or normalizes
the source text it receives.

```js
import {
  parseJavaScript,
  transformJavaScript
} from '@droplet/javascript-adapter';
import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

const editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#editor'),
  value: 'announce("total", total);\n',
  blockMode: true,
  parse: parseJavaScript,
  transform: transformJavaScript
});
```

The currently supported block transform is `replace-socket`. Call arguments,
variable initializers, assignment right-hand sides, binary/logical operands,
and return values are projected as sockets when applicable. Statement insertion
and movement are deliberately not implemented yet.
