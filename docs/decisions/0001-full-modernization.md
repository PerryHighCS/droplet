# ADR 0001: Fully modernize the production editor

**Status:** Accepted, 2026-08-21

## Context

The repository begins from Code.org's maintained Droplet lineage. That editor
uses CoffeeScript, Ace, a canvas renderer, Browserify, Grunt, and a mutable
legacy document model. The project goals require CodeMirror 6, exact source
preservation, modern Python, opaque source blocks, ESM packages, and a thin
React integration.

Keeping the legacy editor as the production core would couple the new product
to incompatible text models and two competing sources of truth. Replacing only
part of its UI would make selection, undo/redo, source preservation, and future
maintenance fragile.

## Decision

Build the production editor as a separate, fully modern implementation:

- CodeMirror 6 owns the source document and text transactions.
- The modern core models source ranges, block projection, and block operations.
- Browser packages are framework independent and published as ESM; React is a
  thin integration layer.
- Modern code does not import, mount, or mutate the legacy editor runtime.

Keep the Code.org-derived implementation intact as an independently runnable
reference harness. Its legacy build, QUnit pages, examples, and compatibility
fixtures are retained as an executable behavior specification.

## Consequences

Future Code.org updates are assessed as compatibility work, not mechanically
merged into the modern editor. For every adopted behavior, first add a modern
regression test, then selectively reimplement it. This raises the cost of an
individual adopted upstream change, but removes permanent dependence on Ace,
CoffeeScript, Grunt, and the legacy document model.

The project maintains two verification lanes during modernization:

1. The legacy Grunt/QUnit/Playwright lane keeps the reference behavior runnable.
2. The modern package test lane protects the new implementation and its public
   contracts.

## Alternatives considered

**Incrementally embed CodeMirror 6 in legacy Droplet:** rejected because Ace
and CodeMirror would maintain competing document, selection, and undo state.

**Keep legacy Droplet as the modern runtime core:** rejected because it blocks
the desired source-range architecture and modern distribution model.

**Discard the legacy tree:** rejected because it removes the best available
behavior oracle and makes Code.org compatibility harder to evaluate.
