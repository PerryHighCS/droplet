# Modern Droplet Editor

## Project Goal

Create a modern, maintained Droplet editor that:

1. Preserves the original Droplet philosophy that source text is authoritative.
2. Uses Code.org's Droplet lineage as an executable compatibility reference.
3. Incorporates the more complete historical Python work from Droplet PR #187.
4. Supports modern Python while preserving exact source representation wherever practical.
5. Allows users to switch to block mode even when some source cannot be structurally represented.
6. Represents unsupported or temporarily invalid source as read only opaque source blocks.
7. Uses CodeMirror 6 as the modern text editing engine.
8. Provides usable framework independent browser packages.
9. Provides a thin React package suitable for ActiveBits and MobCode.
10. Keeps execution separate from editing.
11. Makes it practical to assess and selectively reimplement future Code.org
    behavior and fixes.

## Modernization strategy

The current Code.org-derived CoffeeScript editor remains intact as a legacy
reference implementation. Its file layout, Ace integration, Grunt/Browserify
build, QUnit pages, and behavior fixtures must remain independently runnable.
It is not the runtime foundation of the modern editor.

The production editor will be fully modernized around CodeMirror 6, a
source-range-based core, framework-independent ESM packages, and a thin React
wrapper. Modern packages must not import, mount, or mutate the legacy editor's
runtime state. They may use its fixtures and browser suite as an executable
behavior specification.

Consequently, future Code.org changes are compatibility work rather than
mechanical merges: review each change, capture any relevant behavior in a
modern regression test, then selectively reimplement it. This accepts a higher
cost per adopted upstream change in exchange for avoiding permanent coupling to
Ace, the legacy document model, CoffeeScript, and Grunt.

---

# Phase 0: Establish Repository Lineage

The new repository should preserve both important Droplet development lines.

Primary upstream:

`droplet-editor/droplet:code-dot-org`

Historical Python source:

`droplet-editor/droplet` PR #187, branch `text-paste`, commit `ce34e2d05580b729c0420153013681f7ba504f68`

The Code.org branch becomes the starting point because it contains the modern JavaScript behavior and Code.org's post 2016 maintenance.

The Python branch remains a reference lineage rather than being merged wholesale.

## Repository setup

- [x] Fork `droplet-editor/droplet` into the desired GitHub organization or account.

- [x] Clone the new fork locally.

```bash
git clone git@github.com:PerryHighCS/droplet.git
cd droplet
```

- [x] Rename the fork remote to `origin` if necessary.

```bash
git remote rename <old-remote> origin
```

- [x] Add the original Droplet repository as `upstream`.

```bash
git remote add upstream https://github.com/droplet-editor/droplet.git
```

- [x] Fetch all upstream branches and tags.

```bash
git fetch upstream --tags
```

- [x] Verify the important upstream branches.

```bash
git branch -r
```

Expected important references:

```text
upstream/master
upstream/code-dot-org
```

- [x] Create a local archival branch representing original Droplet master.

```bash
git branch archive/original-master upstream/master
```

- [x] Create a local tracking branch for Code.org's maintained Droplet branch.

```bash
git switch -c upstream-codeorg upstream/code-dot-org
```

- [x] Push the Code.org tracking branch to the fork.

```bash
git push -u origin upstream-codeorg
```

- [x] Create the new project `main` from Code.org's branch.

```bash
git switch -c main upstream/code-dot-org
git push -u origin main
```

- [x] Preserve the historical Python branch locally.

```bash
git branch archive/python-text-paste ce34e2d05580b729c0420153013681f7ba504f68
```

- [x] Push the Python archive branch.

```bash
git push origin archive/python-text-paste
```

- [x] Push the original master archive.

```bash
git push origin archive/original-master
```

## Recommended remote structure

```text
origin
    our maintained fork

upstream
    droplet-editor/droplet
```

Recommended long lived branches:

```text
main
    our maintained editor

upstream-codeorg
    clean mirror or integration point for upstream/code-dot-org

archive/original-master
    historical original Droplet

archive/python-text-paste
    historical advanced Python implementation
```

## Upstream synchronization policy

Future Code.org changes should be inspected from:

```bash
git fetch upstream
git log main..upstream/code-dot-org
```

Changes should normally be merged or cherry picked deliberately into `main`.

Do not modify `upstream-codeorg` except when updating it to mirror `upstream/code-dot-org`.

### Phase 0 acceptance criteria

- [x] Repository exists under our ownership.
- [x] Git history retains the original Droplet ancestry.
- [x] `main` begins from Code.org's maintained branch.
- [x] Original master remains easily inspectable.
- [x] Python `text-paste` work remains easily inspectable.
- [x] Future Code.org changes can be compared against `main`.

---

# Phase 1: Establish a Reproducible Legacy Baseline

Before modernization, get the Code.org source working as closely as possible to its current behavior.

Do not change Ace, CoffeeScript, the parser architecture, or rendering architecture yet.

## Build

- [x] Document the existing build requirements.
- [x] Attempt the existing build using the historical expected Node environment.
- [x] Record all failures with current Node.
- [x] Produce the existing JavaScript distribution.
- [x] Produce an unminified development distribution.
- [x] Run whatever existing unit tests still function.
- [x] Run the existing browser examples.
- [x] Verify block to text and text to block switching.

### Baseline findings — 2026-08-21

- The Code.org package metadata declares Node `>=8.15` and npm `>=3.10.8`;
  its `package-lock.json` uses lockfile version 1. Its `.nvmrc` pins Node
  8.15.0, while the later GitHub Actions workflow uses Node 14.x.
- Node 14.21.3/npm 6.14.18 successfully runs `npx grunt dist`, producing the
  complete JavaScript and CSS distribution. This is the established legacy
  baseline runtime.
