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
