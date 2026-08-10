// Mirrors the `pure circuit` helpers in contracts/midnight/cto_governance.compact.

import {
  bytes32Type,
  hashDomainKey,
  hashDomainKeyScoped,
  pad32,
  persistentHash,
  structType,
  uintType,
} from './compact-types.js';

/** cto_governance.compact:158 — `deriveUserPublicKey`. */
export function deriveUserPublicKey(secretKeyBytes: Uint8Array, launchId: Uint8Array): Uint8Array {
  return hashDomainKeyScoped('noctis:cto:user:pk:v1', secretKeyBytes, launchId);
}

/** cto_governance.compact:167 — `deriveGovernorKey`. */
export function deriveGovernorKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:cto:governor:pk:v1', secretKeyBytes);
}

interface ProposalIdInput {
  launchId: Uint8Array;
  proposerKey: Uint8Array;
  descriptionHash: Uint8Array;
  timestamp: bigint;
}

const proposalIdInputType = structType<ProposalIdInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['launchId', bytes32Type],
  ['proposerKey', bytes32Type],
  ['descriptionHash', bytes32Type],
  ['timestamp', uintType(64)],
]);

/** `computeProposalId` — the id `createProposal` returns and every later vote names. */
export function computeProposalId(input: ProposalIdInput): Uint8Array {
  return persistentHash(proposalIdInputType, {
    domain: pad32('noctis:cto:proposal:id:v1'),
    ...input,
  });
}

interface VoteNullifierInput {
  /** The voter's SECRET key bytes — not their derived public key. */
  voterSecret: Uint8Array;
  launchId: Uint8Array;
  proposalId: Uint8Array;
}

const voteNullifierInputType = structType<VoteNullifierInput & { domain: Uint8Array }>([
  ['domain', bytes32Type],
  ['voterSecret', bytes32Type],
  ['launchId', bytes32Type],
  ['proposalId', bytes32Type],
]);

/**
 * `computeVoteNullifier` — prevents double-voting on the same proposal.
 *
 * Takes the voter's secret, so only that voter can produce it. See the
 * circuit's own comment for why a public-key-derived nullifier let anyone
 * precompute a holder's value and recognise their ballot on sight.
 */
export function computeVoteNullifier(input: VoteNullifierInput): Uint8Array {
  return persistentHash(voteNullifierInputType, {
    domain: pad32('noctis:cto:vote:nullifier:v1'),
    ...input,
  });
}

// ============================================================================
// Balance-snapshot Merkle tree (the design requirement security-audit fix, 2026-07-11)
// ============================================================================
//
// Mirrors `castVote`'s balance-proof verification exactly — see that
// circuit's comment for the full design rationale (governor-published
// balance root; vote weight is proven in-circuit, never caller-supplied). Same
// two padding conventions as packages/zk-proofs/src/eligibility-gate.ts's
// `buildAllowlistTree`, both must match the on-chain side byte-for-byte:
//
//  1. LEAF padding: the real leaf array is padded up to the next power of
//     two with EMPTY_LEAF, so a normal balanced binary tree can be built
//     over it (real voter counts won't be exact powers of two).
//  2. DEPTH padding: `castVote`'s `fold` always walks exactly TREE_DEPTH
//     levels — there's no early exit in a ZK circuit. So after building the
//     real tree (to whatever depth actually fits the entry count),
//     (TREE_DEPTH - realDepth) more levels are appended on top, each
//     hashing the running root against a fixed PAD_SIBLING with
//     goesLeft=true. Every proof this module returns is always exactly
//     TREE_DEPTH entries.
//
// Depth reduced 32 -> 20 (2026-07-12): every proof pays for
// TREE_DEPTH hash operations regardless of real holder count, so depth is
// a direct proving-cost lever, not just a capacity ceiling. 2^20
// (1,048,576) token holders is far beyond any realistic single launch's
// voter base, for 37.5% fewer hash operations per proof than the original
// 32. Must match cto_governance.compact's `Vector<20, MerkleProofEntry>`
// witness type exactly.

const TREE_DEPTH = 20;
const PAD_SIBLING = pad32('noctis:cto:balance:pad:v1');
const EMPTY_LEAF = pad32('noctis:cto:balance:empty-leaf:v1');
const BALANCE_LEAF_DOMAIN = pad32('noctis:cto:balance:leaf:v1');
const BALANCE_NODE_DOMAIN = pad32('noctis:cto:balance:node:v1');

