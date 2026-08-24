import {createDropletCodeMirrorEditor} from '@droplet/codemirror-editor/droplet';
import {parseJavaScript, transformJavaScript} from '@droplet/javascript-adapter';

const samples = {
  'Score tracker': 'var score = 0;\nif (score > 0) {\n  console.log(score);\n}\nscore = score + 1;\n',
  'Loop and total': 'var total = 0;\nfor (var i = 0; i < 4; i++) {\n  total = total + i;\n}\nconsole.log(total);\n',
  'Broken syntax': 'if (score >\n'
};

// App Lab (code.org's browser-based JavaScript environment, itself a
// customized skin over Droplet - see example.coffee's "categories"/"color"
// config) uses a simpler, differently-colored toolbox than the standalone
// library's own generic defaults: four categories cover everything a plain
// (non-App-Lab-API) JavaScript program needs -
//
//   control   (blue):   if/if-else, while, for
//   math      (orange): all arithmetic AND comparison/boolean operators in
//                        one category (App Lab does not split these the way
//                        the standalone library's defaults do), plus Math.*
//   variables (purple):  declaration, assignment, compound assignment
//   functions (green):   declare, return - AND call, which App Lab groups
//                        with the function it invokes rather than with
//                        assignment
//
// App Lab also has UI controls/Canvas/Data/Turtle categories, all of them
// App Lab's own runtime API (drawing, widgets, lists, turtle graphics) with
// no equivalent in plain JavaScript - out of scope for a generic playground,
// so this reproduces only the four categories above. Its Control category
// also includes getTime/setTimeout/clearTimeout/timedLoop/stopTimedLoop -
// App Lab's own timing runtime, likewise excluded here, and break/continue
// do not appear in its toolbox at all, so they are left out too.
//
// A block's own value/argument sockets are filled with a "value" placeholder
// (not left empty like App Lab's own blocks) only where JavaScript's grammar
// requires *some* expression there (an operator's operands, a while/if
// condition) - a socket that is genuinely optional in valid JavaScript (a
// call's arguments, a function's parameters, a bare `return;`) uses a real
// empty, directly-editable socket instead, matching App Lab exactly (see
// emptyCallArgumentSocket/emptyParameterSocket/emptyReturnValueSocket in
// packages/javascript-adapter).
const palette = [
  {
    name: 'Control', category: 'control', blocks: [
      {id: 'if', label: 'if (true) { }', source: 'if (true) {\n}\n'},
      {id: 'if-else', label: 'if (true) { } else { }', source: 'if (true) {\n} else {\n}\n'},
      {id: 'while', label: 'while (true) { }', source: 'while (true) {\n}\n'},
      {id: 'for', label: 'for (var i = 0; i < 4; i++) { }', source: 'for (var i = 0; i < 4; i++) {\n}\n'}
    ]
  },
  {
    name: 'Math', category: 'math', blocks: [
      {id: 'add', label: 'value + value', source: 'value + value', kind: 'expression'},
      {id: 'sub', label: 'value - value', source: 'value - value', kind: 'expression'},
      {id: 'mul', label: 'value * value', source: 'value * value', kind: 'expression'},
      {id: 'div', label: 'value / value', source: 'value / value', kind: 'expression'},
      {id: 'mod', label: 'value % value', source: 'value % value', kind: 'expression'},
      {id: 'eq', label: 'value == value', source: 'value == value', kind: 'expression'},
      {id: 'ne', label: 'value != value', source: 'value != value', kind: 'expression'},
      {id: 'gt', label: 'value > value', source: 'value > value', kind: 'expression'},
      {id: 'ge', label: 'value >= value', source: 'value >= value', kind: 'expression'},
      {id: 'lt', label: 'value < value', source: 'value < value', kind: 'expression'},
      {id: 'le', label: 'value <= value', source: 'value <= value', kind: 'expression'},
      {id: 'and', label: 'value && value', source: 'value && value', kind: 'expression'},
      {id: 'or', label: 'value || value', source: 'value || value', kind: 'expression'},
      {id: 'not', label: '!value', source: '!value', kind: 'expression'},
      // App Lab's own Math category has a "randomNumber(min, max)" block -
      // App Lab's own convenience wrapper, not a real JavaScript global, so
      // it would throw ReferenceError outside App Lab and directly
      // contradicts the "plain (non-App-Lab-API)" scope above. Reproduced
      // here as the equivalent standard-JS expression instead.
      {id: 'random-number', label: 'Math.floor(Math.random() * 10) + 1', source: 'Math.floor(Math.random() * 10) + 1', kind: 'expression'},
      {id: 'round', label: 'Math.round()', source: 'Math.round()', kind: 'expression'},
      {id: 'abs', label: 'Math.abs()', source: 'Math.abs()', kind: 'expression'},
      {id: 'max', label: 'Math.max()', source: 'Math.max()', kind: 'expression'},
      {id: 'min', label: 'Math.min()', source: 'Math.min()', kind: 'expression'},
      {id: 'random', label: 'Math.random()', source: 'Math.random()', kind: 'expression'},
      {id: 'pow', label: 'Math.pow(value, value)', source: 'Math.pow(value, value)', kind: 'expression'},
      {id: 'sqrt', label: 'Math.sqrt()', source: 'Math.sqrt()', kind: 'expression'}
    ]
  },
  {
    // App Lab's own Variables category runs well past declaration/assignment
    // into string/array/object methods - all reproduced here where they are
    // genuinely plain JavaScript (String/Array.prototype methods, object and
    // array literals, console.log/clear, the real browser prompt()). Left
    // out: promptNum, removeItem/appendItem, getValue/addPair - App Lab's own
    // helper functions with no equivalent in plain JavaScript (real code
    // uses parseFloat(prompt(...)), list.splice(...)/list.push(...), and
    // object[key]/object[key] = value directly instead).
    name: 'Variables', category: 'variables', blocks: [
      {id: 'var', label: 'var value = 1;', source: 'var value = 1;\n'},
      {id: 'var-empty', label: 'var value;', source: 'var value;\n'},
      {id: 'assign', label: 'value = 1;', source: 'value = 1;\n'},
      {id: 'add-assign', label: 'value += 1;', source: 'value += 1;\n'},
      {id: 'sub-assign', label: 'value -= 1;', source: 'value -= 1;\n'},
      {id: 'var-prompt', label: 'var value = prompt("Enter a value");', source: 'var value = prompt("Enter a value");\n'},
      {id: 'log', label: 'console.log("message");', source: 'console.log("message");\n'},
      {id: 'clear', label: 'console.clear();', source: 'console.clear();\n'},
      {id: 'var-string', label: 'var str = "Hello World";', source: 'var str = "Hello World";\n'},
      {id: 'substring', label: 'value.substring("start", "end")', source: 'value.substring("start", "end")', kind: 'expression'},
      {id: 'index-of', label: 'value.indexOf("searchValue")', source: 'value.indexOf("searchValue")', kind: 'expression'},
      {id: 'includes', label: 'value.includes("searchValue")', source: 'value.includes("searchValue")', kind: 'expression'},
      {id: 'string-length', label: 'value.length', source: 'value.length', kind: 'expression'},
      {id: 'to-upper', label: 'value.toUpperCase()', source: 'value.toUpperCase()', kind: 'expression'},
      {id: 'to-lower', label: 'value.toLowerCase()', source: 'value.toLowerCase()', kind: 'expression'},
      {id: 'var-list', label: 'var list = [1, 2, 3];', source: 'var list = [1, 2, 3];\n'},
      {id: 'var-list-strings', label: 'var list = ["a", "b", "c"];', source: 'var list = ["a", "b", "c"];\n'},
      {id: 'list-item', label: 'list[0]', source: 'list[0]', kind: 'expression'},
      {id: 'list-length', label: 'list.length', source: 'list.length', kind: 'expression'},
      {id: 'join', label: 'list.join("separator")', source: 'list.join("separator")', kind: 'expression'},
      {id: 'var-object', label: 'var object = {"key": "value"};', source: 'var object = {"key": "value"};\n'}
    ]
  },
  {
    name: 'Functions', category: 'functions', blocks: [
      // Just the zero-parameter/zero-argument forms: the "+" button (see
      // renderParameterAddButton/renderCallArgumentAddButton in
      // block-surface-dom.js) now adds parameters/arguments from there, so a
      // separate pre-filled "(n)" palette variant is redundant.
      {id: 'def', label: 'function myFunction() { }', source: 'function myFunction() {\n}\n'},
      {id: 'call', label: 'myFunction()', source: 'myFunction()', kind: 'expression'},
      {id: 'return', label: 'return ;', source: 'return;\n'}
      // App Lab also has a comment block ("// Comment"); the JavaScript
      // adapter does not project comments as their own node kind (see its
      // module doc), so there is nothing here for a comment block to attach
      // to yet.
    ]
  }
];

