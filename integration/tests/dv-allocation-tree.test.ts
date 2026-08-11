import { describe, expect, it } from 'vitest';
import { buildDvAllocationTree, hashDvLeaf, hashDvNode, verifyDvMerkleProof } from '../dv-allocation-tree.js';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

describe('hashDvLeaf / hashDvNode — ground truth', () => {
  it('matches real values extracted from a live aiken check run against bonding_curve_tier_b.ak', () => {
    // Re-derived 2026-08-05 when the leaf gained its index. Three-way
    // agreement, not two: computed independently in Python, asserted as
    // literals by `hash_dv_leaf_matches_the_offchain_tree_builder` in
    // bonding_curve_tier_b.ak, and asserted here. A drift in any one of the
    // three fails a test rather than silently invalidating every proof.
    const leaf0 = hashDvLeaf(new Uint8Array([0xaa]), 100n, 0, new Uint8Array([0x01]));
    const leaf1 = hashDvLeaf(new Uint8Array([0xbb]), 200n, 1, new Uint8Array([0x02]));
    const node = hashDvNode(leaf0, leaf1);

    expect(hex(leaf0)).toBe('EB01560639A5CD1228C9424A325C02CF30DBDD15256E0012A718AF2B1D4C5578');
    expect(hex(leaf1)).toBe('49A01736C806987B039B2F0B076989C8166A8119ABDF71E8101018D29C6287B6');
    expect(hex(node)).toBe('737DD30DD854D1FD266D50006B5EFC236B827B8A55F521A10FC2811951F0F70D');
  });
});

describe('buildDvAllocationTree', () => {
  const entry = (b: number, amount: bigint, s: number) => ({
    vkh: new Uint8Array([b]),
    dvAmount: amount,
    salt: new Uint8Array([s]),
  });

  it('single entry — root equals the leaf, empty proof', () => {
    const entries = [entry(0xaa, 100n, 0x01)];
    const tree = buildDvAllocationTree(entries);
    const leaf = hashDvLeaf(entries[0].vkh, entries[0].dvAmount, 0, entries[0].salt);
    expect(hex(tree.root)).toBe(hex(leaf));
    expect(tree.getProof(0)).toEqual([]);
    expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(0))).toBe(true);
  });

  it('two entries — matches the same ground-truth root as the direct hashDvNode call', () => {
    const entries = [entry(0xaa, 100n, 0x01), entry(0xbb, 200n, 0x02)];
    const tree = buildDvAllocationTree(entries);
    expect(hex(tree.root)).toBe('737DD30DD854D1FD266D50006B5EFC236B827B8A55F521A10FC2811951F0F70D');
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, i, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('odd entry count (3) — self-pairing round-trips correctly for every leaf', () => {
    const entries = [entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)];
    const tree = buildDvAllocationTree(entries);
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, i, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('larger, non-power-of-two count (7) — every leaf round-trips', () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry(0x10 + i, BigInt(100 + i), 0x50 + i));
    const tree = buildDvAllocationTree(entries);
    for (let i = 0; i < entries.length; i++) {
      const leaf = hashDvLeaf(entries[i].vkh, entries[i].dvAmount, i, entries[i].salt);
      expect(verifyDvMerkleProof(tree.root, leaf, tree.getProof(i))).toBe(true);
    }
  });

  it('a proof for one leaf does not verify against a different leaf (no cross-leaf forgery)', () => {
    const entries = [entry(0x01, 10n, 0xa1), entry(0x02, 20n, 0xa2), entry(0x03, 30n, 0xa3)];
    const tree = buildDvAllocationTree(entries);
    const wrongLeaf = hashDvLeaf(entries[1].vkh, entries[1].dvAmount, 1, entries[1].salt);
    expect(verifyDvMerkleProof(tree.root, wrongLeaf, tree.getProof(0))).toBe(false);
  });

  it('rejects an empty entry list', () => {
    expect(() => buildDvAllocationTree([])).toThrow(/at least one entry is required/);
  });

  it('rejects an out-of-range proof index', () => {
    const tree = buildDvAllocationTree([entry(0xaa, 1n, 0x01)]);
    expect(() => tree.getProof(1)).toThrow(/index 1 out of range \(0\.\.0\)/);
    expect(() => tree.getProof(-1)).toThrow(/index -1 out of range \(0\.\.0\)/);
  });
});