- On the devcontainer's Node 24.15.0/npm 11.12.1, a normal `npm ci` fails in
  Puppeteer 5.5.0 because that version has no Chromium binary for ARM64.
  `npm ci --ignore-scripts` installs the locked JavaScript dependencies for
  non-browser baseline checks.
- `npx grunt dist` creates `dist/droplet-full.js` and
  `dist/droplet-full.min.js`, but fails while minifying CSS because the legacy
  minifier calls the removed Node API `util.isRegExp`.
- `npx grunt mochaTest` passes all 21 parser/model tests on Node 24.
- On Node 14, `npm test` builds the distribution and all QUnit bundles, then
  reaches the QUnit runner but cannot launch `/usr/bin/chromium-browser`. The
  container has no system browser, and Puppeteer 5.5.0 cannot download one for
  ARM64, so that historical runner cannot provide browser validation.
- `npx grunt testserver` starts successfully with normal container port access;
  `example/example.html` is served at `http://localhost:8001`. Functional
  browser verification cannot use the historical Puppeteer dependency because
  it cannot install its ARM64 browser binary.
- The isolated `playwright/` workspace uses Node 24 and Playwright Chromium on
  ARM64 without modifying the legacy lockfile. `npm run test:browser` rebuilds
  the QUnit bundles and passes all seven browser pages (`ctest`, `cstest`,
  `htmltest`, `jstest`, `pytest`, `test`, and `uitest`) plus the browser-demo
  source-preservation test.

## Reference behavior

Create a small compatibility corpus for JavaScript.

- [x] Variable assignment.
- [x] Arithmetic expressions.
- [x] Function calls.
- [x] Nested function calls.
- [x] `if`.
- [x] `if / else`.
- [x] `for`.
- [x] `while`.
- [x] Function declaration.
- [x] Arrays.
- [x] Object expressions.
- [x] Comments.
- [x] Blank lines.
- [x] Inline comments.
- [x] String quoting.
- [x] Dragging statements.
- [x] Dragging expressions.
- [x] Editing sockets.
- [x] Undo.
- [x] Redo.
- [x] Toggle text to blocks to text.

Store expected source before and after each operation.

`test/data/javascript-compatibility.js` is the initial exact-source fixture for
the checked parser cases. `test/src/parserTests.coffee` asserts a byte-for-byte
parse/stringify round trip under the Code.org JavaScript mode.

`playwright/tests/qunit-pages.spec.mjs` also loads the browser demo with a
representative JavaScript program, toggles text → blocks → text through its
visible control, waits for each `toggledone` event, and verifies exact source
preservation. Its fixture includes the legacy editor's canonical trailing
newline: `Editor#getValue()` adds one for non-empty documents.

The `uitest` browser page supplies the interaction cases, all run in the
Playwright Chromium gate: `palette block expansion` inserts and repositions
statement blocks while asserting the resulting source; `Can replace a block
where we found it` drags a JavaScript expression into a socket and asserts the
exact changed program; and `reparse and undo reparse` edits a JavaScript socket
then verifies the source after reparse, undo, and redo. This makes the source
before and after each covered interaction part of the reproducible baseline.

## Code.org reference harness

Where practical, establish a browser page capable of loading:

```text
Code.org lineage Droplet + Ace
```

This becomes the reference implementation during modernization.

### Phase 1 acceptance criteria

- [x] Current Code.org lineage builds reproducibly.
- [x] A representative JavaScript program can be edited in blocks and text.
- [x] Existing behavior is documented by automated tests where practical.
- [x] We have a reference environment for comparing later behavior.

---

# Phase 2: Recover the Advanced Python Implementation

Bring the useful Python work from PR #187 into a branch based on modern Code.org Droplet.

Do not merge the entire `text-paste` branch.

## Create the Python integration branch

```bash
git switch main
git switch -c feature/python-recovery
```

## Recover relevant historical assets

Evaluate and selectively port:

- [x] `src/languages/python.coffee`
- [x] `test/src/pytest.coffee`
- [x] `example/example-python.coffee`
- [x] Python example HTML.
- [x] Any Python specific parser changes actually required by the adapter.
- [x] Any relevant `treewalk.coffee` behavior not already incorporated by later Droplet changes (evaluated; no global tree-walker change is required for the recovered baseline).

Avoid bringing unrelated C parser changes, Grunt experiments, generated grammar data, or unrelated historical work.

## Establish initial Python corpus

Begin with instructional Python.

- [x] Assignment.
- [x] Integer and floating point literals.
- [x] Single quoted strings.
- [x] Double quoted strings.
- [x] Arithmetic.
- [x] Comparisons.
- [x] Boolean expressions.
- [x] Function calls.
- [x] Nested function calls.
- [x] `print()`.
- [x] `input()`.
- [x] `if`.
- [x] `if / else`.
- [x] `if / elif / else`.
- [x] `for i in range(...)`.
- [x] Iteration over strings.
- [x] `while`.
- [x] Function definitions.
- [x] Parameters.
- [x] `return`.
- [x] Lists.
- [x] Indexing.
- [x] String indexing.
- [x] Comments.
- [x] Inline comments.
- [x] Blank lines.
- [x] Imports.

At this phase Python 2 era syntax may remain temporarily in historical tests. New project tests should use Python 3 syntax whenever possible.

### Phase 2 baseline findings — 2026-08-21

- The Code.org branch retained an unregistered Python adapter, but it used a
  superseded tree-walker configuration shape and failed before parsing a basic
  program. The focused port adapts the Python mode to the current tree-walker
  contract; it does not import the historical branch's unrelated renderer,
  controller, C-parser, or dependency changes.