interface BalanceLeafInput {
  domain: Uint8Array;
  voterKey: Uint8Array;
  balance: bigint;
  heldSinceTimestamp: bigint;
}

const balanceLeafInputType = structType<BalanceLeafInput>([
  ['domain', bytes32Type],
  ['voterKey', bytes32Type],
  ['balance', uintType(128)],
  ['heldSinceTimestamp', uintType(64)],
]);

/**
 * cto_governance.compact's `castVote` leaf hash — binds a real balance AND
 * the timestamp it's been held since to the voter's own identity.
 * Anti-whale-takeover fix (2026-07-28): `heldSinceTimestamp` lets `castVote`
 * enforce `minHoldingPeriod` (30 days) without a separate lookup — a voter
 * can't manufacture a fresher balance and vote with it immediately, since the
 * leaf itself commits to when that balance was first held.
 */
export function hashBalanceLeaf(voterKey: Uint8Array, balance: bigint, heldSinceTimestamp: bigint): Uint8Array {
  return persistentHash(balanceLeafInputType, { domain: BALANCE_LEAF_DOMAIN, voterKey, balance, heldSinceTimestamp });
}

interface BalanceNodeInput {
  domain: Uint8Array;
  left: Uint8Array;
  right: Uint8Array;
}

const balanceNodeInputType = structType<BalanceNodeInput>([
  ['domain', bytes32Type],
  ['left', bytes32Type],
  ['right', bytes32Type],
]);

/** cto_governance.compact's `hashBalanceNode` — one Merkle tree node hash. */
export function hashBalanceNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return persistentHash(balanceNodeInputType, { domain: BALANCE_NODE_DOMAIN, left, right });
}

export interface MerkleProofEntry {
  sibling: Uint8Array;
  goesLeft: boolean;
}

export interface BalanceSnapshotTree {
  /** The 32-byte value to pass to `updateBalanceSnapshot`. */
  root: Uint8Array;
  /** Always returns exactly TREE_DEPTH (20) entries, matching the circuit's fixed-depth witness. */
  getProof(leafIndex: number): MerkleProofEntry[];
}

/**
 * Builds a balance-snapshot tree from real `(voterKey, balance,
 * heldSinceTimestamp)` triples — the governor calls this off-chain from a
 * real snapshot of bonding_curve.compact's `balances` map (cross-referenced
 * against on-chain history for `heldSinceTimestamp`, see
 * cto-balance-snapshot-builder.ts), then publishes the resulting `root` via
 * `updateBalanceSnapshot`. Each entry's leaf is `hashBalanceLeaf(voterKey,
 * balance, heldSinceTimestamp)`, computed here so callers only ever pass
 * real identity/balance/timestamp triples, never a pre-hashed leaf that
 * could get the domain wrong.
 */
export function buildBalanceSnapshotTree(
  entries: Array<{ voterKey: Uint8Array; balance: bigint; heldSinceTimestamp: bigint }>,
): BalanceSnapshotTree {
  if (entries.length === 0) {
    throw new Error('buildBalanceSnapshotTree: at least one entry is required');
  }

  const leaves = entries.map((e) => hashBalanceLeaf(e.voterKey, e.balance, e.heldSinceTimestamp));

  let size = 1;
  while (size < leaves.length) size *= 2;
  const paddedLeaves = leaves.slice();
  while (paddedLeaves.length < size) paddedLeaves.push(EMPTY_LEAF);

  const realDepth = Math.log2(size);

  const levels: Uint8Array[][] = [paddedLeaves];
  let current = paddedLeaves;
  for (let d = 0; d < realDepth; d++) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hashBalanceNode(current[i], current[i + 1]));
    }
    levels.push(next);
    current = next;
  }
  const realRoot = current[0];

  let root = realRoot;
  for (let i = 0; i < TREE_DEPTH - realDepth; i++) {
    root = hashBalanceNode(root, PAD_SIBLING);
  }

  function getProof(leafIndex: number): MerkleProofEntry[] {
    if (leafIndex < 0 || leafIndex >= entries.length) {
      throw new Error(`getProof: leafIndex ${leafIndex} out of range (0..${entries.length - 1})`);
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
      proofEntries.push({ sibling: PAD_SIBLING, goesLeft: true });
    }
    return proofEntries;
  }

  return { root, getProof };
}
