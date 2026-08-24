const OPAQUE_KINDS = new Set([
  'opaque-statement',
  'opaque-expression',
  'opaque-region'
]);

/**
 * Build a source-authoritative projection for regions a language adapter could
 * not structurally parse. The returned nodes retain only ranges; consumers read
 * their text from the ParseResult source snapshot with getNodeText().
 */
export function createOpaqueProjection(source, regions = []) {
  assertSource(source);
  const normalized = regions
    .map((region, index) => normalizeOpaqueRegion(source, region, index))
    .sort(compareRanges);

  assertNonOverlapping(normalized);

  return {
    source,
    root: {
      id: `document:0:${source.length}`,
      kind: 'document',
      from: 0,
      to: source.length,
      editable: false,
      children: normalized.map(({node}) => node)
    },
    issues: normalized.map(({issue}) => issue).filter(Boolean)
  };
}

/**
 * Runs a language parser without allowing syntax failures to make block mode
 * unavailable. A parser may attach `from`, `to`, and `opaqueKind` to its
 * thrown error; otherwise the entire snapshot is represented as an unknown
 * opaque region.
 */
export function parseWithOpaqueRecovery(source, parseStructured) {
  assertSource(source);
  if (typeof parseStructured !== 'function') {
    throw new TypeError('A structured parser function is required');
  }

  try {
    const parsed = parseStructured(source);
    if (parsed?.source !== source) {
      throw new TypeError('Structured parsers must retain the input source snapshot');
    }
    return parsed;
  } catch (error) {
    if (error?.message === 'Structured parsers must retain the input source snapshot') {
      throw error;
    }

    const hasValidRange =
      isValidOffset(source, error?.from) &&
      isValidOffset(source, error?.to) &&
      error.to >= error.from;
    const from = hasValidRange ? error.from : 0;
    const to = hasValidRange ? error.to : source.length;
    const kind = OPAQUE_KINDS.has(error?.opaqueKind)
      ? error.opaqueKind
      : 'opaque-region';

    return createOpaqueProjection(source, [{
      kind,
      from,
      to,
      movable: error?.movable === true,
      issue: {
        message: error?.message ?? 'Unable to parse source',
        severity: error?.severity ?? 'error'
      }
    }]);
  }
}

/** Returns the exact source represented by a projection node. */
export function getNodeText(parsed, node) {
  assertSource(parsed?.source);
  assertRange(parsed.source, node);
  return parsed.source.slice(node.from, node.to);
}

/** Opaque regions are never internally editable. */
export function isOpaque(node) {
  return OPAQUE_KINDS.has(node?.kind);
}

/**
 * Movement is opt-in. Unknown opaque regions never move; statement and
 * expression regions may move only when an adapter has established context.
 */
export function canMoveOpaque(node) {
  return isOpaque(node) &&
    node.kind !== 'opaque-region' &&
    node.metadata?.movable === true;
}

/**
 * Applies minimal, non-overlapping source edits atomically to a snapshot.
 * Changes are applied from right to left so every range addresses the original
 * snapshot. CodeMirror integration will translate these into one transaction.
 */
export function applySourceChanges(source, changes) {
  const normalized = normalizeSourceChanges(source, changes);

  return normalized.reduceRight(
    (nextSource, change) =>
      nextSource.slice(0, change.from) + change.insert + nextSource.slice(change.to),
    source
  );
}

/** Validates and orders minimal source changes for a single source snapshot. */
export function normalizeSourceChanges(source, changes) {
  assertSource(source);
  if (!Array.isArray(changes)) throw new TypeError('Source changes must be an array');
  const normalized = changes
    .map((change) => normalizeSourceChange(source, change))
    .sort(compareRanges);
  assertNonOverlapping(normalized);
  return normalized;
}

/**
 * Depth-first search for a node with an exact kind and range match. Shared by
 * the language adapters' transform functions to resolve a source-range
 * operation's target/source back to a live projection node.
 */
export function findNode(node, range, kind) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if (node.kind === kind && node.from === range.from && node.to === range.to) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, range, kind);
    if (found) return found;
  }
  return undefined;
}

/** Depth-first search for a 'socket' or 'recovery-socket' node at an exact range. */
export function findSocket(node, range) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  if ((node.kind === 'socket' || node.kind === 'recovery-socket') && node.from === range.from && node.to === range.to) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findSocket(child, range);
    if (found) return found;
  }
  return undefined;
}