- `test/src/pytest.coffee` is a browser-executed Python 3 round-trip corpus.
  It validates exact source preservation and that each supported program emits
  structural blocks. The runnable Python example is `example/example-python.html`.
  It has also been smoke-tested in Chromium with no page errors.

### Phase 2 acceptance criteria

- [x] The advanced Python adapter runs on top of the Code.org Droplet engine.
- [x] Basic Python text converts to meaningful blocks.
- [x] Block manipulation returns valid source for the supported subset.
- [x] Historical Python behavior is captured before larger changes begin.

---

# Phase 3: Define the Modern Core Architecture

Before replacing Ace or Skulpt, define the interfaces the modern implementation will use.

The central principle is:

**Source text is authoritative. Blocks are a projection over exact source ranges.**

## Separate responsibilities

Define explicit boundaries for:

```text
language parser
source model
block projection
block renderer
text editor integration
framework integration
```

## Source representation

Nodes should primarily reference source rather than regenerate it.

Conceptual model:

```ts
interface SourceRange {
  from: number
  to: number
}

interface SourceNode extends SourceRange {
  kind: string
  children: SourceNode[]
}
```

Additional metadata may describe:

```text
statement
expression
socket
indent suite
comment
opaque source
```

## Exact source preservation requirements

Viewing code as blocks must not normalize:

- [x] Single versus double quotes.
- [x] Triple single versus triple double quotes.
- [x] Escape sequences.
- [x] Inline comments.
- [x] Standalone comments.
- [x] Blank lines.
- [x] Spaces around operators.
- [x] Parentheses.
- [x] Existing indentation.
- [x] Line continuation style where supported.
- [x] Student formatting that does not prevent structural editing.

AST to source regeneration should not occur merely because the user switched modes.

### Phase 3 acceptance criteria

- [x] Parser API is documented.
- [x] Exact source ranges are a first class concept.
- [x] Renderer no longer needs to treat AST serialization as canonical source.
- [x] Tests explicitly protect lexical formatting.

---

# Phase 4: Add Opaque Read Only Source Blocks

Block mode should always remain available.

Unsupported or temporarily invalid source becomes an opaque block rather than preventing block mode.

## Opaque block types

Support at least:

```text
opaque statement
opaque expression
opaque source region
```

Possible behavior:

```text
Opaque statement
    exact source preserved
    internal contents read only
    may move as a statement when structural context is known

Opaque expression
    exact source preserved
    internal contents read only
    may move into compatible expression sockets when safe

Opaque unknown region
    exact source preserved
    read only
    movement disabled unless context is known
```

## Invalid source behavior

Example:

```python
if score >
```

should not disable block mode.

Instead:

```text
read only source block
"if score >"
```

When the text later becomes:

```python
if score > 10:
    print(score)
```

the block projection automatically becomes structured again.

## Collaboration implications

Remote text editing may temporarily invalidate local block structure.

Expected pipeline:

```text
remote text transaction
        ↓
CodeMirror document changes
        ↓
Droplet reparses affected ranges
        ↓
structured regions remain structured
invalid regions become opaque blocks
        ↓
valid syntax returns
        ↓
opaque blocks become structured again
```

### Phase 4 foundation acceptance criteria

- [x] The core can model every source document with structured or opaque ranges.
- [x] Unknown and invalid source remain source-preserving opaque projections.
- [x] Opaque regions preserve exact source and recover on the next successful parse.

### Phase 4 editor integration acceptance criteria

- [x] Block mode can display opaque source regions.
- [x] Invalid intermediate source does not force mode switching.
- [x] Opaque blocks automatically become structured blocks when parsing succeeds.

### Phase 4 foundation — 2026-08-21

`packages/core` now provides source-range-validated opaque statement,
expression, and unknown-region nodes. The model retains only ranges over the
canonical source snapshot, makes internal editing read-only, and requires an
adapter to opt in before an opaque statement or expression may move. It also
provides atomic minimal source-change application for the future CodeMirror
transaction adapter. `parseWithOpaqueRecovery` now supplies the parser boundary:
syntax failures yield opaque regions and the next successful parse returns a
structured projection. Initial CodeMirror projection rendering is documented
below; richer block layout remains later editor work.

### Phase 4 editor integration — 2026-08-21

The `@droplet/codemirror-editor/droplet` adapter reparses projections after
every CodeMirror source transaction. In block mode, opaque ranges have an
explicit read-only visual decoration while external source synchronization and
validated block operations remain allowed. A repaired source transaction is
therefore automatically reprojected as structured source without a mode switch.

---

# Phase 5: Build the Generic CodeMirror 6 Editor Layer

Create a framework independent CodeMirror integration.

Do not build Droplet directly against `@uiw/react-codemirror`.

Use CodeMirror 6 primitives.

## Generic editor responsibilities

- [x] Create and destroy `EditorView`.
- [x] Controlled external value synchronization.
- [x] Change callbacks.
- [x] Update callbacks.
- [x] Selection access.
- [x] Focus.
- [x] Scroll state.
- [x] Read only mode.
- [x] Theme reconfiguration.
- [x] Language reconfiguration.
- [x] Additional consumer extensions.
- [x] Transaction annotations for external versus local edits.
- [x] Multiple editor instances.
- [x] Proper cleanup.

Use CodeMirror `Compartment` objects for reconfigurable concerns.

Examples:

```ts
const languageCompartment = new Compartment()
const themeCompartment = new Compartment()
const readOnlyCompartment = new Compartment()
```

## Package target

Possible package:

```text
@droplet/editor-core
```

or:

```text
@droplet/codemirror-editor
```

This component should be useful without Droplet.

### Phase 5 acceptance criteria

