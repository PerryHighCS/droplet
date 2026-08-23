import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';
import {parseJavaScript, transformJavaScript} from '@droplet/javascript-adapter';

const samples = {
  'Score tracker': 'var score = 0;\nif (score > 0) {\n  console.log(score);\n}\nscore = score + 1;\n',
  'Loop and total': 'var total = 0;\nfor (var i = 0; i < 4; i++) {\n  total = total + i;\n}\nconsole.log(total);\n',
  'Broken syntax': 'if (score >\n'
};

// The legacy CoffeeScript/Ace editor's JavaScript mode (src/languages/javascript.coffee)
// assigns each AST node type to one of a small set of named categories, each
// with its own color (src/view.coffee DEFAULT_OPTIONS.colors). Both the
// palette groups below and the runtime classifier further down (which colors
// arbitrary rendered code, not just palette-inserted blocks) reproduce that
// mapping so this playground's blocks are colored the way the original
// Code.org-derived Droplet editor colors them, not an invented scheme.
//
//   command   (blue,   #90caf9): variable declarations, assignment, calls
//   functions (purple, #ce93d8): function declarations
//   returns   (yellow, #fff59d): return/break/continue
//   control   (orange, #ffcc80): if/for/while
//   arithmetic(green,  #a5d6a7): + - * / % ** and other non-comparison ops
//   logic     (cyan,   #80deea): === !== < > && || (comparison/boolean ops)
//   containers(teal,   #80cbc4): member/array/object/new expressions
const palette = [
  {
    name: 'Variables & calls', category: 'command', blocks: [
      {id: 'var', label: 'var value = 1;', source: 'var value = 1;\n'},
      {id: 'const', label: 'const value = 1;', source: 'const value = 1;\n'},
      {id: 'assign', label: 'value = 1;', source: 'value = 1;\n'},
      {id: 'add-assign', label: 'value += 1;', source: 'value += 1;\n'},
      {id: 'sub-assign', label: 'value -= 1;', source: 'value -= 1;\n'},
      {id: 'log', label: 'console.log(value);', source: 'console.log(value);\n'},
      {id: 'alert', label: 'alert(value);', source: 'alert(value);\n'}
    ]
  },
  {
    name: 'Math', category: 'arithmetic', blocks: [
      {id: 'add', label: 'value + value', source: 'value + value', kind: 'expression'},
      {id: 'sub', label: 'value - value', source: 'value - value', kind: 'expression'},
      {id: 'mul', label: 'value * value', source: 'value * value', kind: 'expression'},
      {id: 'div', label: 'value / value', source: 'value / value', kind: 'expression'},
      {id: 'mod', label: 'value % value', source: 'value % value', kind: 'expression'},
      {id: 'pow', label: 'value ** value', source: 'value ** value', kind: 'expression'}
    ]
  },
  {
    name: 'Logic', category: 'logic', blocks: [
      {id: 'eq', label: 'value === value', source: 'value === value', kind: 'expression'},
      {id: 'ne', label: 'value !== value', source: 'value !== value', kind: 'expression'},
      {id: 'lt', label: 'value < value', source: 'value < value', kind: 'expression'},
      {id: 'gt', label: 'value > value', source: 'value > value', kind: 'expression'},
      {id: 'and', label: 'value && value', source: 'value && value', kind: 'expression'},
      {id: 'or', label: 'value || value', source: 'value || value', kind: 'expression'}
    ]
  },
  {
    name: 'Control', category: 'control', blocks: [
      {id: 'if', label: 'if (true) { }', source: 'if (true) {\n}\n'},
      {id: 'while', label: 'while (true) { }', source: 'while (true) {\n}\n'},
      {id: 'for', label: 'for (var i = 0; i < 4; i++) { }', source: 'for (var i = 0; i < 4; i++) {\n}\n'}
    ]
  },
  {
    name: 'Returns', category: 'returns', blocks: [
      {id: 'return', label: 'return value;', source: 'return value;\n'},
      {id: 'break', label: 'break;', source: 'break;\n'},
      {id: 'continue', label: 'continue;', source: 'continue;\n'}
    ]
  },
  {
    name: 'Functions', category: 'functions', blocks: [
      {id: 'def', label: 'function name() { }', source: 'function name() {\n}\n'},
      // A call is grouped here for discoverability next to the definition it
      // pairs with, but it still colors as 'command' (blue) - a CallExpression
      // is 'command' in the legacy mapping, not 'functions' (purple, reserved
      // for FunctionDeclaration/FunctionExpression) - so its button carries an
      // explicit category override rather than inheriting this section's.
      {id: 'call', label: 'name()', source: 'name()', kind: 'expression', category: 'command'}
    ]
  }
];

