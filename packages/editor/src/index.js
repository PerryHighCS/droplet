import {redo, undo} from '@codemirror/commands';
import {EditorState} from '@codemirror/state';
import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';

/**
 * Framework-independent public editor API. CodeMirror remains the sole
 * source and history owner; this class only composes it with a language
 * projection and the modern BlockSurface.
 */
export class DropletEditor {
  #editor;
  #language;
  #filename;

  constructor(parent, options = {}) {
    if (!parent?.appendChild) throw new TypeError('A parent element is required');
    this.#language = assertLanguage(options.language);
    if (options.mode !== undefined) assertMode(options.mode);
    this.#filename = options.filename ?? '';
    assertString(this.#filename, 'Filename');
    this.#editor = createDropletCodeMirrorEditor({
      parent,
      value: options.value ?? '',
      parse: this.#language.parse,
      transform: this.#language.transform,
      blockMode: options.mode === 'blocks',
      readOnly: options.readOnly,
      theme: options.theme,
      extensions: options.extensions,
      layoutOptions: options.layoutOptions,
      onChange: options.onChange,
      onUpdate: options.onUpdate,
      onOperationError: options.onOperationError
    });
  }

  get value() { return this.#editor.getValue(); }
  set value(value) { this.setValue(value); }
  get filename() { return this.#filename; }
  get language() { return this.#language; }
  get mode() { return this.#editor.isUsingBlocks() ? 'blocks' : 'text'; }
  get readOnly() { return this.#editor.editor.view.state.facet(EditorState.readOnly); }

  getValue() { return this.#editor.getValue(); }
  setValue(value) { this.#editor.setValue(value); }
  getProjection() { return this.#editor.getProjection(); }
  getSelection() { return this.#editor.editor.getSelection(); }
  setSelection(selection) { this.#editor.editor.setSelection(selection); }
  focus() { this.#editor.editor.focus(); }
  undo() { return undo(this.#editor.editor.view); }
  redo() { return redo(this.#editor.editor.view); }
  setMode(mode) {
    assertMode(mode);
    this.#editor.setBlockMode(mode === 'blocks');
  }
  toggleMode() { this.setMode(this.mode === 'blocks' ? 'text' : 'blocks'); }
  applyBlockOperation(operation) { return this.#editor.applyBlockOperation(operation); }

  update(options = {}) {
    // Validate the whole public configuration before reconfiguring either the
    // wrapper or CodeMirror. A rejected later option must not leave a new
    // parser/projection or filename behind from an earlier one.
    const nextLanguage = Object.hasOwn(options, 'language') ? assertLanguage(options.language) : this.#language;
    if (Object.hasOwn(options, 'filename')) assertString(options.filename, 'Filename');
    if (Object.hasOwn(options, 'mode')) assertMode(options.mode);

    if (nextLanguage !== this.#language) {
      this.#language = nextLanguage;
      this.#editor.update({parse: this.#language.parse, transform: this.#language.transform});
    }
    if (Object.hasOwn(options, 'filename')) {
      this.#filename = options.filename;
    }
    const editorOptions = {...options};
    delete editorOptions.language;
    delete editorOptions.filename;
    if (Object.hasOwn(editorOptions, 'mode')) {
      this.setMode(editorOptions.mode);
      delete editorOptions.mode;
    }
    this.#editor.update(editorOptions);
  }

  destroy() { this.#editor.destroy(); }
}

export function createDropletEditor(parent, options) {
  return new DropletEditor(parent, options);
}

function assertLanguage(language) {
  if (!language || typeof language.parse !== 'function' || typeof language.transform !== 'function') {
    throw new TypeError('Language must provide parse(source) and transform(operation, projection) functions');
  }
  return language;
}

function assertString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
}

function assertMode(mode) {
  if (mode !== 'text' && mode !== 'blocks') throw new TypeError('Mode must be "text" or "blocks"');
}