/**
 * Depth-first search for any node at an exact range, regardless of kind -
 * preferring the innermost match, the same way hitTestBlockLayout prefers a
 * child over its enclosing container. A single-statement document with no
 * trailing newline gives its one statement (or a call/def nested inside it)
 * the exact same range as the document root itself; checking children first
 * resolves the specific statement/expression a caller actually meant instead
 * of the document wrapping it, without needing kind-aware call sites.
 */
export function findAny(node, range) {
  if (!node || !Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return undefined;
  for (const child of node.children ?? []) {
    const found = findAny(child, range);
    if (found) return found;
  }
  return node.from === range.from && node.to === range.to ? node : undefined;
}

/** Finds the direct parent of a specific node instance within a projection tree. */
export function findParent(node, target) {
  for (const child of node.children ?? []) {
    if (child === target) return node;
    const parent = findParent(child, target);
    if (parent) return parent;
  }
  return undefined;
}

/** A stable, source-position-first ordering for a projection node's children. */
export function compareProjectedNodes(left, right) {
  return left.from - right.from || left.to - right.to || left.id.localeCompare(right.id);
}

/** Throws unless `parsed` looks like a current `{source, root}` projection. */
export function assertParsedSource(parsed, language) {
  if (typeof parsed?.source !== 'string' || !parsed?.root) {
    throw new TypeError(`A current ${language} projection is required`);
  }
}

/** Throws unless a block operation's own replacement/insertion text is a string. */
export function assertOperationSource(source, label) {
  if (typeof source !== 'string') throw new TypeError(`${label} source must be a string`);
}

/** Throws unless a statement destination is a zero-width position within the source. */
export function assertInsertionPoint(source, destination) {
  if (!Number.isInteger(destination?.from) || destination.from !== destination.to ||
      destination.from < 0 || destination.from > source.length) {
    throw new RangeError('Statement destination must be a zero-width source position');
  }
}

/**
 * Splits source into its physical lines, each carrying its own line-ending
 * string (so the original text is exactly `lines.map(l => l.text + l.ending).join('')`).
 * A trailing line with no terminator is included with ending: ''.
 */
export function physicalLines(source) {
  const lines = [];
  let from = 0;
  // A sticky/global regex with lastIndex, not source.slice(index) re-run on
  // every line: slicing the whole remaining source on each iteration makes
  // this O(source length x line count), and this runs on every parse - every
  // keystroke, in the live editor.
  const ending = /\r\n|\r|\n/g;
  let match;
  while ((match = ending.exec(source)) !== null) {
    const to = match.index + match[0].length;
    lines.push({from, to, text: source.slice(from, match.index), ending: match[0]});
    from = to;
    ending.lastIndex = to;
  }
  if (from < source.length) lines.push({from, to: source.length, text: source.slice(from), ending: ''});
  return lines;
}

/** The end of the physical line containing `position` (before its own line ending, if any). */
export function lineTextEnd(source, position) {
  let end = position;
  while (end < source.length && source[end] !== '\r' && source[end] !== '\n') end += 1;
  return end;
}

function normalizeOpaqueRegion(source, region, index) {
  if (!OPAQUE_KINDS.has(region?.kind)) {
    throw new TypeError(`Unsupported opaque node kind: ${region?.kind}`);
  }
  assertRange(source, region);

  const movable = region.movable === true && region.kind !== 'opaque-region';
  const node = {
    id: region.id ?? `${region.kind}:${region.from}:${region.to}:${index}`,
    kind: region.kind,
    from: region.from,
    to: region.to,
    editable: false,
    children: [],
    metadata: {movable}
  };
  const issue = region.issue && {
    from: region.from,
    to: region.to,
    message: region.issue.message,
    severity: region.issue.severity ?? 'error'
  };

  return {from: region.from, to: region.to, node, issue};
}

function normalizeSourceChange(source, change) {
  assertRange(source, change);
  if (typeof change.insert !== 'string') {
    throw new TypeError('Source changes require a string insert value');
  }
  return {from: change.from, to: change.to, insert: change.insert};
}

function assertSource(source) {
  if (typeof source !== 'string') {
    throw new TypeError('Source must be a string');
  }
}

function assertRange(source, range) {
  if (!Number.isInteger(range?.from) || !Number.isInteger(range?.to) ||
      range.from < 0 || range.to < range.from || range.to > source.length) {
    throw new RangeError('Range must be within the source snapshot');
  }
}

function isValidOffset(source, offset) {
  return Number.isInteger(offset) && offset >= 0 && offset <= source.length;
}

function assertNonOverlapping(ranges) {
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].to > ranges[index].from) {
      throw new RangeError('Source ranges must not overlap');
    }
  }
}

function compareRanges(left, right) {
  return left.from - right.from || left.to - right.to;
}
