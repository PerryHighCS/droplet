import {Annotation, EditorState, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView} from '@codemirror/view';
import {applySourceChanges, isOpaque, parseWithOpaqueRecovery} from '@droplet/core';

import {createCodeMirrorEditor, externalValueAnnotation} from './index.js';

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
    this.#projection = this.#parseSource(options.value ?? '');
    this.#setProjection = StateEffect.define();
    this.#projectionField = createProjectionField(this.#setProjection, this.#projection);

    this.editor = createCodeMirrorEditor({
      parent: options.parent,
      value: options.value ?? '',
      language: options.language,
      theme: options.theme,
      readOnly: options.readOnly,
      extensions: [this.#projectionField, opaqueTheme, options.extensions ?? []],
      onChange: options.onChange,
      onUpdate: (update, metadata) => {
        if (update.docChanged) this.#reparse();
        options.onUpdate?.(update, metadata);
      }
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
    if (!this.#transform) throw new TypeError('No block transform was configured');
    const changes = this.#transform(operation, this.#projection);
    if (!Array.isArray(changes)) {
      throw new TypeError('Block transforms must return an array of source changes');
    }
    applySourceChanges(this.getValue(), changes);
    if (changes.length) {
      this.editor.dispatch({
        changes,
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
    const editorOptions = {...options};
    delete editorOptions.parse;
    delete editorOptions.transform;
    delete editorOptions.blockMode;
    if (Object.hasOwn(options, 'extensions')) {
      editorOptions.extensions = [
        this.#projectionField,
        opaqueTheme,
        options.extensions ?? []
      ];
    }
    this.editor.update(editorOptions);
  }

  destroy() {
    this.editor.destroy();
  }

  #parseSource(source) {
    return parseWithOpaqueRecovery(source, this.#parse);
  }

  #reparse() {
    this.#projection = this.#parseSource(this.getValue());
    this.#publishProjection();
  }

  #publishProjection() {
    this.editor?.dispatch({
      effects: this.#setProjection.of({
        projection: this.#projection,
        blockMode: this.#blockMode
      })
    });
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
      EditorView.decorations.from(stateField, ({projection, blockMode}) =>
        blockMode ? projectionDecorations(projection) : Decoration.none),
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

function projectionDecorations(projection) {
  const ranges = collectProjectionNodes(projection.root)
    .filter((node) => node.kind !== 'document' && node.from < node.to)
    .map((node) => Decoration.mark({
      class: isOpaque(node)
        ? `droplet-block droplet-opaque droplet-block-${node.kind}`
        : `droplet-block droplet-block-${node.kind}`
    }).range(node.from, node.to));
  return Decoration.set(ranges, true);
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

function collectProjectionNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectProjectionNodes)];
}

function intersects(node, from, to) {
  if (from === to) return from >= node.from && from < node.to;
  return from < node.to && to > node.from;
}

function isPermittedChange(transaction) {
  return transaction.annotation(externalValueAnnotation) === true ||
    transaction.annotation(blockOperationAnnotation) === true;
}

const opaqueTheme = EditorView.baseTheme({
  '.droplet-block-statement': {
    backgroundColor: '#eaf3ff',
    borderRadius: '4px'
  },
  '.droplet-block-expression': {
    backgroundColor: '#f3edff',
    borderRadius: '3px'
  },
  '.droplet-block-socket': {
    backgroundColor: '#fff',
    boxShadow: 'inset 0 0 0 1px #9ab5d6',
    borderRadius: '3px'
  },
  '.droplet-opaque': {
    backgroundColor: '#fff3cd',
    borderBottom: '1px dashed #8a6d3b'
  },
  '.droplet-opaque-expression': {borderRadius: '3px'},
  '.droplet-opaque-statement, .droplet-opaque-region': {display: 'inline'}
});
