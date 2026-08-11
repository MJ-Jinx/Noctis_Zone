// Tests for staking-reward-tree.ts — the Merkle tree a staker's reward claim
// is verified against by staking_pool.ak's ClaimRewards.
//
// WHY THIS MATTERS
// This root mints real tokens. If the tree this file builds and the tree the
// validator verifies ever disagree by one byte, nothing errors: the governor
// publishes a root, every staker's proof fails, and the pool pays nobody.
//
// The Aiken side had only relational tests (deterministic, differs-by-amount),
// which a matching pair of changes on both sides would satisfy while producing
// exactly that. The ground-truth block below is one leg of a three-way
// agreement — Python, this file, and
// `hash_reward_leaf_matches_the_offchain_tree_builder` in staking_pool.ak —
// added together so a drift in any one of them fails a test.

import { describe, expect, it } from 'vitest';
import {
  buildRewardTree,
  clearedNullifierHex,
  hashRewardLeaf,
  hashRewardNode,
  type RewardEntry,
  verifyRewardMerkleProof,
} from '../staking-reward-tree.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

const entry = (b: number, payout: bigint): RewardEntry => ({
  stakerVkh: new Uint8Array([b]),
  payoutAmount: payout,
});

describe('hashRewardLeaf / hashRewardNode — ground truth', () => {
  it('matches the literals asserted by staking_pool.ak', () => {
    // Same three values, byte for byte, as the Aiken test of the same name.
    // Computed a third time in Python before either was written down.
    const leaf0 = hashRewardLeaf(new Uint8Array([0xaa]), 100n, 0);
    const leaf1 = hashRewardLeaf(new Uint8Array([0xbb]), 200n, 1);
    const node = hashRewardNode(leaf0, leaf1);

    expect(hex(leaf0)).toBe('0E2108EEC355989F4BB37BD237ADC7EC31FAAB5B37A76C1640DEAD2BCCE4E2AE');
    expect(hex(leaf1)).toBe('C4DCC65A272337D9ED0A01B1F15D7843DCE695EA201CA284E77FE066E4BA80C8');
    expect(hex(node)).toBe('AD4B68BDF104D08A3822FB303336C6C7239BF3EEB6A19C3C42DACBA0FDA34A47');
  });

  it('produces a different leaf for the same staker and amount at a different index', () => {
    // The index is hashed in so a proof issued for one bit of the pool's
    // nullifier cannot be replayed against another — otherwise a staker could
    // spend somebody else's bit and leave their own free to claim again.
    const a = hashRewardLeaf(new Uint8Array([0xaa]), 100n, 0);
    const b = hashRewardLeaf(new Uint8Array([0xaa]), 100n, 1);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('produces a different leaf for a different amount', () => {
    const a = hashRewardLeaf(new Uint8Array([0xaa]), 100n, 0);
    const b = hashRewardLeaf(new Uint8Array([0xaa]), 101n, 0);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('is order-sensitive at a node', () => {
    // hash_reward_node has no domain-separation prefix, so left/right order is
    // the only thing distinguishing the two pairings.
    const l = hashRewardLeaf(new Uint8Array([0xaa]), 100n, 0);
    const r = hashRewardLeaf(new Uint8Array([0xbb]), 200n, 1);
    expect(hex(hashRewardNode(l, r))).not.toBe(hex(hashRewardNode(r, l)));
  });

  it('refuses an amount that does not fit the on-chain 16-byte field', () => {
    // Aiken's bytearray.from_int_big_endian(_, 16) has the same ceiling. An
    // amount silently truncated here would produce a leaf the validator never
    // reproduces.
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), 2n ** 128n, 0)).toThrow(/does not fit in 16 bytes/);
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), -1n, 0)).toThrow(/does not fit in 16 bytes/);
  });

  it('accepts the largest amount that does fit', () => {
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), 2n ** 128n - 1n, 0)).not.toThrow();
  });

  it('refuses a leaf index that is not a 4-byte unsigned integer', () => {
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), 1n, -1)).toThrow(/4-byte unsigned integer/);
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), 1n, 1.5)).toThrow(/4-byte unsigned integer/);
    expect(() => hashRewardLeaf(new Uint8Array([0xaa]), 1n, 0x1_0000_0000)).toThrow(/4-byte unsigned integer/);
  });
});

