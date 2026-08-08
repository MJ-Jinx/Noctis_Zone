// ============================================================================
// Noctis Protocol — CTO Governance: Balance Snapshot Builder (item #12)
// ============================================================================
// Builds cto_governance.compact's balanceSnapshotRoot Merkle tree for a real
// launch: enumerate every real Cardano holder of the launch token, exclude
// wallets the primary sybil filter flags as creator-linked, resolve each
// remaining holder's Cardano address to their registered Midnight CTO
// voter identity (verifyAndDeriveCtoVoterIdentity /
// CtoVoterRegistry, built earlier this session), then hash into the same
// tree structure cto_governance.compact's on-chain castVote verifies
// against.
//
// $50 USD floor DROPPED for this first pass (decided with Jinx,
// 2026-07-19): no real post-graduation DEX price reader exists anywhere in
// this codebase for any tier (every CTO proposal is gated to 30+ days
// post-graduation, by which point a pre-graduation bonding-curve price
// would be actively wrong to use) — see the earlier investigation. Snapshot
// includes every nonzero holder, matching what castVote actually enforces
// on-chain today (weighted by real balance, no floor check exists in the
// circuit itself). Revisit once a real DEX price reader exists.
//
// Sybil defense — primary automatic filter only (item #16's bonded
// challenge contract is the secondary layer, for links this filter
// misses): reuses checkStakeKeyMatch/checkNoDirectAdaFlow from
// eligibility-checker.ts verbatim — same functions the DarkVeil
// eligibility check already uses for the identical "is this wallet
// secretly the creator" question, just applied to CTO voting instead of
// DarkVeil registration.
//
// Holders with no CTO voter registration on record are excluded
// with a real, counted reason (unregisteredCount) — not silently dropped
// — since a holder who never registered simply has no way for the
// governor to know their Midnight voting identity yet.
//
// Split into pure filtering logic (determineSnapshotEntries — trivially
// testable, no network needed) and a thin I/O wrapper
// (buildCtoBalanceSnapshot) that gathers the real per-holder facts and
// calls it — same separation as cto-badge.ts/cto-vote-relayer.ts.
//
// heldSinceTimestamp (anti-whale-takeover fix, 2026-07-28): castVote now
// requires each leaf to commit to when the voter's balance was first held,
// so a wallet can't buy in right before a proposal and vote immediately —
// see cto_governance.compact's minHoldingPeriod. getHeldSinceTimestamp
// below computes this for real, the same way eligibility-checker.ts's
// checkWalletAge computes wallet age: walk the holder's real transaction
// history (oldest first) and find the earliest transaction that actually
// paid this specific asset into their address, via getTxUtxos — the same
// "honest cost of a real per-transaction check" discipline
// checkNoDirectAdaFlow already uses, just keyed on asset receipt instead
// of counterparty address.
// ============================================================================

import { buildBalanceSnapshotTree, type MerkleProofEntry } from '../packages/zk-proofs/src/cto-governance.js';
import type { BlockfrostClient } from './blockfrost-client.js';
import type { CtoVoterRegistry } from './cto-voter-registry.js';
import { checkNoDirectAdaFlow, checkStakeKeyMatch } from './eligibility-checker.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface SnapshotEntry {
  cardanoAddress: string;
  voterKeyHex: string;
  balance: bigint;
  /** Unix seconds this address first received the launch token — see file header. */
  heldSinceTimestamp: bigint;
}

/** One real holder's already-gathered facts — everything determineSnapshotEntries needs, with no I/O of its own. */
export interface HolderFact {
  cardanoAddress: string;
  balance: bigint;
  /** True if the primary sybil filter passed (NOT creator-linked) — same polarity as eligibility-checker.ts's own `eligible` fields. */
  sybilFilterPassed: boolean;
  /** The holder's registered CTO voter pubkey hex, or null if never registered. */
  ctoVoterPubKeyHex: string | null;
  /** Unix seconds this address first received the launch token, or null if it couldn't be determined (treated as ineligible — see determineSnapshotEntries). */
  heldSinceTimestamp: bigint | null;
}

export interface DetermineEntriesResult {
  entries: SnapshotEntry[];
  excludedSybilCount: number;
  unregisteredCount: number;
  /** Holders who otherwise qualified but whose first-acquisition transaction couldn't be found (should not happen for a real current holder — counted so it's visible rather than silently dropped). */
  unresolvedHeldSinceCount: number;
}

/** Pure decision logic — no I/O. */
export function determineSnapshotEntries(facts: HolderFact[]): DetermineEntriesResult {
  const entries: SnapshotEntry[] = [];
  let excludedSybilCount = 0;
  let unregisteredCount = 0;
  let unresolvedHeldSinceCount = 0;

  for (const fact of facts) {
    if (fact.balance <= 0n) continue;
    if (!fact.sybilFilterPassed) {
      excludedSybilCount++;
      continue;
    }
    if (!fact.ctoVoterPubKeyHex) {
      unregisteredCount++;
      continue;
    }
    if (fact.heldSinceTimestamp === null) {
      unresolvedHeldSinceCount++;
      continue;
    }
    entries.push({
      cardanoAddress: fact.cardanoAddress,
      voterKeyHex: fact.ctoVoterPubKeyHex,
      balance: fact.balance,
      heldSinceTimestamp: fact.heldSinceTimestamp,
    });
  }

  return {
    entries,
    excludedSybilCount,
    unregisteredCount,
    unresolvedHeldSinceCount,
  };
}