- [x] Plain CodeMirror editor works without React.
- [x] External values synchronize predictably.
- [x] Undo history behaves correctly.
- [x] Language and theme changes do not recreate the editor.
- [x] Consumers may add CodeMirror extensions.
- [x] API is suitable for later replacement of MobCode's UIW wrapper.

### Phase 5 implementation — 2026-08-21

`packages/codemirror-editor` provides the framework-independent
`@droplet/codemirror-editor` package. It owns one CodeMirror document and
history, supports controlled external synchronization through an explicit
transaction annotation, and uses compartments for reconfigurable language,
theme, read-only state, and consumer extensions. The JSDOM test suite verifies
multiple independent instances, cleanup, selection, focus, scroll state,
history, and non-recreating reconfiguration. No legacy CoffeeScript or Ace
runtime is imported by the package.

---

# Phase 6: Create the Droplet CodeMirror Adapter

Replace Droplet's direct dependency on Ace with an explicit editor interface.

## Text editor abstraction

Identify the smallest interface Droplet truly needs.

Likely operations:

```text
getValue
setValue
dispatch source transaction
get selection
set selection
focus
get scroll position
set scroll position
coordinate conversion
document change events
resize or request measurement
```

## Initial adapters

Provide:

```text
Ace adapter
    reference compatibility

CodeMirror 6 adapter
    modern implementation
```

Ace may eventually become optional or archival.

## Critical transaction rule

Every block edit must ultimately become a CodeMirror document transaction.

```text
drag block
     ↓
calculate source transformation
     ↓
CodeMirror transaction
     ↓
document changes
     ↓
reparse
     ↓
rerender blocks
```

Do not maintain a separately authoritative block document.

### Phase 6 acceptance criteria

- [x] Existing Droplet operations work against CodeMirror.
- [x] Undo and redo include block operations naturally.
- [x] Text edits and block edits share one history.
- [x] CodeMirror selections survive reparsing where practical.
- [x] Existing CodeMirror extensions remain active in text mode.
- [x] Multiple editors may coexist.

### Phase 6 initial JavaScript path — 2026-08-21

`packages/javascript-adapter` provides a current-Acorn JavaScript projection
without importing the legacy parser. It preserves the full compatibility
fixture byte-for-byte, exposes range-backed call-argument and common expression
slots, and supports `replace-socket`, `insert-statement`, and
`move-statement`. Every operation is validated and dispatched through the
CodeMirror adapter as a single source transaction, so CodeMirror undo/redo
remains authoritative. The broader legacy interaction surface remains
outstanding Phase 6 work.

The initial CodeMirror projection presentation decorates structured statements,
expressions, sockets, and opaque ranges directly over canonical source. It is
not yet the legacy canvas renderer or full drag-and-drop UI. Clicking a
rendered range selects its exact CodeMirror source range through a normal
selection transaction. The initial native drag/drop surface emits
source-backed statement-move and expression/socket-replacement intents; opaque
regions do not become draggable operations.

The JavaScript integration suite also verifies source-selection mapping through
a block transaction and one shared undo/redo history for ordinary text edits
and block operations. Generic-editor tests cover independent editor instances
and extension reconfiguration, which remain active through the projection
adapter.

### Phase 6 acceptance — 2026-08-21

The modern JavaScript path covers the established core editor interactions:
editing source through CodeMirror, selecting projected ranges, moving
statements, replacing sockets with expressions, and issuing those moves through
native drag/drop intents. Those changes share CodeMirror selections, history,
undo/redo, extensions, and multi-instance lifecycle. This completes the editor
adapter phase; later rendering work may improve the presentation without
replacing its transaction model.

---

# Phase 7: Modernize Python Parsing

Once historical Python behavior works, replace its Python 2 assumptions.

## Preserve the parser boundary

The editor should not know whether Python syntax came from Skulpt or Brython.

Conceptual interface:

```ts
interface LanguageParser {
  parse(source: string): ParseResult
}
```

Initially:

```text
LegacySkulptPythonParser
```

Later:

```text
BrythonPythonParser
```

## Brython investigation and implementation

- [x] Verify current Brython AST locations.
- [x] Verify start and end offsets or line and column information.
- [x] Verify handling of comments and lexical trivia.
- [x] Determine whether tokenization is needed alongside AST parsing.
- [x] Build a Brython AST to Droplet source node adapter.
- [x] Compare structures against historical Skulpt behavior.
- [x] Maintain exact original source slices.

### Brython findings — 2026-08-21

- Brython 3.14.3 exposes start and end line/column locations on AST nodes in
  Chromium. Its columns match JavaScript string offsets, including surrogate
  pairs, so source ranges can address CodeMirror documents directly.
- Comments are intentionally absent from the AST. The initial adapter retains
  the complete original source and only projects AST ranges; a tokenizer is
  required before a structural operation can associate or move comments and
  other lexical trivia.
- `@droplet/python-adapter` wraps Brython's `pythonToAST` callback, maps its
  source ranges to modern projection nodes, and recovers syntax errors as an
  opaque source projection.
- Projection traverses unlocated Brython AST containers, preserving located
  parameters, defaults, and comprehension components instead of dropping them
  from the source-range tree.
- The historical Skulpt implementation projected parser tokens into its legacy
  markup model (including Python 2 `print`); the modern adapter instead uses
  semantic AST ranges. Compatibility work should compare source-preserving
  observable block behavior, not those incompatible internal trees.

## Modern Python corpus

Expand tests to include:

- [x] Python 3 `print()`.
- [x] Modern `input()`.
- [x] F strings.
- [x] Triple quoted strings.
- [x] Multiline strings.
- [x] Nested expressions.
- [x] List literals.
- [x] Dictionaries.
- [x] Tuples.
- [x] Slicing.
- [x] Keyword arguments.
- [x] Default parameters.
- [x] `for`.
- [x] `while`.
- [x] `break`.
- [x] `continue`.
- [x] `if / elif / else`.
- [x] Functions.
- [x] Imports.
- [x] List comprehensions.
- [x] Classes, initially possibly opaque if not structurally supported.
- [x] `match`, initially possibly opaque.
- [x] Type annotations, initially possibly opaque.

