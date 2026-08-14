// Tests for error-detail.ts — what an operator actually reads when something
// fails.
//
// This matters more than its size suggests. The Midnight SDK wraps failures in
// layers, and reporting only the top one gives "Failed to prove transaction"
// for four unrelated root causes — which is exactly how a real debugging
// session here lost time. The cases pinned below are the unwrapping steps that
// turn that sentence back into a reason: a fiber failure matched by symbol
// description, a Cause tree with several leaves, an error-shaped object whose
// message is not enumerable, and an HTTP failure whose whole diagnosis is the
// status and body rather than the message.

import { describe, expect, it } from 'vitest';
import { describeError, safeShow, unwrapForDiagnosis } from '../error-detail.js';

/**
 * A FiberFailure as Effect really shapes it: the cause hangs off a symbol
 * whose description contains "FiberFailure" and ends with "Cause". Built by
 * description rather than by importing Effect, matching how the module
 * deliberately matches it — so a second copy of effect in the tree still
 * resolves.
 */
function fiberFailure(cause: unknown): Error {
  const err = new Error('Failed to prove transaction');
  (err as unknown as Record<symbol, unknown>)[Symbol('effect/Runtime/FiberFailure/Cause')] = cause;
  return err;
}

const fail = (failure: unknown) => ({ _tag: 'Fail', failure });
const die = (defect: unknown) => ({ _tag: 'Die', defect });
const both = (left: unknown, right: unknown) => ({ _tag: 'Parallel', left, right });