export interface SnapshotBuildResult extends DetermineEntriesResult {
  root: Uint8Array;
  /** Total distinct addresses Blockfrost reported holding the token, before any filtering. */
  totalHoldersFound: number;
}

export interface BuildSnapshotConfig {
  policyIdHex: string;
  assetNameHex: string;
  creatorAddress: string;
  /** 90 days per CLAUDE.md's own DarkVeil eligibility check #5 (no direct ADA flow lookback) — reused for consistency, same underlying concern. */
  adaFlowLookbackDays?: number;
}

/**
 * Walks `address`'s full transaction history (oldest first, per
 * getAddressTransactionsAll) and returns the block_time of the earliest
 * transaction whose outputs actually pay `asset` into `address`. Returns
 * null if no such transaction is found (shouldn't happen for a real
 * current holder, but the caller must handle it rather than assume).
 */
async function getHeldSinceTimestamp(client: BlockfrostClient, address: string, asset: string): Promise<bigint | null> {
  const txs = await client.getAddressTransactionsAll(address);
  for (const tx of txs) {
    const utxos = await client.getTxUtxos(tx.tx_hash);
    const receivedAsset = utxos.outputs.some(
      (output) => output.address === address && output.amount.some((a) => a.unit === asset),
    );
    if (receivedAsset) {
      return BigInt(tx.block_time);
    }
  }
  return null;
}

/** Real I/O wrapper — enumerates real holders, runs the real sybil checks and registry lookups, then builds the tree via the pure function above. */
export async function buildCtoBalanceSnapshot(
  blockfrostClient: BlockfrostClient,
  registry: CtoVoterRegistry,
  config: BuildSnapshotConfig,
): Promise<SnapshotBuildResult> {
  const asset = config.policyIdHex + config.assetNameHex;
  const holders = await blockfrostClient.getAssetAddresses(asset);

  const facts: HolderFact[] = await Promise.all(
    holders.map(async (holder): Promise<HolderFact> => {
      const balance = BigInt(holder.quantity);
      if (balance <= 0n) {
        return {
          cardanoAddress: holder.address,
          balance,
          sybilFilterPassed: true,
          ctoVoterPubKeyHex: null,
          heldSinceTimestamp: null,
        };
      }

      const [stakeMatch, adaFlow] = await Promise.all([
        checkStakeKeyMatch(blockfrostClient, holder.address, config.creatorAddress),
        checkNoDirectAdaFlow(blockfrostClient, holder.address, config.creatorAddress, config.adaFlowLookbackDays ?? 90),
      ]);
      const sybilFilterPassed = stakeMatch.eligible && adaFlow.eligible;

      const [registration, heldSinceTimestamp] = await Promise.all([
        sybilFilterPassed ? registry.lookup(holder.address) : Promise.resolve(null),
        sybilFilterPassed ? getHeldSinceTimestamp(blockfrostClient, holder.address, asset) : Promise.resolve(null),
      ]);

      return {
        cardanoAddress: holder.address,
        balance,
        sybilFilterPassed,
        ctoVoterPubKeyHex: registration?.ctoVoterPubKeyHex ?? null,
        heldSinceTimestamp,
      };
    }),
  );

  const { entries, excludedSybilCount, unregisteredCount, unresolvedHeldSinceCount } = determineSnapshotEntries(facts);

  const tree = buildBalanceSnapshotTree(
    entries.map((e) => ({
      voterKey: hexToBytes(e.voterKeyHex),
      balance: e.balance,
      heldSinceTimestamp: e.heldSinceTimestamp,
    })),
  );

  return {
    root: tree.root,
    entries,
    excludedSybilCount,
    unregisteredCount,
    unresolvedHeldSinceCount,
    totalHoldersFound: holders.length,
  };
}

/** Builds a specific voter's inclusion proof from an already-built entry list (e.g. for a client's castVote call). */
export function getSnapshotProof(
  entries: SnapshotEntry[],
  cardanoAddress: string,
): { leafIndex: number; proof: MerkleProofEntry[]; balance: bigint } | null {
  const idx = entries.findIndex((e) => e.cardanoAddress === cardanoAddress);
  if (idx === -1) return null;
  const tree = buildBalanceSnapshotTree(
    entries.map((e) => ({
      voterKey: hexToBytes(e.voterKeyHex),
      balance: e.balance,
      heldSinceTimestamp: e.heldSinceTimestamp,
    })),
  );
  return {
    leafIndex: idx,
    proof: tree.getProof(idx),
    balance: entries[idx].balance,
  };
}
