// Mirrors the `pure circuit` / `circuit` helpers in
// contracts/midnight/staking_pool.compact (2026-07-14).

import { bytes32Type, hashDomainKey, pad32, persistentHash, structType, uintType } from './compact-types.js';

/** staking_pool.compact — `deriveUserPublicKey`. */
export function deriveUserPublicKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:staking:user:pk:v1', secretKeyBytes);
}

/** staking_pool.compact — `deriveGovernorKey`. */
export function deriveGovernorKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:staking:governor:pk:v1', secretKeyBytes);
}

/** staking_pool.compact — `deriveCreatorKey`. */
export function deriveCreatorKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:staking:creator:pk:v1', secretKeyBytes);
}

// ============================================================================
// Shared fixed-depth Merkle tree builder
// ============================================================================
//
// Same two padding conventions as cto-governance.ts's buildBalanceSnapshotTree
// (LEAF padding to the next power of two, DEPTH padding to a fixed
// TREE_DEPTH=20 — must match staking_pool.compact's `Vector<20,
// MerkleProofEntry>` witness types exactly). Parameterized here since
// staking_pool.compact has TWO independent trees (stake snapshot, reward
// snapshot) with different leaf/node domains but identical tree shape.

const TREE_DEPTH = 20;

export interface MerkleProofEntry {
  sibling: Uint8Array;
  goesLeft: boolean;
}

export interface SnapshotTree {
  root: Uint8Array;
  getProof(leafIndex: number): MerkleProofEntry[];
}

function buildSnapshotTree(
  leaves: Uint8Array[],
  padSibling: Uint8Array,
  emptyLeaf: Uint8Array,
  hashNode: (left: Uint8Array, right: Uint8Array) => Uint8Array,
): SnapshotTree {
  if (leaves.length === 0) {
    throw new Error('buildSnapshotTree: at least one entry is required');
  }

  let size = 1;
  while (size < leaves.length) size *= 2;
  const paddedLeaves = leaves.slice();
  while (paddedLeaves.length < size) paddedLeaves.push(emptyLeaf);

  const realDepth = Math.log2(size);

  const levels: Uint8Array[][] = [paddedLeaves];
  let current = paddedLeaves;
  for (let d = 0; d < realDepth; d++) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashNode(current[i], current[i + 1]));
    }
    levels.push(next);
    current = next;
  }
  const realRoot = current[0];

  let root = realRoot;
  for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
    root = hashNode(root, padSibling);
  }

  function getProof(leafIndex: number): MerkleProofEntry[] {
    if (leafIndex < 0 || leafIndex >= leaves.length) {
      throw new Error(`getProof: leafIndex ${leafIndex} out of range (0..${leaves.length - 1})`);
    }
    const proofEntries: MerkleProofEntry[] = [];
    let idx = leafIndex;
    for (let d = 0; d < realDepth; d++) {
      const levelNodes = levels[d];
      const isLeft = idx % 2 === 0;
      const siblingIdx = isLeft ? idx + 1 : idx - 1;
      proofEntries.push({ sibling: levelNodes[siblingIdx], goesLeft: isLeft });
      idx = Math.floor(idx / 2);
    }
    for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
      proofEntries.push({ sibling: padSibling, goesLeft: true });
    }
    return proofEntries;
  }

  return { root, getProof };
}

// ============================================================================
// Stake-snapshot tree — (stakerKey, stakedAmount) leaves
// ============================================================================

const STAKE_PAD_SIBLING = pad32('noctis:staking:stake:pad:v1');
const STAKE_EMPTY_LEAF = pad32('noctis:staking:stake:empty:v1');
const STAKE_LEAF_DOMAIN = pad32('noctis:staking:stake:leaf:v1');
const STAKE_NODE_DOMAIN = pad32('noctis:staking:stake:node:v1');

interface StakeLeafInput {
  domain: Uint8Array;
  stakerKey: Uint8Array;
  stakedAmount: bigint;
}

