/**
 * Whether an if/elif/else (or for/while/else) chain can still grow an "elif"
 * or "else" branch. Shared by block-surface.js, which reserves footer width
 * for the "+ elif"/"+ else" buttons, and block-surface-dom.js, which decides
 * whether to actually render them - one source of truth so the two can't
 * drift out of sync (a footer reserving room for a button that never
 * appears, or a button rendering outside the space reserved for it).
 */

// 'If'/'For'/'AsyncFor'/'While' are Python's AST type names; 'IfStatement' is
// JavaScript's - the only chain-capable JS construct, since JS has no
// for/while-else the way Python does.
export const CLAUSE_ADD_ELIGIBLE_TYPES = new Set(['If', 'IfStatement', 'For', 'AsyncFor', 'While']);

// Only an If/IfStatement chain can have an "elif"/"else if" branch at all -
// and, unlike "else", it stays offered even once an else exists, since an
// if-chain only requires elif/else-if to come before else, not that else be
// absent (inserting the new branch right before the existing else).
export function canAddElifClause(node, clauses) {
  const type = node.metadata?.type;
  if (type !== 'If' && type !== 'IfStatement') return false;
  // add-clause anchors a new elif on the last existing *elif* clause
  // specifically (never an else, even if one already exists) - an
  // else-only chain is not an anchor it can use, so only an elif clause
  // (not any clause) can stand in for a missing braced primary body here.
  return hasExtendableBody(node, clauses.filter((clause) => clause.metadata?.clauseRole === 'elif'));
}

// A statement can only ever have one else branch.
export function canAddElseClause(node, clauses) {
  const type = node.metadata?.type;
  if (!CLAUSE_ADD_ELIGIBLE_TYPES.has(type)) return false;
  if (clauses.some((clause) => clause.metadata?.clauseRole === 'else')) return false;
  return hasExtendableBody(node, clauses);
}

// A JavaScript IfStatement whose primary consequent isn't braced (`if (x)
// work();`) has no blockEnd for the transform to anchor a brand-new clause
// on (see closingBraceEnd in the JavaScript adapter) - offering the button
// there would let a click throw "Clause target has no body to extend". Once
// a clause already exists, add-clause anchors on that clause's own end
// instead and never needs blockEnd, so this only actually restricts a
// JavaScript chain with neither a braced primary body nor any clause yet.
// Python's own containers have no braced-body concept and never set
// blockEnd, so this never restricts them.
function hasExtendableBody(node, clauses) {
  return node.metadata?.type !== 'IfStatement' || Number.isInteger(node.metadata?.blockEnd) || clauses.length > 0;
}
