import {Annotation, Compartment, EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {history} from '@codemirror/commands';

/** Marks a transaction created by setValue() rather than by an editor user. */
export const externalValueAnnotation = Annotation.define();

/**
 * A framework-independent, source-authoritative CodeMirror 6 editor.
 * Consumers can layer language, theme, collaboration, or later Droplet block
 * extensions onto this wrapper without allowing those integrations to own a
 * second document or history.
 */
export class CodeMirrorEditor {
  #language = new Compartment();
  #theme = new Compartment();
  #readOnly = new Compartment();
  #extensions = new Compartment();
  #onChange;
  #onUpdate;

  constructor(options) {
    if (!options?.parent) {
      throw new TypeError('A parent element is required');
    }

    this.#onChange = options.onChange;
    this.#onUpdate = options.onUpdate;
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.value ?? '',
        extensions: [
          history(),
          this.#language.of(asExtensions(options.language)),
          this.#theme.of(asExtensions(options.theme)),
          this.#readOnly.of(readOnlyExtensions(options.readOnly)),
          this.#extensions.of(asExtensions(options.extensions)),
          EditorView.updateListener.of((update) => this.#handleUpdate(update))
        ]
      })
    });
  }

  getValue() {
    return this.view.state.doc.toString();
  }

  setValue(value) {
    assertString(value, 'Editor value');
    if (value === this.getValue()) return;
    this.view.dispatch({
      changes: {from: 0, to: this.view.state.doc.length, insert: value},
      annotations: externalValueAnnotation.of(true)
    });
  }

  dispatch(transaction) {
    this.view.dispatch(transaction);
  }

  getSelection() {
    const {anchor, head} = this.view.state.selection.main;
    return {anchor, head};
  }

  setSelection(selection) {
    if (!Number.isInteger(selection?.anchor) || !Number.isInteger(selection?.head)) {
      throw new TypeError('Selection requires integer anchor and head offsets');
    }
    this.view.dispatch({selection});
  }

  focus() {
    this.view.focus();
  }

  getScrollPosition() {
    return {left: this.view.scrollDOM.scrollLeft, top: this.view.scrollDOM.scrollTop};
  }

  setScrollPosition({left = 0, top = 0}) {
    this.view.scrollDOM.scrollLeft = left;
    this.view.scrollDOM.scrollTop = top;
  }

  update(options = {}) {
    const effects = [];
    if (Object.hasOwn(options, 'language')) {
      effects.push(this.#language.reconfigure(asExtensions(options.language)));
    }
    if (Object.hasOwn(options, 'theme')) {
      effects.push(this.#theme.reconfigure(asExtensions(options.theme)));
    }
    if (Object.hasOwn(options, 'readOnly')) {
      effects.push(this.#readOnly.reconfigure(readOnlyExtensions(options.readOnly)));
    }
    if (Object.hasOwn(options, 'extensions')) {
      effects.push(this.#extensions.reconfigure(asExtensions(options.extensions)));
    }
    if (Object.hasOwn(options, 'onChange')) this.#onChange = options.onChange;
    if (Object.hasOwn(options, 'onUpdate')) this.#onUpdate = options.onUpdate;
    if (effects.length) this.view.dispatch({effects});
  }

  destroy() {
    this.view.destroy();
  }

  #handleUpdate(update) {
    this.#onUpdate?.(update, {
      external: update.transactions.some((transaction) =>
        transaction.annotation(externalValueAnnotation) === true)
    });
    if (update.docChanged && !update.transactions.some((transaction) =>
      transaction.annotation(externalValueAnnotation) === true)) {
      this.#onChange?.(update.state.doc.toString(), update);
    }
  }
}

export function createCodeMirrorEditor(options) {
  return new CodeMirrorEditor(options);
}

function readOnlyExtensions(readOnly) {
  return [EditorState.readOnly.of(readOnly === true), EditorView.editable.of(readOnly !== true)];
}

function asExtensions(extensions) {
  return extensions ?? [];
}

function assertString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
}