Support should grow progressively. Unsupported syntax remains usable through opaque source blocks.

### Phase 7 acceptance criteria

- [x] Basic instructional Python no longer depends on Python 2 grammar.
- [x] Modern Python constructs parse where supported.
- [x] Unsupported constructs remain visible as opaque blocks.
- [x] Quote style remains exact.
- [x] Triple quoted strings survive block mode unchanged.

---

# Phase 8: Define Indentation and Trivia Semantics

Python makes whitespace preservation a correctness requirement.

## Existing indentation

Never automatically normalize the entire file.

Preserve:

```text
spaces
tabs
mixed indentation
blank lines
```

unless an explicit block operation requires a source change.

### Brython tokenizer findings — 2026-08-21

Brython's tokenizer retains comment ranges, but its `INDENT` token has an empty
string and measures a tab as eight visual columns. AST ranges and ordinary
tokens can address the JavaScript source snapshot directly; indentation must
instead be read from the original leading line slice. This prevents tabs from
being silently converted or assigned the wrong source range.

`@droplet/python-adapter` exposes `collectPythonTrivia` for exact standalone
and inline comment ranges plus raw indentation slices. Broader structural
comment association remains future work.
It determines an inline comment from non-whitespace source preceding `#` on
the same line, so indented standalone comments remain standalone.

### Phase 8 implementation — 2026-08-22

`@droplet/python-adapter` now provides a Brython-bound source-range transformer
for socket replacement, statement insertion, and statement movement. It leaves
every untouched character intact, including blank lines, tabs, inline comments,
and standalone comments. Insertions use the target line's existing indentation;
statement movement reindents only the moved nonblank lines and validates the
result with Brython. `createEmptyPythonSuite` emits an explicitly indented
`pass` statement for a new empty suite.

The Chromium integration test drives these operations through
`DropletCodeMirrorEditor.applyBlockOperation`: it moves a nested compound suite
to module scope while retaining inline and standalone comments plus a blank
line, then inserts a new empty suite before a sibling statement.

The Code.org JavaScript mode remains the interaction reference: it marks each
AST statement independently, represents comments as separate comment blocks,
and allows drops into statement containers. The modern Python adapter follows
that model when supplied Brython's tokenizer: standalone comments are projected
as independently movable `comment` nodes, while nested statements retain their
own source ranges rather than inheriting the enclosing suite's drag behavior.
Statement drops resolve to insertion boundaries, with both a floating block and
a translucent placement preview. A comment released anywhere to the right of a
statement is instead attached as that statement's inline comment; a comment
released elsewhere moves between statement boundaries.

## Newly generated indentation

When Droplet creates a new suite or moves a statement:

1. Infer indentation from the surrounding suite.
2. Prefer existing file convention.
3. Preserve moved statement indentation when valid.
4. Reindent only the lines required by the move.
5. Never silently convert the entire file from tabs to spaces or spaces to tabs.

## Empty suites

Newly created empty Python suites should use:

```python
pass
```

until another statement is inserted.

## Comments

Preserve:

```python
x = 5  # inline comment
```

and:

```python
# standalone comment
x = 5
```

Standalone comments are draggable comment blocks. Dropping one anywhere to a
statement's right makes it that statement's inline comment.

Inline comments should normally remain associated with their containing statement.

### Phase 8 acceptance criteria

- [x] Tabs and spaces are not globally normalized.
- [x] New indentation follows local convention.
- [x] Blank lines survive block toggling.
- [x] Inline comments survive edits.
- [x] Standalone comments survive edits.
- [x] Empty suites remain valid Python.

---

# Phase 8.5: Reach Block Rendering and Drag Parity Before Packaging

The source-range projection established in Phases 4–8 is a foundation, not the
finished block editor. Before public packaging, the modern CodeMirror 6 editor
must match the agreed observable block behavior of Code.org Droplet's
JavaScript editor. The legacy renderer/controller remains the specification;
the modern implementation remains independent and source-authoritative.
`example/example-python.html` is also a concrete visual fixture: its `for`
container wraps `print(item)` through an indent container.
For broad JavaScript coverage, use the legacy Code.org-derived renderer with
`test/data/javascript-compatibility.js`; its `if`, `for`, `while`, function,
call, value, and inline-comment blocks are the primary modern-renderer parity
corpus. The relevant legacy behavior lives in `src/languages/javascript.coffee`
(projection), `src/view.coffee` (geometry), and `src/controller.coffee`
(innermost hit testing and subtree drag rendering).
`docs/architecture/codeorg-javascript-parity.md` directly compares those
implementations with the modern Acorn/CodeMirror path and is the detailed
acceptance specification for the BlockSurface work.

## Rendering decision — 2026-08-22

The initial CodeMirror decoration/SVG-overlay experiment established that the
projection and source-range transforms can drive visible block affordances. It
does **not** provide a production block editor: CodeMirror's text-line layout
cannot own C-container geometry, physical blank-line blocks, structural
insertion gaps, or subtree drag previews. Do not extend that experiment with
additional coordinate heuristics.

Block mode will instead present a modern Droplet block surface. CodeMirror
remains the sole source, transaction, selection-mapping, and history authority;
the block surface reads its current document/projection and emits only
source-range operation intents. In text mode the CodeMirror text surface is
visible. In block mode the modern block surface is visible and CodeMirror's
text surface is inactive or hidden. This is a reimplementation of the legacy
renderer/controller behavior, not reuse of the legacy CoffeeScript/Ace runtime.

