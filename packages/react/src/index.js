import {createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef} from 'react';
import {DropletEditor as Editor} from '@droplet/editor';

/**
 * React binding for the framework-independent Droplet editor.
 *
 * The underlying editor is mounted once. Prop changes are forwarded through
 * its public update API, while `value` remains controlled by React.
 */
export const DropletEditor = forwardRef(function DropletEditor(props, ref) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const latestProps = useRef(props);
  latestProps.current = props;
  const {
    language,
    filename,
    mode,
    readOnly,
    theme,
    extensions,
    layoutOptions,
    onChange,
    onUpdate,
    onOperationError,
    value
  } = props;

  useLayoutEffect(() => {
    editorRef.current = new Editor(hostRef.current, initialEditorOptions(latestProps.current));
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.update(updateOptions(props));
  }, [language, filename, mode, readOnly, theme, extensions, layoutOptions, onChange, onUpdate, onOperationError]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor && value !== undefined && editor.value !== value) editor.setValue(value);
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getValue: () => editorRef.current?.getValue(),
    setValue: (value) => editorRef.current?.setValue(value),
    setMode: (mode) => editorRef.current?.setMode(mode),
    toggleMode: () => editorRef.current?.toggleMode(),
    undo: () => editorRef.current?.undo(),
    redo: () => editorRef.current?.redo(),
    get editor() { return editorRef.current; }
  }), []);

  return createElement('div', {ref: hostRef, className: props.className, style: props.style});
});

function initialEditorOptions({className, style, ...options}) {
  return options;
}

function updateOptions({className, style, value, ...options}) {
  return options;
}
