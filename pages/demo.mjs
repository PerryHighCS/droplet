import {DropletEditor} from '@droplet/editor';
import {javascript} from '@droplet/javascript';
import {createPythonLanguage} from '@droplet/python';

// The same four plain-JavaScript App Lab categories as the full playground:
// Control, Math, Variables, and Functions. App Lab-only runtime blocks are
// intentionally excluded because this demo executes no App Lab runtime.
const palette = [
  ['Control', 'control', [['if (true) { }', 'if (true) {\n}\n'], ['if (true) { } else { }', 'if (true) {\n} else {\n}\n'], ['while (true) { }', 'while (true) {\n}\n'], ['for (var i = 0; i < 4; i++) { }', 'for (var i = 0; i < 4; i++) {\n}\n']]],
  ['Math', 'math', [['value + value', 'value + value', 'expression'], ['value - value', 'value - value', 'expression'], ['value * value', 'value * value', 'expression'], ['value / value', 'value / value', 'expression'], ['value % value', 'value % value', 'expression'], ['value == value', 'value == value', 'expression'], ['value > value', 'value > value', 'expression'], ['value < value', 'value < value', 'expression'], ['value && value', 'value && value', 'expression'], ['value || value', 'value || value', 'expression'], ['!value', '!value', 'expression'], ['Math.round()', 'Math.round()', 'expression'], ['Math.random()', 'Math.random()', 'expression'], ['Math.pow(value, value)', 'Math.pow(value, value)', 'expression']]],
  ['Variables', 'variables', [['var value = 1;', 'var value = 1;\n'], ['var value;', 'var value;\n'], ['value = 1;', 'value = 1;\n'], ['value += 1;', 'value += 1;\n'], ['value -= 1;', 'value -= 1;\n'], ['console.log("message");', 'console.log("message");\n'], ['var str = "Hello World";', 'var str = "Hello World";\n'], ['value.substring("start", "end")', 'value.substring("start", "end")', 'expression'], ['value.length', 'value.length', 'expression'], ['var list = [1, 2, 3];', 'var list = [1, 2, 3];\n'], ['list[0]', 'list[0]', 'expression'], ['var object = {"key": "value"};', 'var object = {"key": "value"};\n']]],
  ['Functions', 'functions', [['function myFunction() { }', 'function myFunction() {\n}\n'], ['myFunction()', 'myFunction()', 'expression'], ['return ;', 'return;\n']]]
];
const pythonPalette = [
  ['Values & output', 'python', [['value = 1', 'value = 1\n'], ['value += 1', 'value += 1\n'], ['print()', 'print()\n']]],
  ['Operators', 'python', [['value + value', 'value + value', 'expression'], ['value - value', 'value - value', 'expression'], ['value * value', 'value * value', 'expression'], ['value == value', 'value == value', 'expression'], ['value > value', 'value > value', 'expression'], ['value and value', 'value and value', 'expression'], ['not value', 'not value', 'expression']]],
  ['Conditionals & loops', 'python', [['if True:', 'if True:\n  pass\n'], ['for item in range(3):', 'for item in range(3):\n  pass\n'], ['while True:', 'while True:\n  pass\n'], ['break', 'break\n'], ['continue', 'continue\n']]],
  ['Functions & modules', 'python', [['def name():', 'def name():\n  pass\n'], ['return value', 'return value\n'], ['name()', 'name()', 'expression'], ['import module', 'import module\n'], ['from module import name', 'from module import name\n']]],
  ['Notes', 'python', [['# comment', '# comment\n'], ['pass', 'pass\n']]]
];

window.brython();
const python = createPythonLanguage({pythonToAST: window.__BRYTHON__.pythonToAST, tokenize: window.__BRYTHON__.tokenizer});
const jsEditor = mount('javascript', javascript, 'var score = 0;\nif (score < 3) {\n  score += 1;\n}\n', {layoutOptions: {tabConnector: true}});
const pythonEditor = mount('python', python, 'score = 0\nif score < 3:\n  score += 1\n');
renderPalette(jsEditor, '#javascript-palette', palette);
renderPalette(pythonEditor, '#python-palette', pythonPalette);

function mount(id, language, value, options = {}) {
  const source = document.querySelector(`#${id}-source`);
  const button = document.querySelector(`[data-mode="${id}"]`);
  let editor;
  editor = new DropletEditor(document.querySelector(`#${id}-editor`), {...options, language, value, mode: 'blocks', onUpdate: refresh});
  function refresh() { source.textContent = editor.value; if (id === 'javascript' && editor.mode === 'blocks') colorJavaScript(editor); }
  refresh();
  button.addEventListener('click', () => { editor.toggleMode(); button.textContent = editor.mode === 'blocks' ? 'Use text mode' : 'Use block mode'; refresh(); });
  return editor;
}

function renderPalette(editor, selector, paletteEntries) {
  const target = document.querySelector(selector);
  for (const [name, category, blocks] of paletteEntries) {
    const section = document.createElement('details'); section.className = `palette-category cat-${category}`; section.open = category === 'control';
    const summary = document.createElement('summary'); summary.textContent = name;
    const blockEntries = document.createElement('div'); blockEntries.className = 'palette-blocks';
    for (const [label, source, kind] of blocks) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'palette-block'; button.draggable = true; button.textContent = label;
      button.addEventListener('dragstart', (event) => { event.dataTransfer.setData(kind === 'expression' ? 'application/x-droplet-expression' : 'application/x-droplet-statement', source); });
      button.addEventListener('click', () => insert(editor, source, kind)); blockEntries.append(button);
    }
    section.append(summary, blockEntries); target.append(section);
  }
}

function insert(editor, source, kind) {
  const {anchor, head} = editor.getSelection(); const range = anchor === head ? undefined : {from: Math.min(anchor, head), to: Math.max(anchor, head)};
  const socket = range && allNodes(editor.getProjection().root).find((node) => (node.kind === 'socket' || node.kind === 'recovery-socket') && node.from === range.from && node.to === range.to);
  if (kind === 'expression' && socket) editor.applyBlockOperation({type: 'replace-socket', target: socket, source});
  else editor.applyBlockOperation({type: 'insert-statement', destination: {from: range?.from ?? editor.value.length, to: range?.from ?? editor.value.length}, source: kind === 'expression' ? `${source}\n` : source});
}

function colorJavaScript(editor) {
  const svg = document.querySelector('#javascript-editor svg'); if (!svg) return;
  for (const node of allNodes(editor.getProjection().root)) {
    if (node.kind !== 'statement') continue;
    const type = node.metadata?.type ?? ''; const category = /^(If|Switch|For|While|DoWhile|Break|Continue)/.test(type) ? 'control' : /^(Binary|Logical|Unary|Update|Conditional)/.test(type) || /^Math\./.test(editor.value.slice(node.from, node.to)) ? 'math' : /^(Function|Return|Call|New)/.test(type) ? 'functions' : 'variables';
    const kind = node.metadata?.blockRole === 'container' ? 'container' : 'statement';
    svg.querySelector(`[data-droplet-kind="${kind}"][data-droplet-from="${node.from}"][data-droplet-to="${node.to}"]`)?.setAttribute('data-droplet-category', category);
  }
}

function allNodes(node) { return [node, ...(node.children ?? []).flatMap(allNodes)]; }