The first renderer should use DOM/SVG layout rather than Canvas so source labels,
hit regions, accessibility semantics, and screenshot tests remain inspectable.
Canvas is a later performance option, not an architectural requirement.

## Replanned implementation sequence

1. [x] Define framework-independent block-layout types: measured block bounds,
   container header/body/footer regions, physical whitespace blocks, sibling
   insertion zones, and subtree preview geometry.
2. [x] Build a `BlockSurface` lifecycle owned by the modern adapter. It subscribes
   to CodeMirror document/projection updates but owns no editable source copy.
3. Implement recursive layout from the projection tree. A container owns its
   header and child layout; blank lines and comments have explicit measured
   nodes. Geometry must not be inferred from CodeMirror mark rectangles.
4. Implement hit testing against layout nodes and insertion zones. Child,
   container, socket, comment-line-end, and sibling-gap targets must be
   mutually explicit and precedence-tested.
5. Implement one subtree renderer for the on-surface block, floating drag
   preview, and stationary placement preview.
6. Connect accepted block intents to existing language-adapter transforms and
   one CodeMirror transaction. Reparse and relayout after every transaction.
7. Use the legacy JavaScript corpus and the Python playground as browser
   parity fixtures before resuming packaging work.

## Socket editing and expression replacement

Statement drag parity alone is not sufficient for a usable Droplet editor.
Before packaging, the BlockSurface must support direct editing and source-range
replacement of expression sockets. This remains source-authoritative: a socket
does not own a second mutable expression tree or document.

### Initial socket vertical slice

Implement and test these independently editable expression ranges first:

- [ ] Assignment target (left-value) socket.
- [ ] Assignment value (right-value) socket.
- [ ] `if` condition socket.

The assignment target is not merely a label. It must accept direct text edits
and expression-block replacement, then let the language parser validate that
the resulting expression is assignable. Initial adapters should support the
common assignable forms they can project (names, attributes, subscripts, and
supported unpacking) without making the target visually or behaviorally
read-only. The assignment value and `if` condition accept general expressions.

### Direct-edit lifecycle

1. Selecting a socket opens a focused text editor scoped to that exact source
   range; its initial value is the exact source slice.
2. Enter or focus loss commits the edited value through one normal CodeMirror
   transaction, maps the source range through that transaction, and reparses.
   Escape may explicitly cancel a still-uncommitted draft.
3. A successful parse replaces the editor with the newly projected structured
   socket/block geometry while preserving the document's exact surrounding
   source representation.
4. Dragging a compatible expression block onto a socket uses the same
   source-range replacement transaction and reparse path as a committed text
   edit.

### Incomplete and invalid expression recovery

An incomplete expression must never turn a user-editable socket into a
non-editable opaque block. When a committed socket edit prevents a full parse,
the renderer must retain the last known structural layout outside the affected
range and render that range as an **editable recovery socket**. It displays the
exact committed source text and a lightweight invalid/incomplete state; it
continues to accept direct edits and attempts reparse after each commit. Once
valid, it returns to ordinary structured socket rendering.

Generic opaque source recovery remains appropriate for malformed pasted text,
unsupported syntax, or a parse failure whose editable range cannot be
attributed. It must still offer an explicit text-edit route; opaque rendering
is never an interaction dead end. CodeMirror remains the canonical document,
selection mapping, transaction history, and undo/redo authority in every
recovery state.

### Socket verification

- [ ] Browser tests cover Enter and focus-loss commits for assignment target,
  assignment value, and `if` condition sockets.
- [ ] Browser tests cover compatible expression drag replacement for each
  initial socket kind.
- [ ] Tests prove an incomplete committed socket edit remains directly editable
  and re-structures after correction, without changing unrelated blocks.
- [ ] Tests reject or visibly recover an invalid assignment target without
  making its source inaccessible.
- [ ] Source-range and undo/redo tests prove socket edits and dragged
  replacements are normal CodeMirror transactions.

## Required rendering model

- [x] Distinguish atomic statement blocks from container statement blocks in
  language projections.
- [ ] Render a container as one multi-line block outline that wraps its header
  and nested child statement blocks, rather than as a rectangular decoration
  over one source range.
- [ ] Preserve nested block ownership: dragging a child statement moves only
  that child; dragging the container header moves the container and its body.
- [ ] Represent every blank or whitespace-only physical line as a distinct,
  source-preserving `whitespace` projection node and visible block-mode line.
- [ ] Keep standalone and inline comments as independent source-range nodes;
  moving an inline comment to a gap must not move its statement.

## Required rendering and interaction work

- [ ] Introduce a modern `BlockSurface` renderer, using DOM/SVG, that derives
  geometry from the projection tree and its own recursive layout—not CodeMirror
  line-layout decorations. It must not reuse the legacy Ace view at runtime.
- [ ] Give the renderer one subtree layout path used for the editor, the drag
  preview, and placement previews, so a container drag preview retains its
  header, nested children, indentation, comments, and whitespace lines.
- [ ] Render insertion affordances between sibling statements and whitespace
  lines; do not model a statement drop as dropping "onto" another statement.
- [ ] Expose the lower interior edge of every container C shape as a body-end
  insertion target. Its operation must retain the container's suite/body
  indentation (or JavaScript brace position), rather than borrowing indentation
  from the following sibling statement.
- [ ] Treat a Python suite containing only `pass`, comments, and blank lines
  as an empty container for an explicit first block insertion. Replace `pass`,
  preserve standalone comments and whitespace, and carry an inline `pass`
  comment to the inserted statement. A suite with any other executable
  statement is not empty and retains its `pass`.
