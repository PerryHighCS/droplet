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
  projection lifecycle, and opaque-source protection; it publishes each
  projection to a `BlockSurface` rather than mounting decorations itself.
- `packages/codemirror-editor/src/block-surface.js` and
  `block-surface-dom.js` — the production block UI: framework-independent
  recursive layout, hit testing, and insertion-zone geometry, rendered as a
  DOM/SVG surface. It is not the temporary CodeMirror-decoration prototype
  this document originally described; that path has been removed.

## Direct comparison

| Concern | Code.org-derived JavaScript editor | Current modern JavaScript path | Required parity work |
| --- | --- | --- | --- |
| Source authority | A mutable Droplet token/model tree is edited and stringified; Ace is synchronized around that model. | CodeMirror owns the only editable document and undo history. | Retain CodeMirror ownership. The BlockSurface may cache layout only, never a mutable source document. |
| Parse projection | `JavaScriptParser#mark` selectively creates blocks, sockets, indent containers, and comment blocks. It has special handling for `if`/`else`, braced and unbraced bodies, function parameters, standard beginner `for` loops, arrays, calls, and known functions. | Generic AST recursion produces document, statement, expression, selected socket, and whitespace ranges. A braced container carries `blockRole`, `headerTo`, `bodyEnd`, and `blockEnd`; an unbraced one (`if (x) work();`) carries only `blockRole`/`headerTo`, since it has no closing brace to anchor a body-end or a new clause on. | Add remaining explicit semantic roles (known-function/category hints) needed for palette parity. Do not copy legacy model classes or make the legacy parser a dependency. |
| Containers | A block header and its `indent` child form one recursive, C-shaped visual structure. Nested child statements remain independently selectable. | `BlockSurface` (`block-surface.js`) lays out a real header/body/footer per container, including stacked elif/else clause sections and a shared footer, from the projection tree alone. Nested statements are independently selectable and draggable. | Palette-driven authoring of containers this document's corpus does not yet cover (see the staged scope below), and any remaining Code.org-specific container shapes. |
| Statement geometry | `ContainerViewNode` calculates multiline SVG paths around child bounds; `BlockViewNode` adds puzzle tabs and carriage behavior. | `block-surface.js` computes real recursive block geometry (bounds, header/body/footer regions, socket rects) from the projection and a text-measurement callback; `block-surface-dom.js` renders it as SVG. Geometry derives from the layout tree, not text-line rectangles. | Puzzle-tab/carriage-style visual affordances, if adopted, and any Code.org-specific geometry this document's corpus does not yet exercise. |
| Blank lines | Indent/document layout gives empty lines width and preserves their visual position among blocks. | Physical blank and whitespace-only lines are projected as `whitespace` nodes and laid out with measured height as an ordinary sibling row (`layoutWhitespace`), participating in the same insertion-zone ordering as statements. | Any remaining Code.org-specific blank-line affordances this document's corpus does not yet exercise. |
| Comments | JavaScript `//` lines become comment blocks with an editable socket. Inline source remains part of its line/model behavior. | Acorn is not configured to emit comments, so modern JavaScript has no comment projection. | Collect exact JavaScript comment trivia and project standalone and inline comments as source ranges before implementing comment drag/drop parity. |
| Sockets and values | The parser assigns precedence, classes, dropdowns, known-function behavior, and language `drop` acceptance rules. Socket paths are exact hit/drop areas. | Selected arguments and expressions are sockets; replacement validates the resulting JavaScript. No categories, dropdowns, or acceptance matrix. | Define an explicit modern socket compatibility policy. Start with range-valid replacement; add only Code.org-visible acceptance/categories that the supported palette/UI needs. |
| Statement insertion | Every statement/indent/document provides a puzzle-shaped drop target. Target choice represents insertion before/after a sibling or into a suite. | `block-surface.js` derives sibling-gap and container/document body-end insertion zones from the layout tree (`collectInsertionZones`); `BlockSurface`'s drag/palette-drop handlers resolve a pointer only against those zones before calling `insert-statement`/`move-statement`. Dropping *on* a statement is not the model. | Any remaining Code.org-specific drop-target shapes (for example a puzzle-tab visual) this document's corpus does not yet exercise. |
| Hit testing | `Editor#hitTest` walks the model tree and returns the innermost SVG path containing the pointer. | `hitTestBlockLayout` walks the layout tree with explicit precedence: a node's children (including an inline comment) win over the node itself, socket/header regions gate a container's own match, and an insertion zone is tried only once no node matches. | Any remaining Code.org-specific hit-test cases this document's corpus does not yet exercise. |
| Drag feedback | A separate `dragView` renders the dragged model subtree using the same `ViewNode` layout as the stationary editor; matching highlight paths show the destination. | `createSubtreePreview` reuses the dragged node's own layout (translated to origin) for both the floating drag preview and the stationary placement preview, rendered by `updateDragPreviews`. | Any remaining Code.org-specific highlight-path styling this document's corpus does not yet exercise. |
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

Phase 8.5 completed the structural BlockSurface acceptance coverage. Phase 9
delivered the public `@droplet/editor` package, package-consumer demo, and
Pages deployment workflow. The browser tests and manual JavaScript playground
now cover these release guarantees:

1. drag an inner statement without moving its parent container;
2. drag a whole `if` or `for` with a structurally identical preview;
3. insert before, between, and after siblings, including at a container body
   end;
4. retain exact comments and blank lines through these operations; and
5. reject incompatible socket/opaque drops without modifying CodeMirror.

The next compatibility increment is JavaScript comment trivia: project
standalone and inline `//` comments as exact source ranges, then extend the
fixture and browser coverage for comment editing and drag/drop. After that,
define the narrow socket/category policy required by the supported palette;
full legacy option parity remains a separate compatibility decision.

The modern surface does not need to reproduce every legacy option on day one
(palette dropdowns, every known-function catalogue entry, or floating blocks).
Those are separate compatibility decisions. It must, however, reproduce the
structural JavaScript block semantics that make Code.org-style direct
manipulation understandable and reliable.
