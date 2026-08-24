import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';
import {
  createBrythonPythonParser,
  createBrythonPythonTransformer,
  createEmptyPythonSuite
} from '/packages/python-adapter/src/index.js';

const samples = {
  'Comments and nested suite': 'if outer:\n  # standalone note\n  if ready:\n    first = 1  # inline note\n  second = 2\n\ntail = 0\n',
  'Tabs and blank lines': 'if ready:\n\t# tab-indented comment\n\tprint("ready")\n\nprint("done")\n',
  'Opaque recovery': 'if score >\n'
};

const palette = [
  {
    name: 'Values & output', blocks: [
      {id: 'assignment', label: 'value = 1', source: 'value = 1\n'},
      {id: 'augmented-assignment-add', label: 'value += 1', source: 'value += 1\n'},
      {id: 'augmented-assignment-sub', label: 'value -= 1', source: 'value -= 1\n'},
      {id: 'augmented-assignment-mul', label: 'value *= 1', source: 'value *= 1\n'},
      {id: 'augmented-assignment-div', label: 'value /= 1', source: 'value /= 1\n'},
      {id: 'augmented-assignment-floordiv', label: 'value //= 1', source: 'value //= 1\n'},
      {id: 'augmented-assignment-mod', label: 'value %= 1', source: 'value %= 1\n'},
      {id: 'augmented-assignment-pow', label: 'value **= 1', source: 'value **= 1\n'},
      {id: 'print', label: 'print()', source: 'print()\n'}
    ]
  },
  {
    name: 'Operators', blocks: [
      {id: 'add', label: 'value + value', source: 'value + value', kind: 'expression'},
      {id: 'sub', label: 'value - value', source: 'value - value', kind: 'expression'},
      {id: 'mul', label: 'value * value', source: 'value * value', kind: 'expression'},
      {id: 'div', label: 'value / value', source: 'value / value', kind: 'expression'},
      {id: 'floordiv', label: 'value // value', source: 'value // value', kind: 'expression'},
      {id: 'mod', label: 'value % value', source: 'value % value', kind: 'expression'},
      {id: 'pow', label: 'value ** value', source: 'value ** value', kind: 'expression'},
      {id: 'eq', label: 'value == value', source: 'value == value', kind: 'expression'},
      {id: 'ne', label: 'value != value', source: 'value != value', kind: 'expression'},
      {id: 'lt', label: 'value < value', source: 'value < value', kind: 'expression'},
      {id: 'gt', label: 'value > value', source: 'value > value', kind: 'expression'},
      {id: 'and', label: 'value and value', source: 'value and value', kind: 'expression'},
      {id: 'or', label: 'value or value', source: 'value or value', kind: 'expression'},
      {id: 'not', label: 'not value', source: 'not value', kind: 'expression'}
    ]
  },
  {
    name: 'Conditionals', blocks: [
      {id: 'if', label: 'if True:', source: 'if True:\n  pass\n'}
    ]
  },
  {
    name: 'Loops', blocks: [
      {id: 'for', label: 'for item in range(3):', source: 'for item in range(3):\n  pass\n'},
      {id: 'while', label: 'while True:', source: 'while True:\n  pass\n'},
      {id: 'break', label: 'break', source: 'break\n'},
      {id: 'continue', label: 'continue', source: 'continue\n'}
    ]
  },
  {
    name: 'Functions & classes', blocks: [
      {id: 'def', label: 'def name():', source: 'def name():\n  pass\n'},
      {id: 'return', label: 'return value', source: 'return value\n'},
      {id: 'class', label: 'class Name:', source: 'class Name:\n  pass\n'},
      {id: 'call', label: 'name()', source: 'name()', kind: 'expression'}
    ]
  },
  {
    name: 'Modules', blocks: [
      {id: 'import', label: 'import module', source: 'import module\n'},
      {id: 'from-import', label: 'from module import name', source: 'from module import name\n'}
    ]
  },
  {
    name: 'Notes', blocks: [
      {id: 'comment', label: '# comment', source: '# comment\n'},
      {id: 'pass', label: 'pass', source: 'pass\n'}
    ]
  }
];

const sampleSelect = document.querySelector('#modern-python-sample');
const modeButton = document.querySelector('#modern-python-mode');
const moveButton = document.querySelector('#modern-python-move');
const suiteButton = document.querySelector('#modern-python-suite');
const status = document.querySelector('#modern-python-status');
const sourcePanel = document.querySelector('#modern-python-source');
const projectionPanel = document.querySelector('#modern-python-projection');
const palettePanel = document.querySelector('#modern-python-palette');

for (const name of Object.keys(samples)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  sampleSelect.append(option);
}

window.brython();
const pythonToAST = window.__BRYTHON__.pythonToAST;
let editor;
editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#modern-python-editor'),
  value: samples[sampleSelect.value],
  blockMode: true,
  parse: createBrythonPythonParser(pythonToAST, window.__BRYTHON__.tokenizer),
  transform: createBrythonPythonTransformer(pythonToAST),
  onUpdate: refresh,
  // A drag/drop, Delete, or add/remove-clause action dispatched through the
  // rendered surface has no synchronous caller of its own to catch a
  // rejection the way applyPaletteOperation's click-to-insert path does -
  // dropping "break"/"continue"/"return" outside a valid context, in
  // particular, would otherwise throw straight out of a DOM event handler as
  // an uncaught exception, with no feedback ever reaching the user.
  onOperationError: (error) => setStatus(`Couldn't place that block here: ${error.message}`)
});

