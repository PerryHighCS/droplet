import {Annotation, EditorState, StateEffect, StateField} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
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
      layoutOptions: options.layoutOptions
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
    if (!Number.isInteger(target?.from) || !Number.isInteger(target?.to) || typeof source !== 'string') {
      throw new TypeError('Socket editing requires a source range and string value');
    }
    this.#socketRecovery = {projection: this.#projection, target};
    this.editor.dispatch({changes: {from: target.from, to: target.to, insert: source}});
  }

  #publishProjection() {
    this.editor?.dispatch({
      effects: this.#setProjection.of({
        projection: this.#projection,
        blockMode: this.#blockMode
      })
    });
    this.#surface?.update(this.#projection);
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

function collectProjectionNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectProjectionNodes)];
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

function createProjectionInteraction(onOperation) {
  let pointerDrag;
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const source = event.button === 0 && movableRangeFromElement(event.target);
      if (!source) return false;
      pointerDrag = {
        source,
        startX: event.clientX,
        startY: event.clientY,
        preview: undefined,
        dropGuide: undefined,
        dropPreview: undefined
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
      const attachmentTarget = commentAttachmentTarget(pointerDrag.source, view, event);
      const destination = attachmentTarget?.from ?? containerBottomDestinationAtPointer(pointerDrag.source, view, event) ?? statementDestinationAtPointer(view, event);
      updateDropTarget(pointerDrag, view, destination, event.clientX, event.clientY, attachmentTarget);
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
      const moved = drag.preview !== undefined;
      clearDragPreview(drag);
      if (!moved) {
        view.dispatch({selection: {anchor: drag.source.from, head: drag.source.to}});
        return true;
      }
      const attachmentTarget = commentAttachmentTarget(drag.source, view, event);
      const destination = attachmentTarget?.from ?? containerBottomDestinationAtPointer(drag.source, view, event) ?? statementDestinationAtPointer(view, event);
      const operation = projectionOperationFromDestination(drag.source, attachmentTarget, destination, view.state.doc.toString());
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

function updateDropTarget(drag, view, destination, clientX, clientY, attachmentTarget) {
  if (destination === undefined) {
    drag.dropGuide?.remove();
    drag.dropGuide = undefined;
    drag.dropPreview?.remove();
    drag.dropPreview = undefined;
    return;
  }
  drag.dropGuide ??= createDropGuide(drag.preview.ownerDocument);
  const destinationFrom = typeof destination === 'object' ? destination.from : destination;
  const boundary = [...view.dom.querySelectorAll('[data-droplet-kind="statement"], [data-droplet-kind="comment"]')]
    .find((block) => Number(block.dataset.dropletFrom) === destinationFrom);
  const rect = boundary?.getBoundingClientRect();
  const attachment = attachmentTarget && elementForRange(view, attachmentTarget)?.getBoundingClientRect();
  const container = typeof destination === 'object' && view.dom.ownerDocument.querySelector(
    `[data-droplet-role="container"][data-droplet-body-end="${destinationFrom}"]`
  );
  const containerLeft = Number(container?.dataset.dropletBottomLeft);
  const containerRight = Number(container?.dataset.dropletBottomRight);
  const containerBottom = Number(container?.dataset.dropletBottom);
  const insertion = !attachment && typeof destination === 'object' ? view.coordsAtPos(destinationFrom) : undefined;
  drag.dropGuide.dataset.dropletDestination = String(destinationFrom);
  drag.dropGuide.style.left = `${attachment?.right ?? rect?.left ?? insertion?.left ?? (Number.isFinite(containerLeft) ? containerLeft : clientX - 70)}px`;
  drag.dropGuide.style.top = `${attachment?.top ?? (rect ? rect.top - 2 : (insertion?.top ?? (Number.isFinite(containerBottom) ? containerBottom - 1 : clientY)) - 1)}px`;
  drag.dropGuide.style.width = `${attachment ? 3 : rect?.width ?? (Number.isFinite(containerRight) ? containerRight - containerLeft : 150)}px`;
  drag.dropPreview ??= createDropPlacementPreview(drag.preview.ownerDocument, drag.preview.textContent);
  drag.dropPreview.style.left = `${attachment?.right ?? rect?.left ?? insertion?.left ?? (Number.isFinite(containerLeft) ? containerLeft + 16 : clientX + 20)}px`;
  drag.dropPreview.style.top = `${attachment?.top ?? (rect ? rect.top - 28 : (insertion?.top ?? (Number.isFinite(containerBottom) ? containerBottom - 26 : clientY + 20)) - 26)}px`;
}

function clearDragPreview(drag) {
  drag.preview?.remove();
  drag.dropGuide?.remove();
  drag.dropPreview?.remove();
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

function createDropPlacementPreview(document, text) {
  const preview = document.createElement('div');
  preview.className = 'droplet-drop-preview';
  preview.textContent = text;
  Object.assign(preview.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '998', maxWidth: '320px',
    padding: '3px 6px', border: '1px dashed #4d7fb5', borderRadius: '4px',
    background: '#eaf3ff', color: '#456', opacity: '.72', whiteSpace: 'pre-wrap',
    font: 'inherit'
  });
  document.body.append(preview);
  return preview;
}

function statementDestinationAtPointer(view, event) {
  const position = view.posAtCoords({x: event.clientX, y: event.clientY});
  if (position === null) return undefined;
  const statements = [...view.dom.querySelectorAll('[data-droplet-kind="statement"], [data-droplet-kind="comment"]')]
    .map(projectionRangeFromBlock)
    .filter(Boolean)
    .filter((range, index, ranges) => ranges.findIndex((other) =>
      other.from === range.from && other.to === range.to) === index)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  return statements.find((statement) => statement.from >= position)?.from ?? view.state.doc.length;
}

function containerBottomDestinationAtPointer(source, view, event) {
  if (source.kind !== 'statement') return undefined;
  const containers = [...view.dom.ownerDocument.querySelectorAll('[data-droplet-role="container"][data-droplet-body-end]')].reverse();
  for (const container of containers) {
    const left = Number(container.dataset.dropletBottomLeft);
    const right = Number(container.dataset.dropletBottomRight);
    const bottom = Number(container.dataset.dropletBottom);
    if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(bottom) ||
        event.clientX < left || event.clientX > right || event.clientY < bottom - 18 || event.clientY > bottom + 18) continue;
    const from = Number(container.dataset.dropletBodyEnd);
    const destination = {from, to: from, indentation: container.dataset.dropletBodyIndentation ?? ''};
    const passFrom = Number(container.dataset.dropletEmptySuitePassFrom);
    const passTo = Number(container.dataset.dropletEmptySuitePassTo);
    if (Number.isInteger(passFrom) && Number.isInteger(passTo)) destination.emptySuitePass = {from: passFrom, to: passTo};
    return destination;
  }
  return undefined;
}

function commentAttachmentTarget(source, view, event) {
  if (source.kind !== 'comment') return undefined;
  if (movableRangeFromElement(event.target)?.kind === 'comment') return undefined;
  const renderedCandidates = [...view.dom.querySelectorAll('[data-droplet-kind="statement"]')]
    .map((block) => ({block, range: projectionRangeFromBlock(block)}))
    .filter(({range}) => range)
    .flatMap(({block, range}) => [...block.getClientRects()].map((rect) => ({range, rect})))
    .filter(({rect}) => event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.right - 3)
    .sort((left, right) => (left.range.to - left.range.from) - (right.range.to - right.range.from));
  if (renderedCandidates[0]) return renderedCandidates[0].range;
  const position = view.posAtCoords({x: event.clientX, y: event.clientY});
  if (position === null) return undefined;
  const line = view.state.doc.lineAt(position).number;
  const candidates = [...view.dom.querySelectorAll('[data-droplet-kind="statement"]')]
    .map((block) => ({block, range: projectionRangeFromBlock(block)}))
    .filter(({range}) => range && view.state.doc.lineAt(range.from).number === line)
    .sort((left, right) => (left.range.to - left.range.from) - (right.range.to - right.range.from));
  for (const {block, range} of candidates) {
    const rect = [...block.getClientRects()].find((candidate) =>
      event.clientY >= candidate.top && event.clientY <= candidate.bottom);
    // The full horizontal area after a statement line attaches a comment to it.
    // Releasing above, below, or over the statement remains a gap insertion.
    if (rect && event.clientX >= rect.right - 3) return range;
  }
  return undefined;
}

function elementForRange(view, range) {
  return [...view.dom.querySelectorAll('[data-droplet-from][data-droplet-to]')].find((element) =>
    Number(element.dataset.dropletFrom) === range.from && Number(element.dataset.dropletTo) === range.to);
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

function projectionOperationFromDestination(source, target, destination, document) {
  if (target) return projectionOperationFromDrop(source, target, document);
  const range = typeof destination === 'number'
    ? {from: destination, to: destination}
    : destination;
  if ((source.kind === 'statement' || source.kind === 'comment') && Number.isInteger(range?.from)) {
    return {
      type: source.kind === 'statement' ? 'move-statement' : 'move-comment',
      source: {from: source.from, to: source.to}, destination: range
    };
  }
  return undefined;
}

function projectionRangeFromElement(element) {
  const block = element?.closest?.('[data-droplet-from][data-droplet-to][data-droplet-kind]');
  return projectionRangeFromBlock(block);
}

function movableRangeFromElement(element) {
  // Comments can be nested in a statement decoration. Prefer their exact
  // range so dragging an inline comment never promotes the gesture to its
  // containing statement.
  const block = element?.closest?.('[data-droplet-kind="comment"]') ??
    element?.closest?.('[data-droplet-kind="statement"]');
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
  '.droplet-block-container': {
    backgroundColor: 'transparent'
  },
  '.droplet-block-comment': {
    backgroundColor: '#f0f0f0',
    borderRadius: '4px',
    color: '#555',
    cursor: 'grab'
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