// Mirrors modern-javascript.html's --cat-fill/--cat-stroke pairs: a lighter
// tint of each category's hue for the fill black text sits on, its more
// saturated tone (App Lab's own header/block color) for the border/shadow.
const CATEGORY_COLORS = {
  control: {fill: '#8fbce8', stroke: '#4d90d6'},
  math: {fill: '#f5c785', stroke: '#efa83d'},
  variables: {fill: '#c3a8dd', stroke: '#9c6fc4'},
  functions: {fill: '#a3d3a3', stroke: '#63b563'}
};

// Colors arbitrary rendered code (not just palette-inserted blocks) the same
// way App Lab colors its own toolbox: control-flow statements blue, all
// arithmetic/comparison/boolean operators and Math.* orange, variable
// declaration/assignment purple, and function declarations/calls/returns
// green - a CallExpression is grouped with Functions here, matching App
// Lab's palette (see the comment above), not the generic "assignment or
// call is the same category" convention the standalone library defaults to.
function dropletCategory(node, source) {
  switch (node.metadata?.type) {
    case 'IfStatement':
    case 'SwitchStatement':
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return 'control';
    case 'VariableDeclaration':
    case 'AssignmentExpression':
    case 'MemberExpression':
      return 'variables';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ReturnStatement':
      return 'functions';
    // A call/new's own category depends on what it calls, not just that it
    // is one: App Lab colors a call to a method on something (console.log,
    // str.substring, ...) as Variables, alongside the value it operates on,
    // but a call to a plain named function (myFunction()) as Functions.
    case 'CallExpression':
    case 'NewExpression':
      return calleeCategory(node, source);
    case 'BinaryExpression':
    case 'LogicalExpression':
    case 'UnaryExpression':
    case 'UpdateExpression':
    case 'ConditionalExpression':
      return 'math';
    case 'ExpressionStatement': {
      const inner = (node.children ?? []).find((child) => child.kind === 'expression' || child.kind === 'statement');
      return inner ? dropletCategory(inner, source) : 'variables';
    }
    default:
      return 'variables';
  }
}

