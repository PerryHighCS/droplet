import {Annotation, EditorState, StateEffect, StateField} from '@codemirror/state';
import {
  applySourceChanges,
  isOpaque,
  normalizeSourceChanges,
  parseWithOpaqueRecovery
} from '@droplet/core';

import {createCodeMirrorEditor, externalValueAnnotation} from './index.js';
import {BlockSurface} from './block-surface-dom.js';

/** Marks a source transaction produced by a block operation. */
export const blockOperationAnnotation = Annotation.define();

/**
 * Connects a language projection to the generic CodeMirror editor. Source is
 * still owned solely by CodeMirror: a projection is discarded and reparsed
 * after every document transaction.
 */
export class DropletCodeMirrorEditor {
  #parse;
  #transform;
  #projection;
  #blockMode;
  #setProjection;
  #projectionField;
  #surface;
  #socketRecovery;
  #readOnly;

  constructor(options) {
    if (typeof options?.parse !== 'function') {
      throw new TypeError('A structured parse function is required');
    }
    if (options.transform !== undefined && typeof options.transform !== 'function') {
      throw new TypeError('A block transform must be a function');
    }

    this.#parse = options.parse;
    this.#transform = options.transform;
    this.#blockMode = options.blockMode === true;
    this.#readOnly = options.readOnly === true;
    this.#projection = this.#parseSource(options.value ?? '');
    this.#setProjection = StateEffect.define();
    this.#projectionField = createProjectionField(this.#setProjection, this.#projection);

    this.editor = createCodeMirrorEditor({
      parent: options.parent,
      value: options.value ?? '',
      language: options.language,
      theme: options.theme,
      readOnly: options.readOnly,
      extensions: [this.#projectionField, options.extensions ?? []],
      onChange: options.onChange,
      onUpdate: (update, metadata) => {
        if (update.docChanged) this.#reparse();
        options.onUpdate?.(update, metadata);
      }
    });
    this.#surface = new BlockSurface({
      parent: options.parent,
      onSelect: ({from, to}) => this.editor.setSelection({anchor: from, head: to}),
      onOperation: (operation) => this.applyBlockOperation(operation),
      onSocketEdit: ({target, source}) => this.#replaceSocketText(target, source),
      layoutOptions: options.layoutOptions,
      readOnly: this.#readOnly
    });

    if (this.#blockMode) this.#publishProjection();
  }

  getValue() {
    return this.editor.getValue();
  }

  setValue(value) {
    this.editor.setValue(value);
  }

  getProjection() {
    return this.#projection;
  }

  isUsingBlocks() {
    return this.#blockMode;
  }

  setBlockMode(enabled) {
    this.#blockMode = enabled === true;
    this.#projection = this.#parseSource(this.getValue());
    this.#publishProjection();
  }

  applyBlockOperation(operation) {
    if (this.#readOnly) throw new TypeError('Cannot apply a block operation to a read-only editor');
    if (!this.#transform) throw new TypeError('No block transform was configured');
    const changes = this.#transform(operation, this.#projection);
    if (!Array.isArray(changes)) {
      throw new TypeError('Block transforms must return an array of source changes');
    }
    const normalizedChanges = normalizeSourceChanges(this.getValue(), changes);
    applySourceChanges(this.getValue(), normalizedChanges);
    if (normalizedChanges.length) {
      this.editor.dispatch({
        changes: normalizedChanges,
        annotations: blockOperationAnnotation.of(true)
      });
    }
  }

  update(options = {}) {
    if (Object.hasOwn(options, 'parse')) {
      if (typeof options.parse !== 'function') throw new TypeError('A structured parse function is required');
      this.#parse = options.parse;
      this.#projection = this.#parseSource(this.getValue());
      this.#publishProjection();
    }
    if (Object.hasOwn(options, 'transform')) {
      if (options.transform !== undefined && typeof options.transform !== 'function') {
        throw new TypeError('A block transform must be a function');
      }
      this.#transform = options.transform;
    }
    if (Object.hasOwn(options, 'blockMode')) this.setBlockMode(options.blockMode);
    if (Object.hasOwn(options, 'readOnly')) {
      this.#readOnly = options.readOnly === true;
      this.#surface.setReadOnly(this.#readOnly);
    }
    const editorOptions = {...options};
    delete editorOptions.parse;
    delete editorOptions.transform;
    delete editorOptions.blockMode;
    if (Object.hasOwn(options, 'extensions')) {
      editorOptions.extensions = [
        this.#projectionField,
        options.extensions ?? []
      ];
    }
    this.editor.update(editorOptions);
  }

  destroy() {
    this.#surface.destroy();
    this.editor.destroy();
  }

  #parseSource(source) {
    return parseWithOpaqueRecovery(source, this.#parse);
  }

  #reparse() {
    const parsed = this.#parseSource(this.getValue());
    // #socketRecovery is set by #replaceSocketText immediately before its own
    // dispatch, so it is only ever valid for the one #reparse this triggers -
    // consumed here regardless of outcome. Left set, a later, unrelated
    // change (setValue, applyBlockOperation, a raw text edit) that happens to
    // also leave some opaque node behind would reuse this stale target and
    // previous-projection snapshot, whose length-based delta no longer
    // corresponds to anything in the current source.
    const recovery = this.#socketRecovery;
    this.#socketRecovery = undefined;
    this.#projection = (recovery && collectOpaqueNodes(parsed.root).length)
      ? recoverSocketProjection(recovery.projection, this.getValue(), recovery.target, parsed.issues)
      : parsed;
    this.#publishProjection();
  }

  #replaceSocketText(target, source) {
    if (this.#readOnly) throw new TypeError('Cannot edit a socket on a read-only editor');
    if (!Number.isInteger(target?.from) || !Number.isInteger(target?.to) || typeof source !== 'string') {
      throw new TypeError('Socket editing requires a source range and string value');
    }
    this.#socketRecovery = {projection: this.#projection, target};
    try {
      this.editor.dispatch({changes: {from: target.from, to: target.to, insert: source}});
    } finally {
      // A successful dispatch triggers exactly one #reparse, which already
      // consumes-and-clears this synchronously before dispatch returns. But
      // the projection's own transactionFilter (see createProjectionField)
      // can reject a change that touches an opaque node instead of applying
      // it - no docChanged update reaches #reparse then, so #socketRecovery
      // (valid only for the one #reparse a successful dispatch triggers)
      // would otherwise stay stale until some later, unrelated change
      // happens to also produce an opaque node and reuses it.
      if (this.#socketRecovery?.target === target) this.#socketRecovery = undefined;
    }
  }

  #publishProjection() {
    this.editor?.dispatch({
      effects: this.#setProjection.of({
        projection: this.#projection,
        blockMode: this.#blockMode
      })
    });
    // #reparse runs this on every document change regardless of mode, but the
    // surface is hidden (display: none) while in text mode - rebuilding its
    // layout and re-rendering its whole SVG tree on every keystroke there
    // pays real cost for something nobody can see. setBlockMode(true) already
    // republishes once the surface actually becomes visible.
    if (this.#blockMode) this.#surface?.update(this.#projection);
    this.#surface?.setVisible(this.#blockMode);
    if (this.editor?.view?.dom) this.editor.view.dom.style.display = this.#blockMode ? 'none' : '';
  }
}

