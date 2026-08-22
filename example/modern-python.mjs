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

const palette = [{
  name: 'Python', blocks: [
    {id: 'print', label: 'print("hello")', source: 'print("hello")\n'},
    {id: 'assignment', label: 'value = 1', source: 'value = 1\n'},
    {id: 'if', label: 'if True:', source: 'if True:\n  pass\n'},
    {id: 'for', label: 'for item in range(3):', source: 'for item in range(3):\n  pass\n'}
  ]
}];

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
  onUpdate: refresh
});

renderPalette();

sampleSelect.addEventListener('change', () => {
  editor.setValue(samples[sampleSelect.value]);
  setStatus(`Loaded “${sampleSelect.value}”.`);
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
  for (const category of palette) {
    const section = document.createElement('section');
    section.className = 'palette-category';
    const heading = document.createElement('h3');
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
        event.dataTransfer.setData('application/x-droplet-statement', block.source);
        event.dataTransfer.effectAllowed = 'copy';
      });
      button.addEventListener('click', () => insertPaletteBlock(block));
      blocks.append(button);
    }
    section.append(heading, blocks);
    palettePanel.append(section);
  }
}

function insertPaletteBlock(block) {
  const {anchor, head} = editor.editor.getSelection();
  const selected = anchor === head ? undefined : collectNodes(editor.getProjection().root).find((node) =>
    node.kind === 'statement' && node.from === Math.min(anchor, head) && node.to === Math.max(anchor, head));
  const at = selected?.from ?? editor.getValue().length;
  editor.applyBlockOperation({
    type: 'insert-statement', destination: {from: at, to: at}, source: block.source
  });
  setStatus(`Inserted ${block.label}.`);
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