- [ ] Retain the explicit comment-line-end gesture: the horizontal area to a
  statement's right attaches a dragged comment inline, while all other comment
  drops use insertion boundaries.
- [ ] Make hit testing select the innermost rendered block, matching the
  legacy controller's tree walk rather than relying on overlapping text marks.

## Verification and acceptance criteria

- [ ] A nested JavaScript container visually wraps its child statement blocks
  in the modern renderer.
- [ ] A nested Python suite visually wraps its child statement blocks in the
  modern renderer.
- [ ] Blank and whitespace-only lines survive a block/text round trip and are
  individually visible in block mode.
- [ ] Browser tests verify inner-statement versus container drag ownership,
  comment-only movement, and insertion placement.
- [ ] Browser screenshot or geometry tests verify that a dragged container
  preview has the same nested structure as its on-canvas block.
- [ ] Provide a modern JavaScript manual playground based on
  `test/data/javascript-compatibility.js`. It must be a beginner-friendly
  drag/drop example: users can visibly move an inner loop statement, a sibling
  statement, and an entire `if` or `for` container with the same structural
  preview and insertion affordances used by production block mode.

Only after these criteria are complete should Phase 9 package the editor's
public browser API.

---

# Phase 9: Package the Editor for Non React Use

The primary editor must be usable without React.

Recommended conceptual packages:

```text
packages/

  core
      parser independent source and block model

  javascript
      Code.org derived JavaScript adapter

  python
      Python adapter

  renderer
      SVG or DOM block renderer

  codemirror
      CodeMirror integration

  editor
      complete browser editor without React

  react
      thin React integration
```

Final package names can be chosen later.

### Manual playground — 2026-08-22

`example/modern-python.html` is an intentionally unbundled development page
for the modern Python path. It runs from the normal port-8001 dev server and
shows the authoritative source snapshot and current projection beside the
CodeMirror editor. It is not a replacement for automated tests: Playwright
smoke-tests that the page loads, while the page provides hands-on inspection of
mode switching, opaque recovery, and representative block operations.

## Browser API

Target usage:

```ts
import {DropletEditor} from '@droplet/editor'
import {python} from '@droplet/python'

const editor = new DropletEditor(element, {
  language: python,
  value: source,
})

editor.onChange((value) => {
  console.log(value)
})
```

## Core editor features

- [ ] `value`.
- [ ] Language.
- [ ] Filename.
- [ ] Text or block mode.
- [ ] Read only.
- [ ] Palette.
- [ ] Function metadata.
- [ ] Change events.
- [ ] Update events.
- [ ] Focus.
- [ ] Selection.
- [ ] Undo.
- [ ] Redo.
- [ ] Multiple instances.
- [ ] Extension hooks.

### Phase 9 acceptance criteria

- [ ] A plain HTML application can instantiate Droplet.
- [ ] React is not required by core packages.
- [ ] JavaScript and Python can be loaded independently where practical.
- [ ] Core editor API is documented.

---

# Phase 10: Build the React Package

React should wrap the framework independent editor rather than contain editor logic.

Possible API:

```tsx
<DropletEditor
  value={source}
  filename="main.py"
  mode="blocks"
  readOnly={false}
  extensions={extensions}
  onChange={setSource}
  onUpdate={handleUpdate}
/>
```

## React responsibilities

- [ ] Mount editor.
- [ ] Destroy editor.
- [ ] Synchronize controlled value.
- [ ] Update props through editor configuration.
- [ ] Forward CodeMirror updates.
- [ ] Support refs for imperative actions.
- [ ] Avoid unnecessary editor recreation.

## Possible imperative ref

```ts
interface DropletEditorRef {
  focus(): void
  getValue(): string
  setMode(mode: 'text' | 'blocks'): void
  toggleMode(): void
  undo(): void
  redo(): void
}
```

### Phase 10 acceptance criteria

- [ ] React package contains minimal editor logic.
- [ ] It works with React 19.
- [ ] Controlled state behaves correctly.
- [ ] Multiple instances work.
- [ ] Consumers can supply CodeMirror extensions.

---

# Phase 11: ActiveBits and MobCode Integration

Treat ActiveBits and MobCode as consumers, not as dependencies of Droplet.

MobCode's current editor contract should strongly inform compatibility.

Target conceptual replacement:

```tsx
<DropletEditor
  value={value}
  filename={filename}
  readOnly={readOnly}
  theme={theme}
  extensions={[remotePresenceExtension]}
  onChange={onChange}
  onUpdate={onUpdate}
/>
```

## Preserve MobCode responsibilities

Droplet should not own:

- [ ] Workspace files.
- [ ] Runner selection.
- [ ] Brython terminal execution.
- [ ] Session IDs.
- [ ] Import restrictions.
- [ ] Popup handling.
- [ ] Activity state.
- [ ] Remote session transport.

## Droplet responsibilities

- [ ] Editing.
- [ ] Text and block projection.
- [ ] Source preservation.
- [ ] CodeMirror integration.
- [ ] Block transformations.

## MobCode compatibility

- [ ] Existing remote presence CodeMirror extension works.
- [ ] Existing `ViewUpdate` handling works.
- [ ] Existing controlled source state works.
- [ ] Existing Brython runner receives unchanged file contents.
- [ ] Text and block edits both trigger the same source update path.

### Phase 11 acceptance criteria

- [ ] MobCode can replace its current editor with Droplet without changing runner architecture.
- [ ] MobCode remote cursors continue functioning in text mode.
- [ ] Block changes propagate through normal source updates.
- [ ] No ActiveBits specific dependency exists inside Droplet core.

---

# Phase 12: Collaborative Block Projection

This is not required for initial release, but architecture should permit it.

Scenario:

```text
Teacher editing text
Student viewing blocks
```

