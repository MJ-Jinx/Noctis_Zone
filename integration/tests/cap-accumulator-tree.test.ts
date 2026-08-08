// cap-accumulator-tree.test.ts — the off-chain half of the cumulative wallet
// cap must agree with contracts/cardano/lib/noctis/cap_accumulator.ak byte for
// byte, or every proof it serves is rejected on chain.
//
// The ground-truth block below is the same five literals cap_accumulator.ak's
// own `ground_truth_for_the_offchain_tree_builder` test asserts through the
// real Aiken compiler. Pinning both sides to the same values is what makes a
// silent drift impossible: a change to the leaf layout, the node hash or the
// depth breaks one side loudly.

import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  CAP_EMPTY_ROOT,
  CAP_GROUND_TRUTH,
  CAP_TREE_DEPTH,
  CapAccumulator,
  type CapEntry,
  capLeafFor,
  capProofFor,
  capRootOf,
  hashCapLeaf,
  recomputeCapRoot,
} from '../cap-accumulator-tree.js';

const alice = new Uint8Array([0xaa]);
const bob = new Uint8Array([0xbb]);

describe('ground truth shared with the Aiken module', () => {
  it('produces the same leaves the compiler does', () => {
    expect(bytesToHex(hashCapLeaf(alice, 100n))).toBe(CAP_GROUND_TRUTH.leafAa100);
    expect(bytesToHex(hashCapLeaf(bob, 200n))).toBe(CAP_GROUND_TRUTH.leafBb200);
  });

  it('produces the same roots the compiler does', () => {
    expect(bytesToHex(capRootOf([]))).toBe(CAP_GROUND_TRUTH.emptyRoot);
    expect(bytesToHex(capRootOf([{ key: alice, total: 100n }]))).toBe(CAP_GROUND_TRUTH.rootAa100);
    expect(
      bytesToHex(
        capRootOf([
          { key: alice, total: 100n },
          { key: bob, total: 200n },
        ]),
      ),
    ).toBe(CAP_GROUND_TRUTH.rootAa100Bb200);
  });

  it('starts every launch at the empty root', () => {
    expect(bytesToHex(CAP_EMPTY_ROOT)).toBe(CAP_GROUND_TRUTH.emptyRoot);
  });
});

describe('proofs', () => {
  const entries: CapEntry[] = [
    { key: alice, total: 100n },
    { key: bob, total: 200n },
  ];

  it('reaches the root from the holder’s own leaf', () => {
    expect(bytesToHex(recomputeCapRoot(capLeafFor(alice, 100n), capProofFor(alice, entries)))).toBe(
      bytesToHex(capRootOf(entries)),
    );
    expect(bytesToHex(recomputeCapRoot(capLeafFor(bob, 200n), capProofFor(bob, entries)))).toBe(
      bytesToHex(capRootOf(entries)),
    );
  });

  it('is always exactly the pinned depth', () => {
    expect(capProofFor(alice, entries)).toHaveLength(CAP_TREE_DEPTH);
    expect(capProofFor(alice, [])).toHaveLength(CAP_TREE_DEPTH);
  });

  // No allowlist and no registration step: a wallet nobody has ever seen
  // proves its own empty slot against the same root everyone else uses.
  it('serves a wallet that has never traded', () => {
    const stranger = new Uint8Array([0xcc]);
    expect(bytesToHex(recomputeCapRoot(capLeafFor(stranger, 0n), capProofFor(stranger, entries)))).toBe(
      bytesToHex(capRootOf(entries)),
    );
  });

  it('does not reach the root from an understated total', () => {
    expect(bytesToHex(recomputeCapRoot(capLeafFor(alice, 40n), capProofFor(alice, entries)))).not.toBe(
      bytesToHex(capRootOf(entries)),
    );
  });

  // The freshness requirement the batcher has to respect: a proof built before
  // somebody else's trade landed is not valid after it.
  it('goes stale when another wallet moves', () => {
    const before = capProofFor(bob, [{ key: alice, total: 100n }]);
    const after = capRootOf([
      { key: alice, total: 150n },
      { key: bob, total: 0n },
    ]);
    expect(bytesToHex(recomputeCapRoot(capLeafFor(bob, 0n), before))).not.toBe(bytesToHex(after));
  });
});

describe('CapAccumulator', () => {
  it('tracks each wallet independently', () => {
    const tree = new CapAccumulator();
    tree.apply(alice, 100n);
    tree.apply(bob, 200n);
    expect(tree.totalOf(alice)).toBe(100n);
    expect(tree.totalOf(bob)).toBe(200n);
    expect(bytesToHex(tree.root)).toBe(CAP_GROUND_TRUTH.rootAa100Bb200);
  });

  it('serves a proof that reaches its own current root', () => {
    const tree = new CapAccumulator([{ key: alice, total: 100n }]);
    expect(bytesToHex(recomputeCapRoot(capLeafFor(bob, 0n), tree.proofFor(bob)))).toBe(bytesToHex(tree.root));
  });

  // A trader who buys their full cap and exits must be able to re-enter, which
  // means a sell has to return the slot to exactly its genesis state.
  it('frees a slot completely when a wallet sells everything back', () => {
    const tree = new CapAccumulator();
    tree.apply(alice, 100n);
    expect(bytesToHex(tree.root)).not.toBe(CAP_GROUND_TRUTH.emptyRoot);
    tree.apply(alice, -100n);
    expect(tree.totalOf(alice)).toBe(0n);
    expect(bytesToHex(tree.root)).toBe(CAP_GROUND_TRUTH.emptyRoot);
  });

  // A seller may hold tokens they never bought here, so a sell floors at zero
  // rather than lending them headroom they never spent.
  it('floors a sell at zero rather than going negative', () => {
    const tree = new CapAccumulator();
    expect(tree.apply(alice, -500n)).toBe(0n);
    expect(bytesToHex(tree.root)).toBe(CAP_GROUND_TRUTH.emptyRoot);
  });

  it('rejects a total too wide for the leaf encoding', () => {
    const tree = new CapAccumulator();
    expect(() => tree.set(alice, -1n)).toThrow(/8 unsigned bytes/);
    expect(() => tree.set(alice, 1n << 64n)).toThrow(/8 unsigned bytes/);
  });
});

describe('slot collisions', () => {
  // Two keys sharing a slot share one running total — they would spend each
  // other's headroom — so the builder refuses rather than serving proofs no
  // validator can accept.
  it('refuses two entries for the same key', () => {
    expect(() =>
      capRootOf([
        { key: alice, total: 1n },
        { key: alice, total: 2n },
      ]),
    ).toThrow(/two entries for key/);
  });
});
