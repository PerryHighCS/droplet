import assert from 'node:assert/strict';
import test from 'node:test';

import {createBlockLayout, createSubtreePreview, hitTestBlockLayout} from '../src/block-surface.js';

test('lays out a nested container with a header, independently addressable child, footer, and body-end zone', () => {
  const source = 'if ready:\n  first()\nsecond()\n';
  const layout = createBlockLayout(projection(source), {measureText: (text) => text.length * 10});
  const container = layout.nodes.find((node) => node.id === 'if');
  const first = layout.nodes.find((node) => node.id === 'first');

  assert.equal(container.kind, 'container');
  assert.deepEqual(container.source, {from: 0, to: 20});
  assert.ok(container.regions.header.bottom <= container.regions.body.top);
  assert.ok(container.regions.footer.top >= first.bounds.bottom);
  assert.ok(first.bounds.left > container.bounds.left);
  assert.deepEqual(container.insertionZones.at(-1).destination, {from: 20, to: 20});
});

test('keeps whitespace as a measured sibling and exposes insertion zones around it', () => {
  const source = 'first()\n \t\nsecond()\n';
  const layout = createBlockLayout({
    source,
    root: documentNode(source, [
      statement('first', 0, 7),
      {id: 'blank', kind: 'whitespace', from: 8, to: 11, editable: false, children: [], metadata: {text: ' \t'}},
      statement('second', 11, 19)
    ])
  });
  const blank = layout.nodes.find((node) => node.id === 'blank');

  assert.equal(blank.kind, 'whitespace');
  assert.equal(blank.text, ' \t');
  assert.ok(layout.insertionZones.some((zone) =>
    zone.destination.from === blank.source.from && zone.destination.indentation === ''));
  assert.ok(layout.insertionZones.some((zone) =>
    zone.destination.from === source.length && zone.destination.indentation === ''));
});

test('renders an inline comment beside, rather than inside, its statement block', () => {
  const source = 'first = 1  # note\n';
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('first', 0, 9),
    children: [{id: 'note', kind: 'comment', from: 11, to: 17, editable: true, children: [], metadata: {inline: true}}]
  }])});
  const statementNode = layout.nodes.find((node) => node.id === 'first');
  const commentNode = layout.nodes.find((node) => node.id === 'note');

  assert.equal(statementNode.text, 'first = 1');
  assert.equal(commentNode.kind, 'comment');
  assert.ok(commentNode.bounds.left > statementNode.bounds.right);
});

test('lays out source-backed assignment sockets inside their statement block', () => {
  const source = 'target = value\n';
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('assign', 0, 14),
    children: [
      {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, children: [], metadata: {socketRole: 'assignment-target'}},
      {id: 'value', kind: 'socket', from: 9, to: 14, editable: true, children: [], metadata: {socketRole: 'assignment-value'}}
    ]
  }])}, {measureText: (text) => text.length * 10});
  const target = layout.nodes.find((node) => node.id === 'target');
  const value = layout.nodes.find((node) => node.id === 'value');

  assert.equal(target.kind, 'socket');
  assert.equal(target.metadata.socketRole, 'assignment-target');
  assert.equal(value.metadata.socketRole, 'assignment-value');
  assert.ok(target.bounds.left < value.bounds.left);
  assert.equal(value.textLeft, target.bounds.right + 4 + 30);
  assert.equal(hitTestBlockLayout(layout, {x: value.bounds.left + 2, y: value.bounds.top + 2}).node.id, 'value');
});

test('keeps a socket rect clear of its source gap text when there is no surrounding whitespace', () => {
  const source = 'second=1\n';
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('assign', 0, 8),
    children: [
      {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, children: [], metadata: {socketRole: 'assignment-target'}},
      {id: 'value', kind: 'socket', from: 7, to: 8, editable: true, children: [], metadata: {socketRole: 'assignment-value'}}
    ]
  }])}, {measureText: (text) => text.length * 10});
  const target = layout.nodes.find((node) => node.id === 'target');
  const value = layout.nodes.find((node) => node.id === 'value');

  // The gap between the sockets is a single non-whitespace "=" (10px under
  // this test's measureText). Without a trailing space to pad into, the
  // value socket's rect must start no earlier than that gap text's own
  // measured width allows, or it would visually overlap the "=" glyph.
  assert.equal(value.bounds.left, target.bounds.right + 4 + 10);
});

