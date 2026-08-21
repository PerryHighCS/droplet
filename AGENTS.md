# AGENTS.md

## Project overview

Droplet is a browser-based block/text editor. The application is written primarily
in CoffeeScript, bundled for the browser with Browserify, and built/tested with
Grunt. It is a legacy JavaScript project: do not introduce TypeScript, a modern
framework, or a new build system unless the task explicitly calls for it.

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
creation; otherwise run `npm install`.

| Purpose | Command |
| --- | --- |
| Run the full build and test suite | `npm test` or `npx grunt all` |
| Build the unminified browser bundle | `npx grunt build` |
| Build distributable JavaScript and CSS | `npx grunt dist` |
| Build browser test bundles | `npx grunt buildtests` |
| Run all QUnit and Mocha tests | `npx grunt test` |
| Run one QUnit page, plus Mocha tests | `npx grunt test:<name>` (for example, `npx grunt test:ctest`) |
| Run the development server and watch bundle changes | `npx grunt testserver` |

`testserver` listens on port **8001**. The QUnit server used during tests listens
on port **8942**. These are the forwarded devcontainer ports; the `8000` values
in the README are stale.

## Verification

1. For source, CSS, language, or build changes, run `npm test` when practical.
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