export function createDropletCodeMirrorEditor(options) {
  return new DropletCodeMirrorEditor(options);
}

function createProjectionField(setProjection, initialProjection) {
  const field = StateField.define({
    create: () => ({projection: initialProjection, blockMode: false}),
    update: (value, transaction) => {
      for (const effect of transaction.effects) {
        if (effect.is(setProjection)) return effect.value;
      }
      return value;
    },
    provide: (stateField) => [
      EditorState.transactionFilter.of((transaction) => {
        const {projection, blockMode} = transaction.startState.field(stateField);
        if (!blockMode || !transaction.docChanged || isPermittedChange(transaction)) {
          return transaction;
        }
        return changesTouchOpaqueNode(transaction, projection) ? [] : transaction;
      })
    ]
  });
  return field;
}

function changesTouchOpaqueNode(transaction, projection) {
  const opaqueNodes = collectOpaqueNodes(projection.root);
  let touched = false;
  transaction.changes.iterChanges((from, to) => {
    if (opaqueNodes.some((node) => intersects(node, from, to))) touched = true;
  });
  return touched;
}

function collectOpaqueNodes(node) {
  return [
    ...(isOpaque(node) ? [node] : []),
    ...(node.children ?? []).flatMap(collectOpaqueNodes)
  ];
}

function intersects(node, from, to) {
  if (from === to) return from >= node.from && from < node.to;
  return from < node.to && to > node.from;
}

function recoverSocketProjection(previous, source, target, issues) {
  const delta = source.length - previous.source.length;
  const mapOffset = (offset) => offset >= target.to ? offset + delta : offset;
  const mapNode = (node) => {
    if (node.kind === 'socket' || node.kind === 'recovery-socket') {
      if (node.from === target.from && node.to === target.to) {
        return {
          ...node,
          kind: 'recovery-socket',
          to: target.from + (target.to - target.from) + delta,
          children: [],
          metadata: {...node.metadata, recovery: true}
        };
      }
    }
    return {
      ...node,
      from: mapOffset(node.from),
      to: mapOffset(node.to),
      children: (node.children ?? []).map(mapNode)
    };
  };
  return {source, root: mapNode(previous.root), issues};
}

function isPermittedChange(transaction) {
  return transaction.annotation(externalValueAnnotation) === true ||
    transaction.annotation(blockOperationAnnotation) === true;
}

/** Derives a source operation from a supported rendered block drop. */
export function projectionOperationFromDrop(source, target, document) {
  if (sameRange(source, target)) return undefined;
  if (source.kind === 'statement' && target.kind === 'statement') {
    return {
      type: 'move-statement',
      source: {from: source.from, to: source.to},
      destination: {from: target.from, to: target.from}
    };
  }
  if (source.kind === 'comment' && (target.kind === 'statement' || target.kind === 'comment')) {
    if (target.kind === 'statement') {
      return {
        type: 'move-comment', source: {from: source.from, to: source.to},
        destination: {from: target.from, to: target.to}, placement: 'line-end'
      };
    }
    return {
      type: 'move-comment',
      source: {from: source.from, to: source.to},
      destination: {from: target.from, to: target.from}
    };
  }
  if ((source.kind === 'expression' || source.kind === 'socket') && target.kind === 'socket') {
    return {
      type: 'replace-socket',
      target: {from: target.from, to: target.to},
      source: document.slice(source.from, source.to)
    };
  }
  return undefined;
}

function sameRange(left, right) {
  return left.from === right.from && left.to === right.to;
}
