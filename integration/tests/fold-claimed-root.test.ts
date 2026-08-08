// A reward leaf carries what THIS root pays, not a running total, because the
// pool records only who has claimed against the current root — one bit each —
// and not how much each has drawn.
//
// That makes the running "already paid" total an off-chain quantity, and
// foldClaimedRoot is how it is maintained: fold each published root against
// the nullifier the chain shows afterwards. These pin the property the whole
// scheme rests on — an unclaimed amount is not lost, it simply reappears,
// because nothing is added for a bit that was never set.

import { describe, expect, it } from 'vitest';

import { foldClaimedRoot } from '../staking-reward-tree-builder.js';

const A = 'aa'.repeat(28);
const B = 'bb'.repeat(28);
const C = 'cc'.repeat(28);

const entries = [
  { stakerVkh: A, payoutAmount: 100n },
  { stakerVkh: B, payoutAmount: 250n },
  { stakerVkh: C, payoutAmount: 7n },
];

describe('foldClaimedRoot', () => {
  it('credits only the stakers whose bit is set', () => {
    // Bits 0 and 2 set, bit 1 clear: 1010_0000.
    const paid = foldClaimedRoot(entries, 'a0');
    expect(paid.get(A)).toBe(100n);
    expect(paid.get(C)).toBe(7n);
    expect(paid.has(B)).toBe(false);
  });

  it('credits nobody when nothing was claimed', () => {
    expect(foldClaimedRoot(entries, '00').size).toBe(0);
  });

  it('accumulates across roots rather than replacing', () => {
    const first = foldClaimedRoot(entries, '80'); // only A claimed
    const second = foldClaimedRoot(entries, '80', first); // A claimed again
    expect(second.get(A)).toBe(200n);
  });

  // The property that makes an unclaimed reward safe: it is not written off,
  // it is simply never added, so the next root's delta still includes it.
  it('leaves an unclaimed staker owed exactly as much as before', () => {
    const paid = foldClaimedRoot(entries, '80');
    expect(paid.get(B) ?? 0n).toBe(0n);
  });

  it('does not mutate the map it was given', () => {
    const before = new Map([[A, 5n]]);
    foldClaimedRoot(entries, 'ff', before);
    expect(before.get(A)).toBe(5n);
    expect(before.size).toBe(1);
  });

  // A nullifier that cannot address every entry is not this root's nullifier,
  // and silently treating the missing bits as unclaimed would pay those
  // stakers twice.
  it('refuses a nullifier too small for the entry list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      stakerVkh: i.toString(16).padStart(2, '0').repeat(28),
      payoutAmount: 1n,
    }));
    expect(() => foldClaimedRoot(many, '00')).toThrow(/does not belong to this entry list/);
  });
});