// Mirrors the CSS custom properties set per .cat-X in modern-javascript.html,
// for the rare palette block (see 'call' above) whose own color needs to
// differ from its toolbox section's.
const CATEGORY_COLORS = {
  command: {fill: '#90caf9', stroke: '#4a90d2'},
  arithmetic: {fill: '#a5d6a7', stroke: '#5b9e60'},
  logic: {fill: '#80deea', stroke: '#2fa8c2'},
  control: {fill: '#ffcc80', stroke: '#e0932e'},
  returns: {fill: '#fff59d', stroke: '#d1c04a'},
  functions: {fill: '#ce93d8', stroke: '#9c4fb0'},
  containers: {fill: '#80cbc4', stroke: '#3f9187'}
};

// Reproduces src/languages/javascript.coffee's NODE_CATEGORIES/getColor: an
// ExpressionStatement (an assignment or a bare call) takes its color from its
// one expression child, and a BinaryExpression is "arithmetic" unless its
// operator is a comparison, in which case it is "logic" - matching
// LOGICAL_OPERATORS there. The one deliberate deviation is ContinueStatement:
// upstream leaves it out of NODE_CATEGORIES entirely (falling through to
// "command"/blue), which reads as an oversight rather than an intentional
// choice, so this groups it with break/return ("returns"/yellow) instead.
const COMPARISON_OPERATOR = /===|!==|==|!=|<=|>=|<|>|&&|\|\||\binstanceof\b|\bin\b/;

function dropletCategory(node, source) {
  switch (node.metadata?.type) {
    case 'VariableDeclaration':
    case 'AssignmentExpression':
    case 'CallExpression':
    case 'SequenceExpression':
      return 'command';
    case 'NewExpression':
    case 'ObjectExpression':
    case 'ArrayExpression':
    case 'MemberExpression':
      return 'containers';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return 'functions';
    case 'ReturnStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'ThrowStatement':
    case 'TryStatement':
      return 'returns';
    case 'IfStatement':
    case 'SwitchStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      return 'control';
    case 'LogicalExpression':
      return 'logic';
    case 'BinaryExpression':
      return COMPARISON_OPERATOR.test(source.slice(node.from, node.to)) ? 'logic' : 'arithmetic';
    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'ConditionalExpression':
      return 'arithmetic';
    case 'ExpressionStatement': {
      const inner = (node.children ?? []).find((child) => child.kind === 'expression' || child.kind === 'statement');
      return inner ? dropletCategory(inner, source) : 'command';
    }
    default:
      return 'command';
  }
}

// The block surface's own tab/notch connector shape (packages/codemirror-editor's
// renderAtomicFrame/renderContainerFrame, gated behind layoutOptions.tabConnector
// below) reproduces the legacy renderer's notch-on-top/tab-on-bottom silhouette
// and closes a container's left edge properly; this pass only adds the color,
// walking the raw parsed projection (which, unlike the rendered layout, still
// has every nested AST node) to tag each rendered statement/container frame
// with the category its source maps to.
function applyDropletCategories() {
  const svg = document.querySelector('#modern-javascript-editor svg');
  if (!svg) return;
  const source = editor.getValue();
  (function walk(node) {
    if (node.kind === 'statement' || node.kind === 'container') {
      const domKind = node.metadata?.blockRole === 'container' ? 'container' : 'statement';
      const element = svg.querySelector(
        `[data-droplet-kind="${domKind}"][data-droplet-from="${node.from}"][data-droplet-to="${node.to}"]`);
      element?.setAttribute('data-droplet-category', dropletCategory(node, source));
    }
    for (const child of node.children ?? []) walk(child);
  })(editor.getProjection().root);
}

