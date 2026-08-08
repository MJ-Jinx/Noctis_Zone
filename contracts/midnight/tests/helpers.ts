// ============================================================================
// Shared test helpers for Compact PSM simulation tests
// ============================================================================
// Thin wrappers around @midnight-ntwrk/compact-runtime for constructing a
// contract's initial state and driving circuit calls in tests, without
// needing a real Midnight node, wallet, or ZK proof generation.
//
// Verified against the real runtime API (v0.16.0) directly — not guessed
// from memory. See contracts/midnight/README.md for how this was confirmed
// working end-to-end (constructor + circuit call + a second call reading
// back accumulated state) before any test files were written.
// ============================================================================

import {
  type CircuitContext,
  type ConstructorResult,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

/** A deterministic 32-byte value for test key material — not a real key. */
export function fakeBytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** A dummy Zswap coin public key, sufficient for constructing contexts in tests. */
export const dummyCoinPublicKey = { bytes: fakeBytes32(1) };

/**
 * Deploy a contract for testing: runs its constructor and returns both the
 * constructor result and a ready-to-use CircuitContext for the first call.
 */
export function deployForTest<PS, ConstructorArgs extends unknown[]>(
  contract: {
    initialState: (
      ctx: ReturnType<typeof createConstructorContext<PS>>,
      ...args: ConstructorArgs
    ) => ConstructorResult<PS>;
  },
  initialPrivateState: PS,
  ...constructorArgs: ConstructorArgs
): { init: ConstructorResult<PS>; contractAddress: ReturnType<typeof sampleContractAddress>; ctx: CircuitContext<PS> } {
  const constructorContext = createConstructorContext(initialPrivateState, dummyCoinPublicKey);
  const init = contract.initialState(constructorContext, ...constructorArgs);
  const contractAddress = sampleContractAddress();
  const ctx = createCircuitContext<PS>(
    contractAddress,
    dummyCoinPublicKey,
    init.currentContractState,
    init.currentPrivateState,
  );
  return { init, contractAddress, ctx };
}

/**
 * Build the CircuitContext for the *next* call, threading state forward from
 * a previous circuit call's result — since each circuit call returns a new
 * context.currentQueryContext.state/currentPrivateState that the following
 * call must be built from, not the original deploy-time state.
 */
export function nextContext<PS>(
  contractAddress: ReturnType<typeof sampleContractAddress>,
  previous: CircuitContext<PS>,
): CircuitContext<PS> {
  return createCircuitContext<PS>(
    contractAddress,
    dummyCoinPublicKey,
    previous.currentQueryContext.state,
    previous.currentPrivateState,
  );
}

/**
 * Same as `nextContext`, but pins the simulator's block time (what
 * `blockTimeGt`/`blockTimeGte`/`blockTimeLt` read) to an explicit value
 * instead of `createCircuitContext`'s default of real wall-clock time
 * (`Math.floor(Date.now() / 1000)` — confirmed from
 * @midnight-ntwrk/compact-runtime's `circuit-context.js`). Needed for any
 * deterministic test of a circuit gated on `blockTime*` (e.g.
 * bonding_curve.compact's `expireCurve`, fixed this session's security
 * audit to no longer trust a caller-supplied timestamp).
 */
export function nextContextAtTime<PS>(
  contractAddress: ReturnType<typeof sampleContractAddress>,
  previous: CircuitContext<PS>,
  timeSeconds: number,
): CircuitContext<PS> {
  return createCircuitContext<PS>(
    contractAddress,
    dummyCoinPublicKey,
    previous.currentQueryContext.state,
    previous.currentPrivateState,
    undefined,
    undefined,
    timeSeconds,
  );
}

/**
 * A mutable single-slot holder for the most recently observed ledger state
 * within a describe block, used to drive `afterEach` conservation-invariant
 * checks. Tests here are function-scoped — each builds its own local
 * contract/ctx via deployForTest/nextContext — so there's no describe-level
 * ledger an `afterEach` could close over directly. Call `trackLedger(sink,
 * ledger(state))` at call sites that already read ledger state (in place of
 * a bare `ledger(state)`), then read `sink.current` from `afterEach`.
 */
export interface LedgerSink<T> {
  current?: T;
}

export function trackLedger<T>(sink: LedgerSink<T>, state: T): T {
  sink.current = state;
  return state;
}
