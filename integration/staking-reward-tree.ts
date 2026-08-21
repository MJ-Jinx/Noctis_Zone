// ============================================================================
// Noctis Zone — Staking Rewards Pool Merkle reward tree
// ============================================================================
// Mirrors contracts/cardano/validators/staking_pool.ak's hash_reward_leaf/
// hash_reward_node/verify_reward_merkle_proof EXACTLY — this is the tree
// ClaimRewards verifies a staker's cumulative-reward claim against. A
// DIFFERENT construction from packages/zk-proofs/src/staking-pool.ts's
// buildRewardTree, which targets Tier C's Midnight/Compact contract (fixed
// TREE_DEPTH=20 padding for ZK-circuit compatibility, Compact's
// persistentHash domain-separation scheme) — Aiken has no such constraint
// here (verify_reward_merkle_proof walks a variable-length list.foldl
// proof, an ordinary Plutus validator, not a ZK circuit), so this is a
// plain variable-depth tree, same shape as integration/dv-allocation-
// tree.ts's buildDvAllocationTree (which this file's structure mirrors).
//
// VERIFIED, not assumed (2026-07-22): hashRewardLeaf/hashRewardNode's exact
// byte construction was cross-checked against real ground truth from a
// temporary trace-based Aiken test run through the real compiler
// (hash_reward_leaf(#"aa", 100) / hash_reward_leaf(#"bb", 200) /
// hash_reward_node(leaf0, leaf1)) — this Node-side computation reproduced
// the exact same 32-byte blake2b_256 outputs, byte-for-byte. The temporary
// test was never added to the real .ak file's test suite (removed after
// use, same convention dv-allocation-tree.ts's own header documents).
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';

export interface MerkleProofStep {
  sibling: Uint8Array;
  goesLeft: boolean;
}

export interface RewardEntry {
  /** Staker's Cardano VerificationKeyHash. */
  stakerVkh: Uint8Array;
  /**
   * What THIS root pays this staker — a delta, not a running total.
   *
   * The pool records who has claimed against the current root as one bit
   * each, not how much each has drawn, so a leaf has to carry the amount
   * outright. The governor derives it as accrued-to-date minus what the chain
   * shows already paid out; a staker who does not claim under one root simply
   * has it reappear in the next, because the subtrahend did not move.
   */
  payoutAmount: bigint;
}

export interface RewardTree {
  /** The 32-byte value to submit as PublishRewardRoot's new_root. */
  root: Uint8Array;
  /** Real proof length varies with tree size — no fixed-depth padding, matching staking_pool.ak's variable-length list.foldl verifier. */
  getProof(index: number): MerkleProofStep[];
}

function toBigEndian16(n: bigint): Uint8Array {
  if (n < 0n || n > 2n ** 128n - 1n) {
    throw new Error(`toBigEndian16: ${n} does not fit in 16 bytes`);
  }
  const out = new Uint8Array(16);
  let v = n;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function toBigEndian4(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error(`toBigEndian4: ${n} is not a 4-byte unsigned integer`);
  }
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/**
 * `hash_reward_leaf` — `staker_vkh || payout_amount_16be || leaf_index_4be`,
 * blake2b_256. No salt (unlike DarkVeil allocation leaves): reward amounts
 * carry no privacy requirement here.
 *
 * The index is hashed IN so that a proof issued for one bit of the pool's
 * nullifier cannot be presented against another — otherwise a staker could
 * spend somebody else's bit and leave their own free to claim again.
 */
export function hashRewardLeaf(stakerVkh: Uint8Array, payoutAmount: bigint, leafIndex: number): Uint8Array {
  return blake2b(concatBytes(stakerVkh, toBigEndian16(payoutAmount), toBigEndian4(leafIndex)), { dkLen: 32 });
}

/** staking_pool.ak:152 — `hash_reward_node`. `left || right`, blake2b_256 — no domain-separation prefix, matched exactly as coded on-chain. */
export function hashRewardNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return blake2b(concatBytes(left, right), { dkLen: 32 });
}

/**
 * Builds a plain, variable-depth binary Merkle tree over real reward
 * leaves. No fixed-depth padding — an odd node at any level is promoted by
 * self-pairing (Bitcoin-style), same convention as buildDvAllocationTree.
 */
export function buildRewardTree(entries: RewardEntry[]): RewardTree {
  if (entries.length === 0) {
    throw new Error('buildRewardTree: at least one entry is required');
  }

  // Position in this array IS the staker's bit in the pool's nullifier, which
  // is why it is hashed into the leaf.
  const leaves = entries.map((e, i) => hashRewardLeaf(e.stakerVkh, e.payoutAmount, i));

  const levels: Uint8Array[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(hashRewardNode(current[i], current[i + 1]));
      } else {
        next.push(hashRewardNode(current[i], current[i]));
      }
    }
    levels.push(next);
    current = next;
  }
  const root = current[0];

  function getProof(index: number): MerkleProofStep[] {
    if (index < 0 || index >= entries.length) {
      throw new Error(`getProof: index ${index} out of range (0..${entries.length - 1})`);
    }
    const proof: MerkleProofStep[] = [];
    let idx = index;
    for (let d = 0; d < levels.length - 1; d++) {
      const level = levels[d];
      const isRightChild = idx % 2 === 1;
      const siblingIdx = isRightChild ? idx - 1 : Math.min(idx + 1, level.length - 1);
      proof.push({ sibling: level[siblingIdx], goesLeft: isRightChild });
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  return { root, getProof };
}

/** Re-implements staking_pool.ak's verify_reward_merkle_proof in TS — self-checks a built tree/proof before ever publishing it. */
export function verifyRewardMerkleProof(root: Uint8Array, leaf: Uint8Array, proof: MerkleProofStep[]): boolean {
  let computed = leaf;
  for (const step of proof) {
    computed = step.goesLeft ? hashRewardNode(step.sibling, computed) : hashRewardNode(computed, step.sibling);
  }
  return computed.length === root.length && computed.every((b, i) => b === root[i]);
}

/**
 * The cleared nullifier a root of this size must be published with: one bit
 * per entry, rounded up to whole bytes, every bit zero.
 *
 * Sized from the tree itself rather than passed alongside it, because a map
 * too small leaves the highest leaf indices with no bit to claim against.
 */
export function clearedNullifierHex(entryCount: number): string {
  if (!Number.isInteger(entryCount) || entryCount <= 0) {
    throw new Error(`clearedNullifierHex: entryCount must be a positive whole number, got ${entryCount}`);
  }
  return '00'.repeat(Math.ceil(entryCount / 8));
}
