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
export function canAddElifClause(node) {
  const type = node.metadata?.type;
  return type === 'If' || type === 'IfStatement';
}

// A statement can only ever have one else branch.
export function canAddElseClause(node, clauses) {
  const type = node.metadata?.type;
  if (!CLAUSE_ADD_ELIGIBLE_TYPES.has(type)) return false;
  return !clauses.some((clause) => clause.metadata?.clauseRole === 'else');
}