function calleeCategory(node, source) {
  const callee = (node.children ?? []).find((child) => child.metadata?.socketRole === 'call-target');
  if (callee?.metadata?.type !== 'MemberExpression') return 'functions';
  // The palette's own Math.* blocks (Math.round(), Math.random(), ...) are
  // math (orange), per this module's own documented category scheme above -
  // every other member call (console.log, str.substring, ...) is grouped
  // with the value it operates on instead.
  return /^Math\./.test(source.slice(callee.from, callee.to)) ? 'math' : 'variables';
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
  onUpdate: refresh,
  // A drag/drop, Delete, or add/remove-clause action dispatched through the
  // rendered surface has no synchronous caller of its own to catch a
  // rejection the way applyPaletteOperation's click-to-insert path does -
  // it would otherwise throw straight out of a DOM event handler as an
  // uncaught exception, with no feedback ever reaching the user.
  onOperationError: (error) => setStatus(`Couldn't place that block here: ${error.message}`)
});

renderPalette();

sampleSelect.addEventListener('change', () => {
  editor.setValue(samples[sampleSelect.value]);
  // setValue() synchronously runs refresh() first, which already reports an
  // opaque-recovery issue (see the "Broken syntax" sample) - overwriting
  // that unconditionally here immediately hid it behind this generic
  // "Loaded..." message.
  if (!editor.getProjection().issues.length) setStatus(`Loaded “${sampleSelect.value}”.`);
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
      if (!applyPaletteOperation({type: 'replace-socket', target: {from: socket.from, to: socket.to}, source: block.source})) return;
      setStatus(`Replaced the selected socket with ${block.label}.`);
      return;
    }
  }
  const selected = range && nodes.find((node) => node.kind === 'statement' && node.from === range.from && node.to === range.to);
  const at = selected?.from ?? editor.getValue().length;
  const source = block.kind === 'expression' ? `${block.source}\n` : block.source;
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
  if (editor.isUsingBlocks()) applyDropletCategories();
  if (projection.issues.length) setStatus(`Opaque recovery: ${projection.issues[0].message}`);
}

function collectNodes(node) {
  return [node, ...(node.children ?? []).flatMap(collectNodes)];
}

function setStatus(message) { status.value = message; status.textContent = message; }

modeButton.textContent = 'Use text mode';
refresh();
setStatus('Ready. Block mode is active; blocks use App Lab’s category colors and the legacy Droplet editor’s notch shape.');
