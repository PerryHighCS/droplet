# Code.org JavaScript Block Parity

This document compares the Code.org-derived JavaScript editor with the modern
JavaScript path. It is the behavioral specification for the modern
`BlockSurface`; it is not a proposal to import or revive the legacy runtime.

The legacy editor is an SVG renderer (despite historical `*Canvas` variable
names), not a canvas renderer. Its implementation is spread across:

- `src/languages/javascript.coffee` — Acorn projection into Droplet model
  blocks, sockets, indents, comments, categories, and acceptance classes.
- `src/view.coffee` — recursive SVG geometry, including multi-line container
  outlines, puzzle tabs, sockets, and drop-highlight paths.
- `src/controller.coffee` — innermost-block hit testing, drag-subtree SVG,
  quadtree-backed drop selection, and the model mutation/undo flow.

The modern implementation is deliberately independent:

- `packages/javascript-adapter/src/index.js` — current-Acorn source-range
  projections and narrow source transformations.
- `packages/codemirror-editor/src/droplet.js` — CodeMirror ownership,
  projection lifecycle, opaque-source protection, and the temporary
  decoration/overlay experiment.

## Direct comparison

| Concern | Code.org-derived JavaScript editor | Current modern JavaScript path | Required parity work |
| --- | --- | --- | --- |
| Source authority | A mutable Droplet token/model tree is edited and stringified; Ace is synchronized around that model. | CodeMirror owns the only editable document and undo history. | Retain CodeMirror ownership. The BlockSurface may cache layout only, never a mutable source document. |
| Parse projection | `JavaScriptParser#mark` selectively creates blocks, sockets, indent containers, and comment blocks. It has special handling for `if`/`else`, braced and unbraced bodies, function parameters, standard beginner `for` loops, arrays, calls, and known functions. | Generic AST recursion produces document, statement, expression, selected socket, and whitespace ranges. A container has only `blockRole` and `headerTo`. | Add explicit semantic roles and body/sibling boundaries needed by layout and operations. Do not copy legacy model classes or make the legacy parser a dependency. |
| Containers | A block header and its `indent` child form one recursive, C-shaped visual structure. Nested child statements remain independently selectable. | Container metadata labels a whole statement range, but no independent modern body layout exists. | Model header, body, footer, body-end insertion zone, and child ownership in the projection/layout contract. |
| Statement geometry | `ContainerViewNode` calculates multiline SVG paths around child bounds; `BlockViewNode` adds puzzle tabs and carriage behavior. | CodeMirror mark rectangles and a viewport SVG overlay approximate source ranges. | Layout real blocks recursively in DOM/SVG. Geometry must derive from the projection tree and measurements, not text-line rectangles. |
| Blank lines | Indent/document layout gives empty lines width and preserves their visual position among blocks. | Physical blank and whitespace-only lines are projected as `whitespace` nodes. | Give each whitespace node measured height and a visible block-mode row; include it in sibling insertion ordering. |
| Comments | JavaScript `//` lines become comment blocks with an editable socket. Inline source remains part of its line/model behavior. | Acorn is not configured to emit comments, so modern JavaScript has no comment projection. | Collect exact JavaScript comment trivia and project standalone and inline comments as source ranges before implementing comment drag/drop parity. |
| Sockets and values | The parser assigns precedence, classes, dropdowns, known-function behavior, and language `drop` acceptance rules. Socket paths are exact hit/drop areas. | Selected arguments and expressions are sockets; replacement validates the resulting JavaScript. No categories, dropdowns, or acceptance matrix. | Define an explicit modern socket compatibility policy. Start with range-valid replacement; add only Code.org-visible acceptance/categories that the supported palette/UI needs. |
| Statement insertion | Every statement/indent/document provides a puzzle-shaped drop target. Target choice represents insertion before/after a sibling or into a suite. | `insert-statement` accepts any zero-width offset, and `move-statement` cuts/pastes raw AST ranges. | Expose only layout-derived sibling gaps and container body-end zones; resolve each to a syntax-aware source insertion operation. Dropping *on* a statement is not the model. |
| Hit testing | `Editor#hitTest` walks the model tree and returns the innermost SVG path containing the pointer. | Browser text selection and overlapping decorations can win; overlay hit testing is coordinate heuristic. | Use explicit BlockSurface target precedence: socket, innermost child/header, comment line-end, sibling gap, container body end. |
| Drag feedback | A separate `dragView` renders the dragged model subtree using the same `ViewNode` layout as the stationary editor; matching highlight paths show the destination. | The overlay experiment has no independent subtree renderer. | Reuse one modern subtree layout/render path for normal blocks, floating drag previews, and stationary placement previews. |
| Drag mutation | The controller computes acceptance, splices a model subtree, reparses sockets as needed, and records legacy undo operations. | One language transform yields normalized source changes dispatched in one CodeMirror transaction. | Keep the modern transaction contract. Convert a resolved drag target into an intent, let the adapter validate it, then reparse and relayout. |
| Unsupported syntax | Legacy behavior is constrained by its historical Acorn/parser rules. | Parse failures become exact opaque source regions, protected in block mode. | Preserve opaque recovery as a modern improvement; opaque regions must not pretend to be movable structured blocks. |

## Behavioral invariants for the new surface

1. A container header owns the container drag handle; its nested statements
   remain separate block targets. Dragging a nested statement cannot move the
   enclosing `if`, `for`, or function.
2. Container geometry has an accessible lower interior edge. A statement can
   be inserted at the end of a body without targeting a following outer-scope
   statement.
3. A placement preview and the dragged preview use the same tree layout as the
   stationary block. A container preview therefore remains a C-shaped subtree,
   not a flattened rectangle.
4. Physical whitespace and comments participate in ordering. A blank line is
   neither collapsed nor hidden behind a container footer.
5. All block gestures resolve to a minimal, validated source transformation and
   exactly one CodeMirror transaction. Text and block undo remain one history.
6. Source slices not directly changed by an explicit operation remain byte-for-
   byte identical.

## JavaScript parity corpus and staged scope

`test/data/javascript-compatibility.js` is the initial browser corpus because
it contains calls, values, inline comments, `if`/`else`, `for`, `while`, and a
function. It should be expanded with fixtures for nested containers, standalone
comments, blank/whitespace-only lines, unbraced bodies, and empty blocks.

Before public packaging, browser tests and the manual JavaScript playground
must prove at least:

1. drag an inner statement without moving its parent container;
2. drag a whole `if` or `for` with a structurally identical preview;
3. insert before, between, and after siblings, including at a container body
   end;
4. retain exact comments and blank lines through these operations; and
5. reject incompatible socket/opaque drops without modifying CodeMirror.

The modern surface does not need to reproduce every legacy option on day one
(palette dropdowns, every known-function catalogue entry, or floating blocks).
Those are separate compatibility decisions. It must, however, reproduce the
structural JavaScript block semantics that make Code.org-style direct
manipulation understandable and reliable.