const sampleSelect = document.querySelector('#modern-javascript-sample');
const modeButton = document.querySelector('#modern-javascript-mode');
const moveButton = document.querySelector('#modern-javascript-move');
const insertButton = document.querySelector('#modern-javascript-insert');
const status = document.querySelector('#modern-javascript-status');
const sourcePanel = document.querySelector('#modern-javascript-source');
const projectionPanel = document.querySelector('#modern-javascript-projection');
const palettePanel = document.querySelector('#modern-javascript-palette');

for (const name of Object.keys(samples)) {
  const option = document.createElement('option');
  option.value = name;
  option.textContent = name;
  sampleSelect.append(option);
}

let editor;
editor = createDropletCodeMirrorEditor({
  parent: document.querySelector('#modern-javascript-editor'),
  value: samples[sampleSelect.value],
  blockMode: true,
  parse: parseJavaScript,
  transform: transformJavaScript,
  layoutOptions: {tabConnector: true},
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
    ? 'Block mode active. Drag a colored statement block onto another to move it.'
    : 'Text mode active.');
  refresh();
});

moveButton.addEventListener('click', () => {
  const source = editor.getValue();
  const nodes = collectNodes(editor.getProjection().root);
  const nested = nodes.find((node) => node.kind === 'statement' && source.slice(node.from, node.to) === 'console.log(score);');
  const tail = nodes.find((node) => source.slice(node.from, node.to) === 'score = score + 1;');
  if (!nested || !tail) return setStatus('Choose “Score tracker” to run this operation.');
  editor.applyBlockOperation({
    type: 'move-statement', source: {from: nested.from, to: nested.to},
    destination: {from: source.length, to: source.length}
  });
  setStatus('Moved the console.log out of the if-block to the end of the script, without rewriting the surrounding source.');
});

insertButton.addEventListener('click', () => {
  const source = editor.getValue();
  const target = collectNodes(editor.getProjection().root).find((node) => source.slice(node.from, node.to) === 'score = score + 1;');
  if (!target) return setStatus('Choose “Score tracker” to insert before score = score + 1;.');
  editor.applyBlockOperation({
    type: 'insert-statement',
    destination: {from: target.from, to: target.from},
    source: 'if (ready) {\n}\n'
  });
  setStatus('Inserted an empty if-block.');
});

function renderPalette() {
  palette.forEach((category, index) => {
    const section = document.createElement('details');
    section.className = `palette-category cat-${category.category}`;
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
      if (block.category && block.category !== category.category) {
        const colors = CATEGORY_COLORS[block.category];
        button.style.setProperty('--cat-fill', colors.fill);
        button.style.setProperty('--cat-stroke', colors.stroke);
      }
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
      editor.applyBlockOperation({type: 'replace-socket', target: {from: socket.from, to: socket.to}, source: block.source});
      setStatus(`Replaced the selected socket with ${block.label}.`);
      return;
    }
  }
  const selected = range && nodes.find((node) => node.kind === 'statement' && node.from === range.from && node.to === range.to);
  const at = selected?.from ?? editor.getValue().length;
  const source = block.kind === 'expression' ? `${block.source}\n` : block.source;
  editor.applyBlockOperation({type: 'insert-statement', destination: {from: at, to: at}, source});
  setStatus(`Inserted ${block.label}.`);
}

function refresh() {
  if (!editor) return;
  const projection = editor.getProjection();
  sourcePanel.textContent = editor.getValue();
  projectionPanel.textContent = JSON.stringify(projection.root, null, 2);
  if (editor.isUsingBlocks()) applyDropletCategories();
  if (projection.issues.length) setStatus(`Opaque recovery: ${projection.issues[0].message}`);
}

function collectNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectNodes)];
}

function setStatus(message) { status.value = message; status.textContent = message; }

modeButton.textContent = 'Use text mode';
refresh();
setStatus('Ready. Block mode is active; blocks use the legacy Droplet editor’s notch shape and category colors.');
