import {createElement, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef} from 'react';
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

  useLayoutEffect(() => {
    editorRef.current = new Editor(hostRef.current, editorOptions(latestProps.current));
    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.update(editorOptions(props));
    if (props.value !== undefined && editor.value !== props.value) editor.setValue(props.value);
  }, [props]);

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

function editorOptions({className, style, ...options}) {
  return options;
}