describe('buildRewardTree', () => {
  it('refuses to build an empty tree', () => {
    // A root over nothing is still a 32-byte value that would publish fine.
    expect(() => buildRewardTree([])).toThrow(/at least one entry/);
  });

  it('single entry — the root is the leaf and the proof is empty', () => {
    const entries = [entry(0xaa, 100n)];
    const tree = buildRewardTree(entries);
    expect(hex(tree.root)).toBe(hex(hashRewardLeaf(entries[0].stakerVkh, 100n, 0)));
    expect(tree.getProof(0)).toEqual([]);
  });

  it('verifies every leaf in an even-sized tree', () => {
    const entries = [entry(0xaa, 100n), entry(0xbb, 200n), entry(0xcc, 300n), entry(0xdd, 400n)];
    const tree = buildRewardTree(entries);
    entries.forEach((e, i) => {
      const leaf = hashRewardLeaf(e.stakerVkh, e.payoutAmount, i);
      expect(verifyRewardMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    });
  });

  it('verifies every leaf in an odd-sized tree', () => {
    // The odd node at a level is promoted by self-pairing, and the leaf that
    // lands on it is the one most likely to be got wrong.
    const entries = [entry(0xaa, 100n), entry(0xbb, 200n), entry(0xcc, 300n)];
    const tree = buildRewardTree(entries);
    entries.forEach((e, i) => {
      const leaf = hashRewardLeaf(e.stakerVkh, e.payoutAmount, i);
      expect(verifyRewardMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    });
  });

  it('verifies every leaf across sizes 1 through 9', () => {
    for (let n = 1; n <= 9; n++) {
      const entries = Array.from({ length: n }, (_, i) => entry(i + 1, BigInt((i + 1) * 100)));
      const tree = buildRewardTree(entries);
      for (let i = 0; i < n; i++) {
        const leaf = hashRewardLeaf(entries[i].stakerVkh, entries[i].payoutAmount, i);
        expect(verifyRewardMerkleProof(tree.root, leaf, tree.getProof(i)), `size ${n}, index ${i}`).toBe(true);
      }
    }
  });

  it('grows the proof by one step each time the tree doubles', () => {
    expect(buildRewardTree(Array.from({ length: 1 }, (_, i) => entry(i + 1, 1n))).getProof(0)).toHaveLength(0);
    expect(buildRewardTree(Array.from({ length: 2 }, (_, i) => entry(i + 1, 1n))).getProof(0)).toHaveLength(1);
    expect(buildRewardTree(Array.from({ length: 4 }, (_, i) => entry(i + 1, 1n))).getProof(0)).toHaveLength(2);
    expect(buildRewardTree(Array.from({ length: 8 }, (_, i) => entry(i + 1, 1n))).getProof(0)).toHaveLength(3);
  });

  it('refuses a proof index outside the tree', () => {
    const tree = buildRewardTree([entry(0xaa, 100n), entry(0xbb, 200n)]);
    expect(() => tree.getProof(-1)).toThrow(/out of range/);
    expect(() => tree.getProof(2)).toThrow(/out of range/);
  });

  it('changes the root when any single payout changes', () => {
    const before = buildRewardTree([entry(0xaa, 100n), entry(0xbb, 200n)]);
    const after = buildRewardTree([entry(0xaa, 100n), entry(0xbb, 201n)]);
    expect(hex(before.root)).not.toBe(hex(after.root));
  });

  it('changes the root when two stakers swap positions', () => {
    // Position is the staker's nullifier bit, so it is part of what the root
    // commits to, not an ordering detail.
    const before = buildRewardTree([entry(0xaa, 100n), entry(0xbb, 200n)]);
    const after = buildRewardTree([entry(0xbb, 200n), entry(0xaa, 100n)]);
    expect(hex(before.root)).not.toBe(hex(after.root));
  });
});

describe('verifyRewardMerkleProof', () => {
  const entries = [entry(0xaa, 100n), entry(0xbb, 200n), entry(0xcc, 300n), entry(0xdd, 400n)];
  const tree = buildRewardTree(entries);
  const leafAt = (i: number) => hashRewardLeaf(entries[i].stakerVkh, entries[i].payoutAmount, i);

  it('rejects a leaf claiming more than the tree committed to', () => {
    // The whole point of the root: a staker who edits their own payout upward
    // and keeps their real proof must not verify.
    const inflated = hashRewardLeaf(entries[0].stakerVkh, 999_999n, 0);
    expect(verifyRewardMerkleProof(tree.root, inflated, tree.getProof(0))).toBe(false);
  });

  it('rejects another staker presenting a leaf at a position that is not theirs', () => {
    const impostor = hashRewardLeaf(new Uint8Array([0xee]), 100n, 0);
    expect(verifyRewardMerkleProof(tree.root, impostor, tree.getProof(0))).toBe(false);
  });

  it("rejects a real leaf carried on another index's proof", () => {
    expect(verifyRewardMerkleProof(tree.root, leafAt(0), tree.getProof(1))).toBe(false);
  });

  it('rejects a proof whose sibling has been altered', () => {
    const proof = tree.getProof(0).map((s) => ({ ...s, sibling: new Uint8Array(s.sibling) }));
    proof[0].sibling[0] ^= 0xff;
    expect(verifyRewardMerkleProof(tree.root, leafAt(0), proof)).toBe(false);
  });

  it('rejects a proof with a step flipped to the wrong side', () => {
    // goesLeft decides the concatenation order, and hash_reward_node has no
    // prefix distinguishing the two.
    const proof = tree.getProof(0).map((s) => ({ ...s, goesLeft: !s.goesLeft }));
    expect(verifyRewardMerkleProof(tree.root, leafAt(0), proof)).toBe(false);
  });

  it('rejects a truncated proof', () => {
    expect(verifyRewardMerkleProof(tree.root, leafAt(0), tree.getProof(0).slice(0, 1))).toBe(false);
  });

  it('rejects a root that merely starts with the computed one', () => {
    // The length comparison only earns its place in this direction. Against a
    // SHORTER root, every() still walks all 32 computed bytes and compares the
    // tail against undefined, so it returns false either way — which is why
    // the obvious version of this test passes even with the check removed.
    // A LONGER root is the case that needs it: without the length comparison,
    // every() runs out after 32 bytes, finds them all equal, and accepts.
    const extended = new Uint8Array(48);
    extended.set(tree.root, 0);
    expect(verifyRewardMerkleProof(extended, leafAt(0), tree.getProof(0))).toBe(false);
  });

  it('rejects a truncated root as well', () => {
    expect(verifyRewardMerkleProof(tree.root.slice(0, 16), leafAt(0), tree.getProof(0))).toBe(false);
  });
});

describe('clearedNullifierHex', () => {
  it('sizes one byte for up to eight entries', () => {
    expect(clearedNullifierHex(1)).toBe('00');
    expect(clearedNullifierHex(8)).toBe('00');
  });

  it('rounds up to a whole byte at the boundary', () => {
    // The failure this prevents: a map one byte short leaves the highest leaf
    // indices with no bit to claim against, so those stakers cannot be paid.
    expect(clearedNullifierHex(9)).toBe('0000');
    expect(clearedNullifierHex(16)).toBe('0000');
    expect(clearedNullifierHex(17)).toBe('000000');
  });

  it('is every bit zero, so nobody starts out already claimed', () => {
    expect(clearedNullifierHex(100)).toMatch(/^0+$/);
    expect(clearedNullifierHex(100)).toHaveLength(2 * Math.ceil(100 / 8));
  });

  it('refuses a count that could not describe a real tree', () => {
    expect(() => clearedNullifierHex(0)).toThrow(/positive whole number/);
    expect(() => clearedNullifierHex(-1)).toThrow(/positive whole number/);
    expect(() => clearedNullifierHex(1.5)).toThrow(/positive whole number/);
  });
});