test('lays out a compound socket\'s own inner sockets instead of one flat socket', () => {
  const source = 'target = value + value\n';
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('assign', 0, 22),
    children: [
      {id: 'target', kind: 'socket', from: 0, to: 6, editable: true, children: [], metadata: {socketRole: 'assignment-target'}},
      {id: 'binop', kind: 'socket', from: 9, to: 22, editable: true, metadata: {socketRole: 'assignment-value'}, children: [
        {id: 'left', kind: 'socket', from: 9, to: 14, editable: true, children: [], metadata: {socketRole: 'expression'}},
        {id: 'right', kind: 'socket', from: 17, to: 22, editable: true, children: [], metadata: {socketRole: 'expression'}}
      ]}
    ]
  }])}, {measureText: (text) => text.length * 10});
  const binop = layout.nodes.find((node) => node.id === 'binop');
  const left = layout.nodes.find((node) => node.id === 'left');
  const right = layout.nodes.find((node) => node.id === 'right');

  assert.deepEqual(binop.children.map((child) => child.id), ['left', 'right']);
  assert.ok(left.bounds.left >= binop.bounds.left);
  assert.ok(right.bounds.right <= binop.bounds.right);
  assert.ok(left.bounds.right < right.bounds.left);
  assert.equal(hitTestBlockLayout(layout, {x: left.bounds.left + 2, y: left.bounds.top + 2}).node.id, 'left');
  assert.equal(hitTestBlockLayout(layout, {x: right.bounds.left + 2, y: right.bounds.top + 2}).node.id, 'right');
});

test('lays out an if condition socket in the container header', () => {
  const source = 'if ready:\n  pass\n';
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, 16, {blockRole: 'container', headerTo: 9}),
    children: [
      {id: 'condition', kind: 'socket', from: 3, to: 8, editable: true, children: [], metadata: {socketRole: 'if-condition'}},
      statement('pass', 12, 16)
    ]
  }])}, {measureText: (text) => text.length * 10});
  const container = layout.nodes.find((node) => node.id === 'if');
  const condition = layout.nodes.find((node) => node.id === 'condition');

  assert.equal(condition.kind, 'socket');
  assert.ok(condition.bounds.top >= container.regions.header.top);
  assert.ok(condition.bounds.bottom <= container.regions.header.bottom);
  assert.ok(container.regions.header.right >= condition.bounds.right + 4 + 10);
  assert.equal(hitTestBlockLayout(layout, {x: condition.bounds.left + 2, y: condition.bounds.top + 2}).node.id, 'condition');
});

