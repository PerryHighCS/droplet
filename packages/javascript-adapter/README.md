# @droplet/javascript

The initial modern JavaScript language adapter for Droplet. It uses current
Acorn, returns a source-range projection, and never serializes or normalizes
the source text it receives.

```js
import {
  parseJavaScript,
  transformJavaScript
} from '@droplet/javascript';
import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

const editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#editor'),
  value: 'announce("total", total);\n',
  blockMode: true,
  parse: parseJavaScript,
  transform: transformJavaScript
});
```

Supported transforms are `replace-socket`, `insert-statement`, and
`move-statement`. Call arguments, variable initializers, assignment right-hand
sides, binary/logical operands, and return values are projected as sockets when
applicable. Transformations are rejected if their exact range edits do not
parse as JavaScript; otherwise the original lexical trivia is left untouched.
