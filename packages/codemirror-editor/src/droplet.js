import {Annotation, EditorState, StateEffect, StateField} from '@codemirror/state';
import {Decoration, EditorView} from '@codemirror/view';
import {
  applySourceChanges,
  isOpaque,
  normalizeSourceChanges,
  parseWithOpaqueRecovery
} from '@droplet/core';

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
  #interaction;

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
    this.#interaction = createProjectionInteraction((operation) => this.applyBlockOperation(operation));

    this.editor = createCodeMirrorEditor({
      parent: options.parent,
      value: options.value ?? '',
      language: options.language,
      theme: options.theme,
      readOnly: options.readOnly,
      extensions: [this.#projectionField, this.#interaction, opaqueTheme, options.extensions ?? []],
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
    const editorOptions = {...options};
    delete editorOptions.parse;
    delete editorOptions.transform;
    delete editorOptions.blockMode;
    if (Object.hasOwn(options, 'extensions')) {
      editorOptions.extensions = [
        this.#projectionField,
        this.#interaction,
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
        : `droplet-block droplet-block-${node.kind}`,
      attributes: {
        'data-droplet-from': String(node.from),
        'data-droplet-to': String(node.to),
        'data-droplet-kind': node.kind
      }
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

function createProjectionInteraction(onOperation) {
  let pointerDrag;
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const source = event.button === 0 && statementRangeFromElement(event.target);
      if (!source) return false;
      pointerDrag = {
        source,
        sourceElement: event.target.closest('[data-droplet-kind="statement"]'),
        startX: event.clientX,
        startY: event.clientY,
        preview: undefined,
        targetElement: undefined,
        dropGuide: undefined
      };
      event.preventDefault();
      return true;
    },
    mousemove(event, view) {
      if (!pointerDrag) return false;
      const moved = Math.abs(event.clientX - pointerDrag.startX) > 4 ||
        Math.abs(event.clientY - pointerDrag.startY) > 4;
      if (!moved) return true;
      pointerDrag.preview ??= createDragPreview(view, pointerDrag.source);
      updateDragPreview(pointerDrag.preview, event.clientX, event.clientY);
      const target = statementRangeFromElement(event.target);
      const destination = target?.from ?? statementDestinationAtPointer(view, event);
      updateDropTarget(pointerDrag, event.target, destination, event.clientX, event.clientY);
      event.preventDefault();
      return true;
    },
    click(event, view) {
      if (event.button !== 0) return false;
      const range = projectionRangeFromElement(event.target);
      if (!range) return false;
      view.dispatch({selection: {anchor: range.from, head: range.to}});
      return true;
    },
    mouseup(event, view) {
      const drag = pointerDrag;
      pointerDrag = undefined;
      if (!drag || event.button !== 0) return false;
      const target = statementRangeFromElement(event.target);
      const moved = drag.preview !== undefined;
      clearDragPreview(drag);
      if (!moved) {
        view.dispatch({selection: {anchor: drag.source.from, head: drag.source.to}});
        return true;
      }
      const destination = target?.from ?? statementDestinationAtPointer(view, event);
      const operation = projectionOperationFromDestination(drag.source, target, destination, view.state.doc.toString());
      if (!operation) return true;
      event.preventDefault();
      onOperation(operation);
      return true;
    }
  });
}

function createDragPreview(view, source) {
  const preview = view.dom.ownerDocument.createElement('div');
  preview.className = 'droplet-drag-preview';
  preview.textContent = view.state.doc.sliceString(source.from, source.to);
  Object.assign(preview.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '1000', maxWidth: '320px',
    padding: '4px 7px', border: '1px solid #608cc1', borderRadius: '4px',
    background: '#eaf3ff', boxShadow: '0 3px 10px #0003', whiteSpace: 'pre-wrap',
    font: 'inherit', opacity: '.92'
  });
  view.dom.ownerDocument.body.append(preview);
  return preview;
}

function updateDragPreview(preview, clientX, clientY) {
  preview.style.left = `${clientX + 12}px`;
  preview.style.top = `${clientY + 12}px`;
}

function updateDropTarget(drag, element, destination, clientX, clientY) {
  const targetElement = element?.closest?.('[data-droplet-kind="statement"]');
  if (drag.targetElement !== targetElement) {
    drag.targetElement?.classList.remove('droplet-block-drop-target');
    drag.targetElement = targetElement;
    if (targetElement && targetElement !== drag.sourceElement) targetElement.classList.add('droplet-block-drop-target');
  }
  if (targetElement || destination === undefined) {
    drag.dropGuide?.remove();
    drag.dropGuide = undefined;
    return;
  }
  drag.dropGuide ??= createDropGuide(drag.preview.ownerDocument);
  drag.dropGuide.style.left = `${clientX - 70}px`;
  drag.dropGuide.style.top = `${clientY - 1}px`;
}

function clearDragPreview(drag) {
  drag.preview?.remove();
  drag.dropGuide?.remove();
  drag.targetElement?.classList.remove('droplet-block-drop-target');
}

function createDropGuide(document) {
  const guide = document.createElement('div');
  guide.className = 'droplet-drop-guide';
  Object.assign(guide.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '999', width: '150px', height: '3px',
    borderRadius: '2px', background: '#4d7fb5', boxShadow: '0 0 0 2px #eaf3ff'
  });
  document.body.append(guide);
  return guide;
}

function statementDestinationAtPointer(view, event) {
  const position = view.posAtCoords({x: event.clientX, y: event.clientY});
  if (position === null) return undefined;
  const statements = [...view.dom.querySelectorAll('[data-droplet-kind="statement"]')]
    .map(projectionRangeFromBlock)
    .filter(Boolean)
    .filter((range, index, ranges) => ranges.findIndex((other) =>
      other.from === range.from && other.to === range.to) === index)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return statements.find((statement) => statement.from >= position)?.from ?? view.state.doc.length;
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
  if ((source.kind === 'expression' || source.kind === 'socket') && target.kind === 'socket') {
    return {
      type: 'replace-socket',
      target: {from: target.from, to: target.to},
      source: document.slice(source.from, source.to)
    };
  }
  return undefined;
}

function projectionOperationFromDestination(source, target, destination, document) {
  if (target) return projectionOperationFromDrop(source, target, document);
  if (source.kind === 'statement' && Number.isInteger(destination)) {
    return {type: 'move-statement', source: {from: source.from, to: source.to}, destination: {from: destination, to: destination}};
  }
  return undefined;
}

function projectionRangeFromElement(element) {
  const block = element?.closest?.('[data-droplet-from][data-droplet-to][data-droplet-kind]');
  return projectionRangeFromBlock(block);
}

function statementRangeFromElement(element) {
  const block = element?.closest?.('[data-droplet-kind="statement"]');
  return projectionRangeFromBlock(block);
}

function projectionRangeFromBlock(block) {
  if (!block) return undefined;
  const from = Number(block.dataset.dropletFrom);
  const to = Number(block.dataset.dropletTo);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return undefined;
  return {from, to, kind: block.dataset.dropletKind};
}

function sameRange(left, right) {
  return left.from === right.from && left.to === right.to;
}

const opaqueTheme = EditorView.baseTheme({
  '.droplet-block-statement': {
    backgroundColor: '#eaf3ff',
    borderRadius: '4px',
    cursor: 'grab'
  },
  '.droplet-block-drop-target': {
    outline: '2px solid #4d7fb5',
    outlineOffset: '2px'
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