const stakeLeafInputType = structType<StakeLeafInput>([
  ['domain', bytes32Type],
  ['stakerKey', bytes32Type],
  ['stakedAmount', uintType(128)],
]);

/** staking_pool.compact's `verifyStakeMembership` leaf hash. */
export function hashStakeLeaf(stakerKey: Uint8Array, stakedAmount: bigint): Uint8Array {
  return persistentHash(stakeLeafInputType, { domain: STAKE_LEAF_DOMAIN, stakerKey, stakedAmount });
}

interface StakeNodeInput {
  domain: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

const stakeNodeInputType = structType<StakeNodeInput>([
  ['domain', bytes32Type],
  ['left', bytes32Type],
  ['right', bytes32Type],
]);

/** staking_pool.compact's stake-tree node hash. */
export function hashStakeNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return persistentHash(stakeNodeInputType, { domain: STAKE_NODE_DOMAIN, left, right });
}

/**
 * Builds a stake-snapshot tree from real `(stakerKey, stakedAmount)` pairs —
 * the governor calls this off-chain from real stake/unstake events observed
 * on bonding_curve.compact's public ledger, then publishes the resulting
 * `root` via `publishStakeSnapshot`.
 */
export function buildStakeSnapshotTree(entries: Array<{ stakerKey: Uint8Array; stakedAmount: bigint }>): SnapshotTree {
  const leaves = entries.map((e) => hashStakeLeaf(e.stakerKey, e.stakedAmount));
  return buildSnapshotTree(leaves, STAKE_PAD_SIBLING, STAKE_EMPTY_LEAF, hashStakeNode);
}

// ============================================================================
// Reward tree — (stakerKey, cumulativeAmount) leaves
// ============================================================================

const REWARD_PAD_SIBLING = pad32('noctis:staking:reward:pad:v1');
const REWARD_EMPTY_LEAF = pad32('noctis:staking:reward:empty:v1');
const REWARD_LEAF_DOMAIN = pad32('noctis:staking:reward:leaf:v1');
const REWARD_NODE_DOMAIN = pad32('noctis:staking:reward:node:v1');

interface RewardLeafInput {
  domain: Uint8Array;
  stakerKey: Uint8Array;
  cumulativeAmount: bigint;
}

const rewardLeafInputType = structType<RewardLeafInput>([
  ['domain', bytes32Type],
  ['stakerKey', bytes32Type],
  ['cumulativeAmount', uintType(128)],
]);

/** staking_pool.compact's `verifyRewardMembership` leaf hash. */
export function hashRewardLeaf(stakerKey: Uint8Array, cumulativeAmount: bigint): Uint8Array {
  return persistentHash(rewardLeafInputType, { domain: REWARD_LEAF_DOMAIN, stakerKey, cumulativeAmount });
}

interface RewardNodeInput {
  domain: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

const rewardNodeInputType = structType<RewardNodeInput>([
  ['domain', bytes32Type],
  ['left', bytes32Type],
  ['right', bytes32Type],
]);

/** staking_pool.compact's reward-tree node hash. */
export function hashRewardNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return persistentHash(rewardNodeInputType, { domain: REWARD_NODE_DOMAIN, left, right });
}

/**
 * Builds a reward tree from real `(stakerKey, cumulativeAmount)` pairs — the
 * governor computes this off-chain from the platform's daily pro-rata
 * emission formula, then publishes the resulting `root` via
 * `publishRewardRoot`. `cumulativeAmount` is the TOTAL earned as of this
 * snapshot, not a delta — `claimRewards` pays out the difference from what
 * the staker has already claimed.
 */
export function buildRewardTree(entries: Array<{ stakerKey: Uint8Array; cumulativeAmount: bigint }>): SnapshotTree {
  const leaves = entries.map((e) => hashRewardLeaf(e.stakerKey, e.cumulativeAmount));
  return buildSnapshotTree(leaves, REWARD_PAD_SIBLING, REWARD_EMPTY_LEAF, hashRewardNode);
}
