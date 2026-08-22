# Modern core architecture

## Status and scope

This document defines the contract for the production editor. The existing
CoffeeScript/Ace editor remains a legacy reference harness; it is not an
implementation dependency of this architecture.

The central rule is: **source text is authoritative; blocks are a projection
over source ranges.** Merely viewing a document as blocks must not regenerate
or normalize its source.

## Responsibilities

| Component | Owns | Must not own |
| --- | --- | --- |
| Language adapter | Parsing, syntax recovery, node classification, valid source transformations | Rendering, DOM state, editor history |
| Source model | Immutable source snapshots, ranges, and changes | AST serialization as canonical source |
| Block projection | Structured and opaque block nodes derived from source ranges | Independent editable text |
| Block renderer | Layout, hit testing, and block interaction intents | Parsing or direct source mutation |
| CodeMirror integration | Canonical text document, transactions, selections, history, extensions | Block-specific grammar policy |
| Framework integration | Mounting, lifecycle, and framework-specific bindings | Core editing behavior |

In text mode, CodeMirror is the visible text surface. In block mode, a modern
Droplet `BlockSurface` is the visible surface while CodeMirror continues to own
the canonical document, transaction history, and source-to-selection mapping.
The `BlockSurface` has its own projection-derived recursive layout, hit testing,
insertion zones, and subtree previews. It must not infer block geometry from
CodeMirror text-mark rectangles or retain a mutable copy of source.

## Core types

```ts
export interface SourceRange {
  from: number; // inclusive UTF-16 offset in the current source snapshot
  to: number;   // exclusive UTF-16 offset in the current source snapshot
}

export interface SourceChange extends SourceRange {
  insert: string;
}

export type NodeKind = 'document' | 'statement' | 'expression' | 'socket' |
  'suite' | 'comment' | 'opaque-statement' | 'opaque-expression' |
  'opaque-region';

export interface ProjectionNode extends SourceRange {
  id: string;
  kind: NodeKind;
  children: readonly ProjectionNode[];
  editable: boolean;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ParseIssue extends SourceRange {
  message: string;
  severity: 'error' | 'warning';
}

export interface ParseResult {
  source: string;
  root: ProjectionNode;
  issues: readonly ParseIssue[];
}
```

Ranges always refer to the exact source snapshot in `ParseResult`. A consumer
must discard a projection after applying a change and request a new parse;
nodes are not mutable editor state.

## Language adapter contract

```ts
export interface LanguageAdapter {
  readonly id: string;
  parse(source: string, options?: unknown): ParseResult;
  transform(operation: BlockOperation, parsed: ParseResult): readonly SourceChange[];
}
```

`parse` must preserve every source character. When a region cannot be parsed
or is temporarily invalid, it returns an opaque node covering that exact range
plus a `ParseIssue`; it must not reject block mode for the whole document.

`@droplet/core` provides `parseWithOpaqueRecovery(source, parseStructured)` for
this boundary. It converts a parser failure into an opaque projection using the
error's optional `from`, `to`, and `opaqueKind` metadata, falling back to an
immovable opaque region covering the full snapshot. The next successful parse
returns its structured result directly, which is how opaque nodes recover after
a local or remote text transaction.

`transform` returns minimal, non-overlapping source changes. It may rewrite
only the ranges directly required by the requested block operation, such as a
socket replacement or statement move. It must not pretty-print the document or
regenerate unrelated AST source.

## Block operations and transactions

The renderer emits an intent, never a direct mutation:

```ts
export type BlockOperation =
  | { type: 'replace-socket'; target: SourceRange; source: string }
  | { type: 'move-statement'; source: SourceRange; destination: SourceRange }
  | { type: 'insert-statement'; destination: SourceRange; source: string };
```

The editor passes that intent to the language adapter, validates the returned
changes against the current CodeMirror snapshot, and applies one CodeMirror
transaction. CodeMirror consequently owns source state, selection mapping, and
undo/redo. A block operation cannot create a second mutable document or history.

## Generic CodeMirror editor

`@droplet/codemirror-editor` is the framework-independent boundary around
CodeMirror 6. Its `CodeMirrorEditor` owns exactly one `EditorView` and exposes
source value, selection, focus, scroll, dispatch, update, and destroy methods.
It is useful without a Droplet parser or renderer.

`setValue(value)` creates an `externalValueAnnotation` transaction. Such an
update is delivered through `onUpdate(update, {external: true})`, but does not
call `onChange`; ordinary local document transactions call both callbacks with
`external: false`. This keeps controlled consumers from feeding their own
value update back into application state while retaining CodeMirror's single
history and transaction stream.

Language, theme, read-only state, and consumer-supplied extensions are each
held in a CodeMirror `Compartment`. `update()` reconfigures those compartments
without recreating the view, so later Droplet, collaboration, and framework
extensions remain attached to the same canonical document.

The package's `droplet` subpath adds the projection adapter. It reparses with
`parseWithOpaqueRecovery` after every CodeMirror document change, renders
structured statements, expressions, sockets, and opaque ranges with CodeMirror
decorations in block mode, and filters direct changes that touch opaque internal
source. Externally synchronized source and
explicit block-operation transactions are allowed through that filter, so
repairing source automatically replaces the opaque projection. A language
adapter's `transform` result is range-validated and dispatched as one ordinary
CodeMirror transaction, preserving the same undo history as text edits.
Each rendered projection range carries its canonical source offsets; clicking
it dispatches a CodeMirror selection for that range rather than introducing a
parallel block selection model. Native drag/drop similarly emits only an
operation intent: a statement dropped on a statement requests a statement move,
and an expression or socket dropped on a socket requests a socket replacement.
The language adapter validates the resulting source transformation.

## Initial modern JavaScript adapter

`@droplet/javascript-adapter` is the first language implementation for this
boundary. It uses current Acorn independently of the legacy Acorn 1 runtime,
projects JavaScript AST nodes onto their original source ranges, and exposes
call arguments plus selected expression positions as sockets. Its supported
transforms are `replace-socket`, `insert-statement`, and `move-statement`.
They return only minimal source-range changes, validate that their resulting
source still parses, and leave all surrounding source—including comments and
lexical formatting—untouched.

## Opaque source and recovery

Opaque nodes are read-only internally and retain exact source. A known opaque
statement may be movable only when its structural context is known; opaque
expressions may enter compatible expression sockets only when the adapter can
prove the transformation valid. An unknown opaque region is not movable.

On every text transaction, the projection reparses from the new source. An
opaque node automatically becomes structured when valid syntax returns; no
manual conversion or source normalization is allowed.

## Preservation contract

For an unchanged projection, `parse(source).source === source`. Tests must
protect single and double quotes, triple quotes, escape sequences, comments,
blank lines, operator spacing, parentheses, indentation, and supported line
continuations. The current legacy fixtures establish the baseline:

- `test/data/javascript-compatibility.js`
- `test/data/python-lexical-compatibility.py`

Modern packages must run equivalent fixtures independently of the legacy
CoffeeScript runtime.
