// ============================================================================
// Noctis Protocol — reading what actually failed
// ============================================================================
// The Midnight SDK is built on Effect, and a failure arrives wrapped: a fiber
// failure holding a tagged error holding the transport error that is the real
// answer. Reading only the top layer names the step rather than the reason, and
// reading `cause` one level deep is barely better — the useful part is often
// two or three down.
//
// Both the CLIs (which report a failure to an operator) and the wallet bridge
// (which decides whether a failure is worth retrying) need the whole chain, so
// it is described in one place rather than approximated twice.
// ============================================================================

/**
 * The failure inside an Effect FiberFailure, if this is one.
 *
 * Matched by symbol description rather than by importing Effect's own id, so a
 * second copy of effect in the tree — which would give a different symbol
 * identity for the same concept — still resolves.
 */
function fiberFailureCause(err: unknown): unknown {
  if (!err || typeof err !== 'object') {
    return undefined;
  }
  // The description is "effect/Runtime/FiberFailure/Cause" — the two words are
  // separated, and a symbol named for the failure itself sits beside it, so
  // both parts have to be required or the wrong symbol matches.
  const key = Object.getOwnPropertySymbols(err).find((symbol) => {
    const description = symbol.description ?? '';
    return description.includes('FiberFailure') && description.endsWith('Cause');
  });
  if (!key) {
    return undefined;
  }
  const cause = (err as Record<symbol, unknown>)[key];
  // A Cause is a tree. Reporting one leaf when it holds several would name a
  // failure that is real but not necessarily the one that mattered.
  const failures = causeFailures(cause);
  if (failures.length === 0) {
    return cause;
  }
  return failures.length === 1 ? failures[0] : failures;
}

/** The concrete errors held by an Effect Cause tree, outermost first. */
function causeFailures(cause: unknown, depth = 0): unknown[] {
  if (!cause || typeof cause !== 'object' || depth > 12) {
    return [];
  }
  // A Cause node renders as `failure` through toJSON but stores the value on
  // `error`, so reading only the name seen in a serialised dump finds nothing
  // and quietly reports the wrapper instead. Both are accepted.
  const node = cause as {
    _tag?: string;
    failure?: unknown;
    error?: unknown;
    defect?: unknown;
    left?: unknown;
    right?: unknown;
  };
  if (node._tag === 'Fail') {
    const failure = node.failure ?? node.error;
    if (failure !== undefined) {
      return [failure];
    }
  }
  if (node._tag === 'Die' && node.defect !== undefined) {
    return [node.defect];
  }
  return [...causeFailures(node.left, depth + 1), ...causeFailures(node.right, depth + 1)];
}

/**
 * An error and everything underneath it, as one line.
 *
 * The SDK wraps failures in layers — a proving failure arrives as "Failed to
 * prove transaction" with the reason the proof server actually gave sitting in
 * `cause`, sometimes several levels down. Reporting only `message` throws that
 * away and leaves an operator with a sentence that names the step but never the
 * problem.
 *
 * Effect's tagged errors carry their detail on `_tag` and often on fields the
 * base Error shape does not declare, so anything error-shaped but message-less
 * is stringified rather than skipped.
 */
export function describeError(err: unknown, depth = 0): string {
  if (depth > 8) {
    return '…';
  }
  // Effect surfaces a failed fiber as a FiberFailure whose real cause hangs off
  // a symbol rather than `.cause`, so reading only the standard chain stops at
  // the wrapper and reports the step instead of the reason. The SDK is built on
  // Effect throughout, so this is the common case, not an edge one.
  const fiberCause = fiberFailureCause(err);
  if (fiberCause !== undefined) {
    return describeError(fiberCause, depth + 1);
  }
  if (Array.isArray(err)) {
    return err.map((each) => describeError(each, depth + 1)).join(' ;; ');
  }
  if (!(err instanceof Error)) {
    if (err && typeof err === 'object') {
      // An Error's own message/name are not enumerable, so a plain stringify of
      // something error-shaped renders "{}" and loses the only useful part.
      const shaped = err as { message?: unknown; _tag?: string; cause?: unknown };
      if (typeof shaped.message === 'string') {
        const head = [shaped._tag ? `${shaped._tag}: ` : '', shaped.message].join('');
        return shaped.cause === undefined || shaped.cause === null
          ? head
          : `${head} <- ${describeError(shaped.cause, depth + 1)}`;
      }
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    }
    return String(err);
  }
  const tag = (err as { _tag?: string })._tag;
  const head = [tag && tag !== err.name ? `${tag}: ` : '', err.message || err.name].join('');

  // An HTTP failure's status and body are the whole diagnosis, and neither is
  // in `message`.
  const record = err as unknown as Record<string, unknown>;
  const detail = ['status', 'statusCode', 'code', 'body', 'response', 'reason', 'error']
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .map(
      (field) =>
        `${field}=${String(typeof record[field] === 'object' ? JSON.stringify(record[field]) : record[field]).slice(0, 400)}`,
    )
    .join(' ');

  const cause = record.cause;
  const tail = cause === undefined || cause === null ? '' : ` <- ${describeError(cause, depth + 1)}`;
  return `${head}${detail ? ` (${detail})` : ''}${tail}`;
}

/** The innermost failure Effect is carrying, for diagnostic dumps. */
export function unwrapForDiagnosis(err: unknown): unknown {
  const inner = fiberFailureCause(err);
  if (inner === undefined) return err;
  return Array.isArray(inner) ? inner[0] : inner;
}

/** A value rendered short enough to read in a terminal, whatever its shape. */
export function safeShow(value: unknown, limit = 400): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)?.slice(0, limit) ?? String(value);
    } catch {
      return String(value).slice(0, limit);
    }
  }
  return String(value).slice(0, limit);
}
