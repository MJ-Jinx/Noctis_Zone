// A tree too big to prove is refused, rather than built and handed out.
//
// WHY THIS EXISTS
// Every one of these trees is a fixed depth, because a ZK circuit's proof
// walk has no early exit — each builder pads a real tree up to that depth
// so `getProof` always returns exactly as many entries as the circuit
// reads. Past capacity that padding runs a negative number of times, so
// the padding loop simply does not execute and the proof comes back LONGER
// than the circuit's vector. Nothing said so: the builders documented
// "always exactly TREE_DEPTH entries" and stopped being able to keep that
// promise without complaining.
//
// The consequence is worse than a failed proof. Whoever runs out of room
// is a real participant — a registrant who cannot register, a holder whose
// balance cannot vote — and the tree would still have a valid-looking root
// to publish. Refusing at build time means the party assembling the tree
// sees the problem while they can still act on it.
//
// These tests are cheap despite the sizes involved: the check is the first
// thing each builder does, so nothing is hashed before it throws, and the
// arrays below share one leaf reference rather than allocating real ones.

import { describe, expect, it } from 'vitest';
import { buildBalanceSnapshotTree } from '../src/cto-governance.js';
import { buildAllowlistTree, buildRegistrantTree, hashAllowlistLeaf } from '../src/eligibility-gate.js';
import { buildRewardTree, buildStakeSnapshotTree } from '../src/staking-pool.js';

// Every tree is depth 20.
//
// Reducing it was investigated and rejected on measurement. The reasoning
// was that each level costs proving work every proof pays for whatever the
// real population is, so a shallower tree would be materially cheaper for
// the participant who downloads the prover key. Built both ways with real
// ZK keys, in one shell so neither reading could be a stale directory:
// eligibility_gate is 194 MB either way, and its four Merkle-folding
// circuits differ by about 30 KB across four levels — roughly 7.5 KB a
// level, not the megabytes assumed. PLONK key size is set by the circuit
// rounded up to a power of two, and a handful of fold levels does not
// cross a boundary.
//
// So depth costs capacity and buys almost nothing, and capacity is the
// side with a real failure: a registrant who cannot register, a holder
// whose balance cannot vote. Depth stays where it is; the guard below is
// what makes that safe.
const DARKVEIL_DEPTH = 20;
const HOLDER_DEPTH = 20;

const LEAF = hashAllowlistLeaf(new Uint8Array(32).fill(7));

/** `count` entries sharing one leaf reference — the guard never reads them. */
function repeated<T>(value: T, count: number): T[] {
  return new Array<T>(count).fill(value);
}

const BUILDERS = [
  {
    name: 'buildAllowlistTree',
    depth: DARKVEIL_DEPTH,
    overCapacity: () => buildAllowlistTree(repeated(LEAF, 2 ** DARKVEIL_DEPTH + 1)),
    atCapacityIsAllowed: () => buildAllowlistTree(repeated(LEAF, 1)),
  },
  {
    name: 'buildRegistrantTree',
    depth: DARKVEIL_DEPTH,
    overCapacity: () => buildRegistrantTree(repeated(LEAF, 2 ** DARKVEIL_DEPTH + 1)),
    atCapacityIsAllowed: () => buildRegistrantTree(repeated(LEAF, 1)),
  },
  {
    name: 'buildBalanceSnapshotTree',
    depth: HOLDER_DEPTH,
    overCapacity: () =>
      buildBalanceSnapshotTree(
        repeated({ voterKey: LEAF, balance: 1n, heldSinceTimestamp: 0n }, 2 ** HOLDER_DEPTH + 1),
      ),
    atCapacityIsAllowed: () => buildBalanceSnapshotTree([{ voterKey: LEAF, balance: 1n, heldSinceTimestamp: 0n }]),
  },
  {
    name: 'buildStakeSnapshotTree',
    depth: HOLDER_DEPTH,
    overCapacity: () => buildStakeSnapshotTree(repeated({ stakerKey: LEAF, stakedAmount: 1n }, 2 ** HOLDER_DEPTH + 1)),
    atCapacityIsAllowed: () => buildStakeSnapshotTree([{ stakerKey: LEAF, stakedAmount: 1n }]),
  },
  {
    name: 'buildRewardTree',
    depth: HOLDER_DEPTH,
    overCapacity: () => buildRewardTree(repeated({ stakerKey: LEAF, cumulativeAmount: 1n }, 2 ** HOLDER_DEPTH + 1)),
    atCapacityIsAllowed: () => buildRewardTree([{ stakerKey: LEAF, cumulativeAmount: 1n }]),
  },
] as const;

describe('every fixed-depth tree refuses more leaves than it can prove', () => {
  for (const { name, depth, overCapacity, atCapacityIsAllowed } of BUILDERS) {
    it(`${name} refuses one leaf past its depth-${depth} capacity`, () => {
      expect(overCapacity).toThrow(new RegExp(`exceeds the ${2 ** depth} a depth-${depth} tree can prove`));
    });

    it(`${name} still builds an ordinary tree`, () => {
      // Without this, a builder that threw unconditionally would satisfy
      // the assertion above — which is the failure mode a capacity guard
      // is most likely to have.
      expect(atCapacityIsAllowed).not.toThrow();
    });
  }
});

describe('the proof length the circuits depend on', () => {
  it('is exactly the tree depth at every size, not just round ones', () => {
    // The property the guard protects. A proof shorter or longer than the
    // circuit's vector cannot be verified, and sizes that are not powers of
    // two are where the two padding conventions interact.
    for (const size of [1, 2, 3, 5, 8, 9, 17, 100, 1000]) {
      const tree = buildAllowlistTree(repeated(LEAF, size));
      for (const index of [0, Math.floor(size / 2), size - 1]) {
        expect(tree.getProof(index)).toHaveLength(DARKVEIL_DEPTH);
      }
    }
  });
});
