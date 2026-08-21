# AGENTS.md

## Project overview

Droplet is a browser-based block/text editor. The repository currently contains
a Code.org-derived CoffeeScript/Ace implementation bundled with Browserify and
built/tested with Grunt. It is the legacy reference implementation and must
remain independently runnable. The planned production editor is a separate,
fully modern CodeMirror 6 implementation with framework-independent ESM
packages and a thin React wrapper.

## Modernization and upstream policy

1. Treat the legacy editor as an executable compatibility reference, not as a
   runtime dependency of modern packages. Modern code must not import, mount,
   or mutate its editor state.
2. Preserve the legacy file layout, CoffeeScript sources, Grunt/Browserify
   build path, QUnit pages, and baseline fixtures unless a task explicitly
   changes the reference implementation.
3. When a Code.org upstream change matters, first identify its observable
   behavior, capture it in a modern regression test, then selectively
   reimplement it. Do not assume upstream patches can be merged mechanically
   after modernization.
4. Keep CodeMirror 6 as the modern text source of truth. Block actions must be
   expressed as source-range transformations and normal editor transactions;
   do not maintain competing mutable legacy and CodeMirror documents.
5. Preserve exact source representation by default. Any intentional source
   rewrite must be narrow, test-covered, and attributable to an explicit block
   operation.
6. Introduce TypeScript, modern packages, or a new build system only in the
   modern implementation area or when the task explicitly calls for it. Do not
   migrate legacy modules opportunistically.

## Read first

Before changing code, read the relevant material:

1. `README.md` for setup, embedding, and public editor options.
2. `DESIGN.md` for the model, rendering, controller, and parser architecture.
3. `EMBEDDING.md` when changing the public browser API or distribution bundle.
4. `Gruntfile.coffee` and `package.json` when changing build, test, or server behavior.
5. The nearest source file and its matching tests before modifying a component.

## Repository layout

- `src/`: editor implementation. `main.coffee` is the Browserify entry point;
  `model.coffee`, `view.coffee`, `draw.coffee`, `controller.coffee`, and
  `parser.coffee` are the central editor layers.
- `src/languages/`: language-specific parsers and block definitions. Register
  modes in `src/modes.coffee`.
- `test/src/`: CoffeeScript unit and browser-test sources.
- `test/*.html`: QUnit browser-test entry pages.
- `example/`: runnable embedding examples.
- `css/`: source stylesheet.
- `antlr/`: checked-in grammar sources and generated parser artifacts.
- `vendor/`: checked-in third-party browser assets; do not hand-edit them.
- `packages/core/`: dependency-free modern source-range and opaque-projection
  foundation. It is ESM and tested independently with Node's test runner.
- `dist/`, `test/js/`, and generated example JavaScript: build output; do not
  manually edit or commit it unless a task explicitly requires a release artifact.

## Working rules

1. Keep changes narrow and preserve existing behavior unless the requested work
   deliberately changes it.
2. Follow local CoffeeScript conventions: two-space indentation, existing module
   style, and nearby naming patterns. Do not reformat unrelated code.
3. Maintain the document-model invariant described in `DESIGN.md`: serialized
   text must retain every source character (apart from deliberately reconstructed
   leading whitespace), while markup tokens carry block structure.
4. Add or update focused tests for changed behavior. Parser/model changes usually
   need Mocha coverage; browser interaction, rendering, or language-mode changes
   may also need QUnit coverage in `test/`.
5. Treat `antlr/*.g4` as the source of truth for grammar changes. Regenerate the
   accompanying artifacts only with the agreed grammar-generation workflow.
6. Do not edit `node_modules`, caches, or lockfile contents by hand. Change
   dependencies through npm and keep `package-lock.json` aligned when dependencies
   legitimately change.
7. Do not expose or commit secrets. This project should not require runtime
   credentials for normal local development.

## Commands

Run commands from the repository root. The devcontainer installs dependencies on
creation; otherwise run `PUPPETEER_SKIP_DOWNLOAD=true npm ci` and
`npm --prefix playwright ci` before browser testing on ARM64.

| Purpose | Command |
| --- | --- |
| Run the full build and test suite | `npm test` or `npx grunt all` |
| Build the unminified browser bundle | `npx grunt build` |
| Build distributable JavaScript and CSS | `npx grunt dist` |
| Build browser test bundles | `npx grunt buildtests` |
| Run all QUnit and Mocha tests | `npx grunt test` |
| Run one QUnit page, plus Mocha tests | `npx grunt test:<name>` (for example, `npx grunt test:ctest`) |
| Run browser tests on supported ARM64 Chromium | `npm run test:browser` |
| Run modern core tests | `npm --prefix packages/core test` |
| Run the legacy development server and watcher | `npm run dev` |
| Run the development server and watch bundle changes | `npx grunt testserver` |

`testserver` listens on port **8001**. The QUnit server used during tests listens
on port **8942**. These are the forwarded devcontainer ports; the `8000` values
in the README are stale.

## Verification

1. For source, CSS, language, or build changes, run `npm test` using the
   Node 14 baseline when practical. On ARM64, run `npm run test:browser` for
   the browser suite because the historical Puppeteer cannot install Chromium.
2. For a focused edit, run the narrowest relevant Grunt target first, then the
   full suite if the change could affect other editor layers.
3. For changes to examples or visible interaction, start `npx grunt testserver`
   and verify the relevant page in `example/` on port 8001.
4. If a browser-test failure is caused by the local environment (for example,
   unavailable browser tooling or port binding), report the exact command and
   limitation; do not represent the suite as passing.

## Git and safety

1. Check `git status --short` before editing. Preserve unrelated user changes.
2. Never commit directly to `main`.
3. Do not run destructive commands such as `git reset --hard`, broad recursive
   removal, or forced history rewrites unless explicitly requested.
4. Update `README.md`, `EMBEDDING.md`, or devcontainer configuration in the same
   change when their documented commands, ports, public API, or setup behavior
   changes.

## Definition of done

1. The requested behavior and focused tests are implemented.
2. Relevant verification has passed, or any environmental limitation is recorded.
3. Documentation reflects user-visible, build, embedding, or development-workflow
   changes.