renderPalette();

sampleSelect.addEventListener('change', () => {
  editor.setValue(samples[sampleSelect.value]);
  // setValue() synchronously runs refresh() first, which already reports an
  // opaque-recovery issue (see the "Opaque recovery" sample) - overwriting
  // that unconditionally here immediately hid it behind this generic
  // "Loaded..." message.
  if (!editor.getProjection().issues.length) setStatus(`Loaded “${sampleSelect.value}”.`);
});

modeButton.addEventListener('click', () => {
  editor.setBlockMode(!editor.isUsingBlocks());
  modeButton.textContent = editor.isUsingBlocks() ? 'Use text mode' : 'Use block mode';
  setStatus(editor.isUsingBlocks()
    ? 'Block mode active. Drag a blue statement block onto another blue statement block to move it.'
    : 'Text mode active.');
  refresh();
});

moveButton.addEventListener('click', () => {
  const source = editor.getValue();
  const nodes = collectNodes(editor.getProjection().root);
  const nestedSuite = nodes.find((node) => node.kind === 'statement' && node.metadata?.type === 'If' &&
    source.slice(node.from, node.to).startsWith('if ready:'));
  const tail = nodes.find((node) => source.slice(node.from, node.to) === 'tail = 0');
  if (!nestedSuite || !tail) return setStatus('Choose “Comments and nested suite” to run this operation.');
  editor.applyBlockOperation({
    type: 'move-statement', source: {from: nestedSuite.from, to: nestedSuite.to},
    destination: {from: tail.from, to: tail.from}
  });
  setStatus('Moved the nested suite to module scope without rewriting the surrounding source.');
});

suiteButton.addEventListener('click', () => {
  const source = editor.getValue();
  const target = collectNodes(editor.getProjection().root).find((node) => source.slice(node.from, node.to) === 'tail = 0');
  if (!target) return setStatus('Choose “Comments and nested suite” to insert before tail = 0.');
  editor.applyBlockOperation({
    type: 'insert-statement',
    destination: {from: target.from, to: target.from},
    source: `if created:\n${createEmptyPythonSuite('  ')}`
  });
  setStatus('Inserted a valid empty suite using pass.');
});

function renderPalette() {
  palette.forEach((category, index) => {
    // The palette has grown past a dozen categories of blocks; only the
    // first opens by default so the panel starts at a manageable height.
    const section = document.createElement('details');
    section.className = 'palette-category';
    section.open = index === 0;
    const heading = document.createElement('summary');
    heading.textContent = category.name;
    const blocks = document.createElement('div');
    blocks.className = 'palette-blocks';
    for (const block of category.blocks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-block';
      button.dataset.paletteBlock = block.id;
      button.draggable = true;
      button.textContent = block.label;
      button.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData(paletteMimeType(block), block.source);
        event.dataTransfer.effectAllowed = 'move';
      });
      button.addEventListener('click', () => insertPaletteBlock(block));
      blocks.append(button);
    }
    section.append(heading, blocks);
    palettePanel.append(section);
  });
}

function paletteMimeType(block) {
  return block.kind === 'expression' ? 'application/x-droplet-expression' : 'application/x-droplet-statement';
}

function insertPaletteBlock(block) {
  const {anchor, head} = editor.editor.getSelection();
  const range = anchor === head ? undefined : {from: Math.min(anchor, head), to: Math.max(anchor, head)};
  const nodes = range ? collectNodes(editor.getProjection().root) : [];
  if (block.kind === 'expression') {
    const socket = range && nodes.find((node) =>
      (node.kind === 'socket' || node.kind === 'recovery-socket') && node.from === range.from && node.to === range.to);
    if (socket) {
      if (!applyPaletteOperation({type: 'replace-socket', target: {from: socket.from, to: socket.to}, source: block.source})) return;
      setStatus(`Replaced the selected socket with ${block.label}.`);
      return;
    }
  }
  const selected = range && nodes.find((node) => node.kind === 'statement' && node.from === range.from && node.to === range.to);
  const at = selected?.from ?? editor.getValue().length;
  const source = block.kind === 'expression' ? `${block.source}\n` : block.source;
  // Nothing here resolves an enclosing loop/function for "break"/"continue"/
  // "return" - Brython's own reparse still validates the result and throws
  // for one dropped outside a valid context (or any other rejected drop),
  // which would otherwise surface only as an uncaught console exception.
  if (!applyPaletteOperation({type: 'insert-statement', destination: {from: at, to: at}, source})) return;
  setStatus(`Inserted ${block.label}.`);
}

function applyPaletteOperation(operation) {
  try {
    editor.applyBlockOperation(operation);
    return true;
  } catch (error) {
    setStatus(`Couldn't place that block here: ${error.message}`);
    return false;
  }
}

function refresh() {
  if (!editor) return;
  const projection = editor.getProjection();
  sourcePanel.textContent = editor.getValue();
  projectionPanel.textContent = JSON.stringify(projection.root, null, 2);
  if (projection.issues.length) setStatus(`Opaque recovery: ${projection.issues[0].message}`);
}

function collectNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectNodes)];
}

function setStatus(message) { status.value = message; status.textContent = message; }

modeButton.textContent = 'Use text mode';
refresh();
setStatus('Ready. Block mode is active; follow the translucent placement preview to rearrange statements between blocks.');