test('lays out an if/elif/else chain as stacked branch sections with one shared footer', () => {
  const source = 'if ready:\n  first()\nelif retry:\n  second()\nelse:\n  third()\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const elifFrom = at('elif retry:');
  const elseFrom = at('else:');
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {blockRole: 'container', headerTo: at(':') + 1, bodyEnd: elifFrom, bodyIndentation: '  '}),
    children: [
      statement('first', at('first()'), at('first()') + 'first()'.length),
      {
        id: 'elif', kind: 'clause', from: elifFrom, to: elseFrom, editable: true,
        metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:'.length, bodyEnd: elseFrom, bodyIndentation: '  '},
        children: [
          {id: 'elif-condition', kind: 'socket', from: at('retry'), to: at('retry') + 5, editable: true, children: [], metadata: {socketRole: 'if-condition'}},
          statement('second', at('second()'), at('second()') + 'second()'.length)
        ]
      },
      {
        id: 'else', kind: 'clause', from: elseFrom, to: source.length, editable: true,
        metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '},
        children: [statement('third', at('third()'), at('third()') + 'third()'.length)]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const container = layout.nodes.find((node) => node.id === 'if');
  const elif = layout.nodes.find((node) => node.id === 'elif');
  const elseClause = layout.nodes.find((node) => node.id === 'else');
  const first = layout.nodes.find((node) => node.id === 'first');
  const second = layout.nodes.find((node) => node.id === 'second');
  const third = layout.nodes.find((node) => node.id === 'third');

  assert.equal(elif.kind, 'clause');
  assert.equal(elseClause.kind, 'clause');
  // Each branch's own body sits below its own header, and each branch
  // starts below the previous branch's body - not overlapping it.
  assert.ok(elif.regions.header.top >= first.bounds.bottom);
  assert.ok(second.bounds.top >= elif.regions.header.bottom);
  assert.ok(elseClause.regions.header.top >= second.bounds.bottom);
  assert.ok(third.bounds.top >= elseClause.regions.header.bottom);
  // One shared footer sits past the last branch's body, not one per branch.
  assert.ok(container.regions.footer.top >= third.bounds.bottom);
  assert.equal(hitTestBlockLayout(layout, {x: elif.regions.header.left + 2, y: elif.regions.header.top + 2}).node.id, 'elif');
  assert.equal(hitTestBlockLayout(layout, {x: second.bounds.left + 2, y: second.bounds.top + 2}).node.id, 'second');
});

test('renders a blank line between an if body and its else instead of dropping it from every branch', () => {
  // A blank line (or standalone comment) between a branch's own body and a
  // following elif/else has no indentation of its own - Python attaches it
  // to the enclosing if statement (triviaParent finds no more specific
  // clause/statement to own it), and the primary body's own indentation
  // filter used to exclude it there too, since it can never match a real
  // statement's leading whitespace. It disappeared from every branch's
  // rendering instead of staying visibly ordered in the one it was
  // actually attached to.
  const source = 'if ready:\n  first()\n\nelse:\n  second()\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const elseFrom = at('else:');
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {blockRole: 'container', headerTo: at(':') + 1, bodyEnd: elseFrom, bodyIndentation: '  '}),
    children: [
      statement('first', at('first()'), at('first()') + 'first()'.length),
      {id: 'blank', kind: 'whitespace', from: at('first()') + 'first()'.length + 1, to: elseFrom - 1, editable: false, children: [], metadata: {text: '', lineEnding: '\n'}},
      {
        id: 'else', kind: 'clause', from: elseFrom, to: source.length, editable: true,
        metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '},
        children: [statement('second', at('second()'), at('second()') + 'second()'.length)]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const first = layout.nodes.find((node) => node.id === 'first');
  const blank = layout.nodes.find((node) => node.id === 'blank');
  const elseClause = layout.nodes.find((node) => node.id === 'else');
  assert.ok(blank, 'the blank line must still render, not disappear');
  assert.equal(blank.kind, 'whitespace');
  assert.ok(blank.bounds.top >= first.bounds.bottom);
  assert.ok(elseClause.regions.header.top >= blank.bounds.bottom);
});

test('flattens a JavaScript body block even when a branch-boundary blank line sits alongside it', () => {
  // Acorn represents a braced body as its own BlockStatement child, normally
  // flattened away as structural syntax rather than a second user-visible
  // box. A blank line or standalone comment between that block's closing
  // brace and a following "else" (see ifClauses in the JavaScript adapter)
  // rides alongside the BlockStatement as another direct child of the same
  // IfStatement - requiring the BlockStatement to be the *only* child before
  // flattening used to leave it unflattened whenever such trivia existed,
  // rendering it as a spurious nested container inside the primary one.
  const source = 'if (x) {\n  a();\n}\n\nelse {\n  b();\n}\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {type: 'IfStatement', blockRole: 'container', headerTo: at('{') + 1, bodyEnd: at('}')}),
    children: [
      {
        ...statement('block', at('{'), at('}') + 1, {type: 'BlockStatement'}),
        children: [statement('a', at('a();'), at('a();') + 'a();'.length)]
      },
      {id: 'blank', kind: 'whitespace', from: at('}') + 1, to: at('}') + 2, editable: false, children: [], metadata: {text: '', lineEnding: '\n'}},
      {
        id: 'else', kind: 'clause', from: at('else'), to: at('}', at('b();')) + 1, editable: true,
        metadata: {type: 'BlockStatement', clauseRole: 'else', headerTo: at('{', at('else')) + 1, bodyEnd: at('}', at('b();'))},
        children: [statement('b', at('b();'), at('b();') + 'b();'.length)]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const containers = layout.nodes.filter((node) => node.kind === 'container');
  assert.deepEqual(containers.map((node) => node.id), ['if'], 'the body block must not render as its own second container');
  const a = layout.nodes.find((node) => node.id === 'a');
  const elseClause = layout.nodes.find((node) => node.id === 'else');
  assert.ok(a);
  assert.ok(elseClause.regions.header.top >= a.bounds.bottom);
});

test('falls back to a valid clause header end when metadata.headerTo is missing or malformed', () => {
  // metadata.headerTo is trusted adapter output - assertProjection does not
  // validate it. Slicing straight to an absent/malformed value (source.slice
  // treats undefined as "to the end") would consume the rest of the document
  // as the clause's own "header" instead of falling back the same way a
  // primary container's own header already does (validHeaderTo).
  const source = 'if ready:\n  first()\nelif retry:\n  second()\nelse:\n  third()\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const elifFrom = at('elif retry:');
  const elseFrom = at('else:');
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {blockRole: 'container', headerTo: at(':') + 1, bodyEnd: elifFrom, bodyIndentation: '  '}),
    children: [
      statement('first', at('first()'), at('first()') + 'first()'.length),
      {
        id: 'elif', kind: 'clause', from: elifFrom, to: elseFrom, editable: true,
        // headerTo deliberately omitted.
        metadata: {clauseRole: 'elif', bodyEnd: elseFrom, bodyIndentation: '  '},
        children: [
          {id: 'elif-condition', kind: 'socket', from: at('retry'), to: at('retry') + 5, editable: true, children: [], metadata: {socketRole: 'if-condition'}},
          statement('second', at('second()'), at('second()') + 'second()'.length)
        ]
      },
      {
        id: 'else', kind: 'clause', from: elseFrom, to: source.length, editable: true,
        metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '},
        children: [statement('third', at('third()'), at('third()') + 'third()'.length)]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const elif = layout.nodes.find((node) => node.id === 'elif');
  const second = layout.nodes.find((node) => node.id === 'second');
  const third = layout.nodes.find((node) => node.id === 'third');

  assert.equal(elif.text, 'elif retry:');
  assert.ok(second.bounds.top >= elif.regions.header.bottom);
  assert.ok(third.bounds.top >= second.bounds.bottom);
});

test('widens the last clause\'s own body-end zone to the shared footer, not the primary body\'s', () => {
  // The shared footer visually sits right after the *last branch*, not the
  // primary body - widening the primary body's own body-end zone to the
  // footer's bounds (as if there were no clauses) let a drop anywhere on the
  // visible footer insert before the first clause instead of at the end of
  // the final elif/else body.
  const source = 'if ready:\n  first()\nelif retry:\n  second()\nelse:\n  third()\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const elifFrom = at('elif retry:');
  const elseFrom = at('else:');
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {blockRole: 'container', headerTo: at(':') + 1, bodyEnd: elifFrom, bodyIndentation: '  '}),
    children: [
      statement('first', at('first()'), at('first()') + 'first()'.length),
      {
        id: 'elif', kind: 'clause', from: elifFrom, to: elseFrom, editable: true,
        metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:'.length, bodyEnd: elseFrom, bodyIndentation: '  '},
        children: [
          {id: 'elif-condition', kind: 'socket', from: at('retry'), to: at('retry') + 5, editable: true, children: [], metadata: {socketRole: 'if-condition'}},
          statement('second', at('second()'), at('second()') + 'second()'.length)
        ]
      },
      {
        id: 'else', kind: 'clause', from: elseFrom, to: source.length, editable: true,
        metadata: {clauseRole: 'else', headerTo: elseFrom + 'else:'.length, bodyEnd: source.length, bodyIndentation: '  '},
        children: [statement('third', at('third()'), at('third()') + 'third()'.length)]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const container = layout.nodes.find((node) => node.id === 'if');
  const elseClause = layout.nodes.find((node) => node.id === 'else');
  const elseBodyEnd = elseClause.insertionZones.find((zone) => zone.destination.from === source.length);
  assert.ok(elseBodyEnd, 'the last clause must still have its own body-end zone');
  assert.deepEqual(elseBodyEnd.bounds, container.regions.footer, 'it must claim the shared footer\'s full drawn bounds');

  const primaryBodyEnd = layout.insertionZones.find((zone) => zone.destination.from === elifFrom);
  assert.ok(primaryBodyEnd, 'the primary body must still have its own body-end zone');
  assert.notDeepEqual(primaryBodyEnd.bounds, container.regions.footer, 'it must not also claim the shared footer');
});

test('renders an inline comment on a clause header beside its text, not folded into it', () => {
  const source = 'if ready:\n  first()\nelif retry:  # note\n  second()\n';
  const at = (text, from = 0) => source.indexOf(text, from);
  const elifFrom = at('elif retry:');
  const commentFrom = at('# note');
  const layout = createBlockLayout({source, root: documentNode(source, [{
    ...statement('if', 0, source.length - 1, {blockRole: 'container', headerTo: at(':') + 1, bodyEnd: elifFrom, bodyIndentation: '  '}),
    children: [
      statement('first', at('first()'), at('first()') + 'first()'.length),
      {
        id: 'elif', kind: 'clause', from: elifFrom, to: source.length, editable: true,
        metadata: {clauseRole: 'elif', headerTo: elifFrom + 'elif retry:  # note'.length, bodyEnd: source.length, bodyIndentation: '  '},
        children: [
          {id: 'elif-condition', kind: 'socket', from: at('retry'), to: at('retry') + 5, editable: true, children: [], metadata: {socketRole: 'if-condition'}},
          {id: 'note', kind: 'comment', from: commentFrom, to: commentFrom + 6, editable: true, children: [], metadata: {inline: true}},
          statement('second', at('second()'), at('second()') + 'second()'.length)
        ]
      }
    ]
  }])}, {measureText: (text) => text.length * 10});

  const elifNode = layout.nodes.find((node) => node.id === 'elif');
  const commentNode = layout.nodes.find((node) => node.id === 'note');
  assert.equal(elifNode.text, 'elif retry:', 'the comment must not be folded into the header text');
  assert.equal(commentNode.kind, 'comment');
  assert.ok(commentNode.bounds.left > elifNode.regions.header.right, 'the comment must render beside the header, not inside it');
});

test('uses the same subtree geometry for a drag preview and gives a nested child hit priority', () => {
  const source = 'if ready:\n  first()\nsecond()\n';
  const layout = createBlockLayout(projection(source));
  const first = layout.nodes.find((node) => node.id === 'first');
  const preview = createSubtreePreview(layout, 'if');

  assert.deepEqual(preview.bounds, {
    left: 0, top: 0,
    right: layout.nodes.find((node) => node.id === 'if').bounds.right,
    bottom: layout.nodes.find((node) => node.id === 'if').bounds.bottom
  });
  assert.equal(preview.children[0].bounds.left, first.bounds.left - layout.nodes.find((node) => node.id === 'if').bounds.left);
  assert.equal(hitTestBlockLayout(layout, {
    x: first.bounds.left + 1, y: first.bounds.top + 1
  }).node.id, 'first');
});

test('prefers an inner container insertion zone and retains its source indentation', () => {
  const source = 'if outer:\n  if ready:\n    pass\n';
  const layout = createBlockLayout({
    source,
    root: documentNode(source, [{
      ...statement('outer', 0, source.length, {blockRole: 'container', headerTo: 9, bodyEnd: source.length, bodyIndentation: '  '}),
      children: [{
        ...statement('inner', 12, source.length, {blockRole: 'container', headerTo: 21, bodyEnd: source.length, bodyIndentation: '    '}),
        children: [statement('pass', 26, 30)]
      }]
    }])
  });
  const inner = layout.nodes.find((node) => node.id === 'inner');
  const zone = hitTestBlockLayout(layout, {
    x: inner.regions.body.left, y: inner.regions.footer.top + 8
  }).zone;

  assert.equal(zone.depth, 2);
  assert.deepEqual(zone.destination, {from: source.length, to: source.length, indentation: '    '});
});

test('an empty document\'s insertion zone covers its whole visible empty row, not a thin band at its top', () => {
  const layout = createBlockLayout({source: '', root: documentNode('', [])});

  assert.equal(hitTestBlockLayout(layout, {x: 5, y: layout.bounds.bottom - 1})?.kind, 'insertion');
  assert.equal(hitTestBlockLayout(layout, {x: 5, y: 0})?.kind, 'insertion');
});

function projection(source) {
  return {
    source,
    root: documentNode(source, [
      {
        ...statement('if', 0, 20, {blockRole: 'container', headerTo: 9, bodyEnd: 20}),
        children: [statement('first', 12, 19)]
      },
      statement('second', 20, 28)
    ])
  };
}

function documentNode(source, children) {
  return {id: 'document', kind: 'document', from: 0, to: source.length, editable: false, children, metadata: {}};
}

function statement(id, from, to, metadata = {}) {
  return {id, kind: 'statement', from, to, editable: true, children: [], metadata};
}