Remote text transactions update the shared CodeMirror document.

Droplet reparses locally.

Valid syntax remains structured.

Incomplete syntax temporarily becomes opaque blocks.

Future enhancements may map remote selections to blocks or sockets.

## Deferred collaboration work

- [ ] Render remote cursor on corresponding block.
- [ ] Render remote text selection as block or socket highlight.
- [ ] Display remote editing activity on opaque blocks.
- [ ] Preserve source offset mapping through block operations.

---

# Phase 13: Build and Source Modernization

Only after behavior is protected by tests should the implementation language and build system be modernized.

## Build tooling

- [ ] Replace Grunt.
- [ ] Replace Browserify.
- [ ] Add modern package workspace.
- [ ] Add modern test runner.
- [ ] Add Playwright browser integration tests and retire the PhantomJS QUnit runner.
- [ ] Produce ESM packages.
- [ ] Provide source maps.
- [ ] Add automated releases if desired.

## CoffeeScript migration

Do not rewrite CoffeeScript and architecture simultaneously.

Recommended approach:

1. Get tests passing.
2. Convert individual modules mechanically.
3. Preserve behavior.
4. Add types.
5. Refactor afterward.

Possible progression:

```text
CoffeeScript
    ↓
JavaScript
    ↓
TypeScript
```

or direct carefully tested conversion to TypeScript where practical.

### Phase 13 acceptance criteria

- [ ] No obsolete build runtime is needed.
- [ ] Packages build on current Node LTS.
- [ ] Test suite runs in CI.
- [ ] Generated packages are modern ESM.
- [ ] CoffeeScript can eventually be removed.

---

# Phase 14: Long Term Code.org Compatibility

Code.org remains an important upstream reference.

## Ongoing process

Periodically:

```bash
git fetch upstream
git log main..upstream/code-dot-org
```

Review each new Droplet change.

Classify it as:

```text
core fix
JavaScript parser fix
Ace specific integration
Code.org application specific behavior
irrelevant generated output
```

For each relevant behavior, add or update a modern regression test and
selectively reimplement it. Do not assume a legacy CoffeeScript patch can be
merged into the modern implementation.

## Compatibility documentation

Maintain:

```text
docs/upstream-codeorg.md
```

Document:

- [x] Last reviewed Code.org commit.
- [ ] Ported commits.
- [ ] Rejected commits and reasons.
- [x] Known behavioral divergence.
- [ ] JavaScript compatibility status.

---

# Cross Phase Testing Strategy

Every major transformation should be tested against source preservation.

## Round trip tests

For supported constructs:

```text
source
    ↓
parse
    ↓
block projection
    ↓
stringify without edits
    ↓
byte equivalent source where practical
```

## Block operation tests

```text
source
    ↓
blocks
    ↓
perform one block operation
    ↓
expected source
```

## Preservation tests

Explicit tests for:

- [ ] `'single quotes'`
- [ ] `"double quotes"`
- [ ] `'''triple single'''`
- [ ] `"""triple double"""`
- [ ] Escaped quotes.
- [ ] Multiline strings.
- [ ] Blank lines.
- [ ] Inline comments.
- [ ] Standalone comments.
- [ ] Four space indentation.
- [ ] Two space indentation.
- [ ] Tab indentation.
- [ ] Mixed indentation behavior.
- [ ] Parentheses.
- [ ] Student spacing.

## Opaque source tests

- [ ] Unknown statement.
- [ ] Unknown expression.
- [ ] Half typed expression.
- [ ] Half typed control statement.
- [ ] Modern unsupported syntax.
- [ ] Remote edit temporarily invalidating source.
- [ ] Recovery from opaque to structured block.

---

# Initial Milestone Definition

The first genuinely useful milestone should not be “modern Droplet complete.”

It should be:

> A browser based non React Droplet editor running on the Code.org lineage that uses CodeMirror 6, supports Code.org compatible JavaScript, supports the recovered Python feature set, preserves source formatting, and can represent unsupported source as read only opaque blocks.

That milestone gives us something immediately useful while leaving Python modernization, React integration, and deeper collaboration improvements incremental.

# Explicitly Deferred Until the Baseline Works

Do not initially:

- [ ] Rewrite the entire codebase in TypeScript.
- [ ] Replace the block renderer with React.
- [ ] Support every Python grammar feature.
- [ ] Implement execution inside Droplet.
- [ ] Implement ActiveBits specific state.
- [ ] Implement remote networking.
- [ ] Reformat student source.
- [ ] Attempt AST based source regeneration.
- [ ] Remove Ace before establishing the compatibility reference.
- [ ] Merge the entire historical `text-paste` branch.
- [ ] Copy generated Droplet code out of the Code.org monorepo as source.

# Recommended First Working Sequence

If implementation starts immediately, the practical order is:

- [x] Create fork and remotes.
- [x] Base `main` on `upstream/code-dot-org`.
- [x] Preserve original and Python historical branches.
- [x] Make Code.org Droplet build reproducibly.
- [x] Establish JavaScript compatibility tests.
- [x] Port the advanced Python adapter and tests.
- [x] Establish Python source preservation tests.
- [x] Introduce opaque read only blocks.
- [x] Define the editor abstraction.
- [x] Build the generic CodeMirror 6 wrapper.
- [x] Implement the initial Droplet CodeMirror adapter.
- [x] Make initial block operations dispatch CodeMirror transactions.
- [ ] Package the non React browser editor.
- [ ] Modernize Python parsing, likely using Brython.
- [ ] Add the thin React package.
- [ ] Integrate into MobCode.
- [ ] Retire UIW from MobCode if the new generic editor wrapper proves to be a clean replacement.
- [ ] Modernize the remaining legacy build and CoffeeScript incrementally.