describe('describeError — plain values', () => {
  it('reports an ordinary error by message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the name when the message is empty', () => {
    // Emptied after construction rather than constructed empty, which the
    // linter rightly rejects — the case under test is an error that reaches
    // us message-less, however it got that way.
    const err = new RangeError('placeholder');
    err.message = '';

    expect(describeError(err)).toBe('RangeError');
  });

  it('stringifies a primitive', () => {
    expect(describeError('just a string')).toBe('just a string');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('renders an error-shaped object whose message is not a real Error', () => {
    // The case the module exists for: JSON.stringify on this renders "{}"
    // for a real Error, so anything error-shaped is handled by hand.
    expect(describeError({ message: 'not a real Error' })).toBe('not a real Error');
  });

  it('prefixes an Effect tagged error with its tag', () => {
    expect(describeError({ _tag: 'ProvingError', message: 'server said no' })).toBe('ProvingError: server said no');
  });

  it('does not repeat the tag when it only restates the error name', () => {
    const err = new Error('boom');
    (err as unknown as { _tag: string })._tag = 'Error';
    expect(describeError(err)).toBe('boom');
  });

  it('stringifies a plain object that has no message', () => {
    expect(describeError({ a: 1 })).toBe('{"a":1}');
  });

  it('falls back to String() when an object cannot be stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe('[object Object]');
  });
});

describe('describeError — chains', () => {
  it('follows the cause chain and joins it left to right', () => {
    const root = new Error('ECONNREFUSED');
    const mid = new Error('proof server unreachable', { cause: root });
    const top = new Error('Failed to prove transaction', { cause: mid });

    expect(describeError(top)).toBe('Failed to prove transaction <- proof server unreachable <- ECONNREFUSED');
  });

  it('follows a cause hanging off an error-shaped object too', () => {
    expect(describeError({ message: 'outer', cause: { message: 'inner' } })).toBe('outer <- inner');
  });

  it('stops descending at a bounded depth rather than recursing forever', () => {
    // A cause chain that points at itself must terminate.
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;

    const described = describeError(err);

    expect(described).toContain('…');
    expect(described.split('<-').length).toBeLessThan(12);
  });
});

describe('describeError — HTTP detail', () => {
  it('surfaces status and body, which the message never carries', () => {
    const err = Object.assign(new Error('Request failed'), { status: 503, body: 'upstream down' });

    expect(describeError(err)).toBe('Request failed (status=503 body=upstream down)');
  });

  it('serialises an object-valued detail field', () => {
    const err = Object.assign(new Error('nope'), { response: { code: 7 } });

    expect(describeError(err)).toBe('nope (response={"code":7})');
  });

  it('skips absent and null fields rather than printing them empty', () => {
    const err = Object.assign(new Error('nope'), { status: undefined, code: null, reason: 'stale' });

    expect(describeError(err)).toBe('nope (reason=stale)');
  });

  it('truncates a very long detail field', () => {
    const err = Object.assign(new Error('nope'), { body: 'x'.repeat(900) });

    const described = describeError(err);

    expect(described).toContain('x'.repeat(400));
    expect(described).not.toContain('x'.repeat(401));
  });
});

describe('describeError — Effect fiber failures', () => {
  it('reports the reason inside a fiber failure, not the wrapper', () => {
    // Without this the operator gets "Failed to prove transaction" and no reason.
    expect(describeError(fiberFailure(fail(new Error('proof server returned 500'))))).toBe('proof server returned 500');
  });

  it('reads a Cause node that stores its value on `error` rather than `failure`', () => {
    // Serialised dumps show `failure`; the live object uses `error`. Reading
    // only one finds nothing and silently reports the wrapper instead.
    expect(describeError(fiberFailure({ _tag: 'Fail', error: new Error('real reason') }))).toBe('real reason');
  });

  it('reports a defect held by a Die node', () => {
    expect(describeError(fiberFailure(die(new Error('unexpected'))))).toBe('unexpected');
  });

  it('reports every leaf when a Cause tree holds more than one', () => {
    // Naming one leaf would name a failure that is real but not necessarily
    // the one that mattered.
    const described = describeError(fiberFailure(both(fail(new Error('first')), fail(new Error('second')))));

    expect(described).toBe('first ;; second');
  });

  it('falls back to the cause itself when the tree holds no recognisable leaf', () => {
    expect(describeError(fiberFailure({ _tag: 'Empty' }))).toBe('{"_tag":"Empty"}');
  });

  // The symbol is matched on BOTH halves of its description, because a symbol
  // named for the failure itself sits beside the cause symbol. Each half is
  // neutered independently by these two tests — dropping either one lets the
  // wrong symbol match.
  it('ignores a symbol whose description does not end with Cause', () => {
    const err = new Error('top');
    (err as unknown as Record<symbol, unknown>)[Symbol('effect/Runtime/FiberFailure')] = fail(new Error('hidden'));

    expect(describeError(err)).toBe('top');
  });

  it('ignores a symbol that ends with Cause but is not a FiberFailure one', () => {
    const err = new Error('top');
    (err as unknown as Record<symbol, unknown>)[Symbol('some/other/Cause')] = fail(new Error('hidden'));

    expect(describeError(err)).toBe('top');
  });
});

describe('unwrapForDiagnosis', () => {
  it('returns the value unchanged when it is not a fiber failure', () => {
    const err = new Error('plain');
    expect(unwrapForDiagnosis(err)).toBe(err);
  });

  it('returns the innermost failure of a fiber failure', () => {
    const root = new Error('root');
    expect(unwrapForDiagnosis(fiberFailure(fail(root)))).toBe(root);
  });

  it('returns the first failure when a Cause tree holds several', () => {
    const first = new Error('first');
    expect(unwrapForDiagnosis(fiberFailure(both(fail(first), fail(new Error('second')))))).toBe(first);
  });
});

describe('safeShow', () => {
  it('renders an object as json', () => {
    expect(safeShow({ a: 1 })).toBe('{"a":1}');
  });

  it('renders a primitive as a string', () => {
    expect(safeShow(7)).toBe('7');
    expect(safeShow(null)).toBe('null');
  });

  it('truncates to the limit', () => {
    expect(safeShow('y'.repeat(50), 10)).toBe('y'.repeat(10));
  });

  it('falls back to String() on a value json cannot render', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeShow(circular)).toBe('[object Object]');
  });

  it('renders a bigint, which json refuses outright', () => {
    expect(safeShow(10n)).toBe('10');
  });
});
