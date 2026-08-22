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

const sampleSelect = document.querySelector('#modern-python-sample');
const modeButton = document.querySelector('#modern-python-mode');
const moveButton = document.querySelector('#modern-python-move');
const suiteButton = document.querySelector('#modern-python-suite');
const status = document.querySelector('#modern-python-status');
const sourcePanel = document.querySelector('#modern-python-source');
const projectionPanel = document.querySelector('#modern-python-projection');

for (const name of Object.keys(samples)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  sampleSelect.append(option);
}

window.brython();
const pythonToAST = window.__BRYTHON__.pythonToAST;
const editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#modern-python-editor'),
  value: samples[sampleSelect.value],
  blockMode: true,
  parse: createBrythonPythonParser(pythonToAST),
  transform: createBrythonPythonTransformer(pythonToAST),
  onUpdate: refresh
});

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

function refresh() {
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
setStatus('Ready. Block mode is active; drag a blue statement block onto another to move it.');
