// Tests for midnight-maintenance.ts — completing a contract that was deployed
// in phases.
//
// The delivery itself is a real transaction, verified against the deployed
// gate on Preprod. What is covered here is the reasoning around it: what a
// contract still needs, that a stopped run resumes rather than repeats, and
// that a contract disagreeing with this build is caught before anything is
// signed against it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  submitInsertVerifierKeyTx: vi.fn(),
  verifierKeysEqual: (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]),
}));

import { submitInsertVerifierKeyTx } from '@midnight-ntwrk/midnight-js-contracts';
import { deliverCircuits, planCircuitDelivery, verifyDeliveredCircuits } from '../midnight-maintenance.js';

const ADDRESS = 'a'.repeat(64);
const ALL = ['alpha', 'beta', 'gamma', 'delta'];

function key(fill: number): Uint8Array {
  return new Uint8Array(8).fill(fill);
}

/** A contract state carrying `present`, each with a key derived from its name. */
function fakeContractState(present: readonly string[], keyOverrides: Record<string, Uint8Array> = {}) {
  return {
    operations: () => [...present],
    operation: (id: string) =>
      present.includes(id) ? { verifierKey: keyOverrides[id] ?? key(ALL.indexOf(id)) } : undefined,
  };
}

function fakeProviders(contractState: unknown) {
  return {
    publicDataProvider: { queryContractState: vi.fn().mockResolvedValue(contractState) },
    zkConfigProvider: { getVerifierKey: vi.fn(async (id: string) => key(ALL.indexOf(id))) },
  } as never;
}

beforeEach(() => {
  vi.mocked(submitInsertVerifierKeyTx).mockReset();
});

describe('planCircuitDelivery', () => {
  it('reports what is missing, in the order the caller asked for', () => {
    // Order is the caller's delivery priority — the circuits a launch needs
    // soonest go first — so the plan must not re-sort it.
    const plan = planCircuitDelivery(['beta'], ['delta', 'alpha', 'beta']);

    expect(plan.missing).toEqual(['delta', 'alpha']);
  });

  it('reports nothing missing once every circuit is on chain', () => {
    expect(planCircuitDelivery(ALL, ALL).missing).toEqual([]);
  });

  it('flags circuits on chain that this build does not define', () => {
    // Not a harmless extra: it means the deployed contract and this source
    // tree disagree about what the contract is.
    const plan = planCircuitDelivery(['alpha', 'stranger'], ['alpha', 'beta']);

    expect(plan.unexpected).toEqual(['stranger']);
    expect(plan.missing).toEqual(['beta']);
  });

  it('is unaffected by the order the chain reports its own operations in', () => {
    const forwards = planCircuitDelivery(['alpha', 'beta'], ALL);
    const backwards = planCircuitDelivery(['beta', 'alpha'], ALL);

    expect(forwards.missing).toEqual(backwards.missing);
  });
});

describe('deliverCircuits', () => {
  it('submits one transaction per circuit, with that circuit’s own key', async () => {
    vi.mocked(submitInsertVerifierKeyTx).mockImplementation(
      async (_p, _c, _a, circuitId) =>
        ({
          txId: `tx-${circuitId}`,
          txHash: `hash-${circuitId}`,
          blockHeight: 100,
        }) as never,
    );
    const providers = fakeProviders(fakeContractState([]));

    const delivered = await deliverCircuits(providers, {}, ADDRESS, ['gamma', 'delta']);

    expect(delivered.map((d) => d.circuitId)).toEqual(['gamma', 'delta']);
    expect(delivered[0].txId).toBe('tx-gamma');
    expect(submitInsertVerifierKeyTx).toHaveBeenNthCalledWith(1, providers, {}, ADDRESS, 'gamma', key(2));
    expect(submitInsertVerifierKeyTx).toHaveBeenNthCalledWith(2, providers, {}, ADDRESS, 'delta', key(3));
  });

  it('delivers sequentially, so no two updates race the same wallet or state', async () => {
    const inFlight: string[] = [];
    let maxConcurrent = 0;
    vi.mocked(submitInsertVerifierKeyTx).mockImplementation(async (_p, _c, _a, circuitId) => {
      inFlight.push(String(circuitId));
      maxConcurrent = Math.max(maxConcurrent, inFlight.length);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight.pop();
      return { txId: 'tx-any', txHash: 'hash-any', blockHeight: 1 } as never;
    });

    await deliverCircuits(fakeProviders(fakeContractState([])), {}, ADDRESS, ALL);

    expect(maxConcurrent).toBe(1);
  });

  it('leaves already-delivered circuits on chain when a later one fails', async () => {
    vi.mocked(submitInsertVerifierKeyTx)
      .mockResolvedValueOnce({ txId: 'tx-first', txHash: 'hash-first', blockHeight: 1 } as never)
      .mockRejectedValueOnce(new Error('node said no'));

    await expect(deliverCircuits(fakeProviders(fakeContractState([])), {}, ADDRESS, ALL)).rejects.toThrow(
      'node said no',
    );

    // The first really was submitted, and the third was never attempted — which
    // is what makes re-running from the chain's own state the right recovery.
    expect(submitInsertVerifierKeyTx).toHaveBeenCalledTimes(2);
  });

  it('does nothing at all when there is nothing to deliver', async () => {
    const delivered = await deliverCircuits(fakeProviders(fakeContractState(ALL)), {}, ADDRESS, []);

    expect(delivered).toEqual([]);
    expect(submitInsertVerifierKeyTx).not.toHaveBeenCalled();
  });
});

describe('verifyDeliveredCircuits', () => {
  it('confirms a complete contract whose keys are the locally built ones', async () => {
    const results = await verifyDeliveredCircuits(fakeProviders(fakeContractState(ALL)), ADDRESS, ALL);

    expect(results.every((r) => r.present && r.keyMatches)).toBe(true);
  });

  it('reports every missing circuit rather than stopping at the first', async () => {
    const results = await verifyDeliveredCircuits(fakeProviders(fakeContractState(['alpha'])), ADDRESS, ALL);

    expect(results.filter((r) => !r.present).map((r) => r.circuitId)).toEqual(['beta', 'gamma', 'delta']);
  });

  it('catches a present circuit whose on-chain key is not the one this build produces', async () => {
    // The case worth catching: the contract accepts the call and then rejects
    // every proof built against this source.
    const state = fakeContractState(ALL, { gamma: key(0xff) });

    const results = await verifyDeliveredCircuits(fakeProviders(state), ADDRESS, ALL);

    const gamma = results.find((r) => r.circuitId === 'gamma');
    expect(gamma).toEqual({ circuitId: 'gamma', present: true, keyMatches: false });
    expect(results.filter((r) => r.keyMatches)).toHaveLength(3);
  });

  it('says there is nothing to verify when no contract exists at the address', async () => {
    await expect(verifyDeliveredCircuits(fakeProviders(null), ADDRESS, ALL)).rejects.toThrow(
      /No contract found at a{64}/,
    );
  });
});
