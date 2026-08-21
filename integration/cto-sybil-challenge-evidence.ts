// ============================================================================
// Noctis Zone — CTO Governance: Bonded Sybil Challenge, Evidence Half
// (item #16's remaining piece)
// ============================================================================
// contracts/cardano/validators/cto_sybil_challenge.ak is a bonded,
// governor-adjudicated report — it never independently verifies the
// accusation on-chain (see its own file header). This module builds the
// REAL off-chain evidence a challenger presents: does the accused wallet's
// stake key match the creator's, or has ADA flowed directly between them?
// Reuses checkStakeKeyMatch/checkNoDirectAdaFlow from eligibility-checker.ts
// verbatim — the same functions the primary automatic filter
// (cto-balance-snapshot-builder.ts) already runs at snapshot-build time.
// This module answers a narrower question for a SPECIFIC accused wallet a
// challenger has flagged, not a whole-holder-list sweep.
//
// Split into a pure decision function (evidenceSupportsChallenge — given
// already-gathered check results, trivially testable) and a thin I/O
// wrapper (gatherSybilChallengeEvidence) that runs the real Blockfrost
// checks and resolves the accused wallet's registered Midnight voter
// identity via CtoVoterRegistry — same pure/IO split as every other
// module built this session (cto-badge.ts, cto-vote-relayer.ts,
// cto-balance-snapshot-builder.ts).
//
// A challenge cannot name a wallet that never registered a CTO voter
// identity — cto_sybil_challenge.ak's challenged_voter_key is a raw
// Midnight identity value, not a Cardano credential, so there is nothing
// meaningful to accuse without a real registration on record.
//
// evidence_hash follows the same fixed-field-order-JSON + Blake2b-256
// convention already established by zk-cert-relayer.ts/cto-vote-relayer.ts
// — an audit-trail commitment only, not independently re-verified on-chain
// (by design, per the contract's own header).
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';
import type { BlockfrostClient } from './blockfrost-client.js';
import type { CtoVoterRegistry } from './cto-voter-registry.js';
import {
  type AdaFlowResult,
  checkNoDirectAdaFlow,
  checkStakeKeyMatch,
  type StakeKeyResult,
} from './eligibility-checker.js';

export interface SybilChallengeEvidence {
  accusedCardanoAddress: string;
  challengedVoterKeyHex: string;
  challengedProposalIdHex: string;
  stakeKeyMatch: StakeKeyResult;
  adaFlowMatch: AdaFlowResult;
  gatheredAt: number;
}

/** Pure — no I/O. A challenge is worth submitting only if at least one real link was found; the contract itself doesn't check this, so a challenger submitting weak/no evidence just loses their bond on Rejected. This is a client-side sanity gate, not an on-chain rule. */
export function evidenceSupportsChallenge(
  evidence: Pick<SybilChallengeEvidence, 'stakeKeyMatch' | 'adaFlowMatch'>,
): boolean {
  return !evidence.stakeKeyMatch.eligible || !evidence.adaFlowMatch.eligible;
}

export interface GatherEvidenceParams {
  accusedCardanoAddress: string;
  creatorAddress: string;
  challengedProposalIdHex: string;
  /** The launch whose ballot is being challenged — the accused wallet's voter
   *  identity only exists relative to it. */
  launchIdHex: string;
  adaFlowLookbackDays?: number;
}

/** Real I/O wrapper. Returns null if the accused wallet never registered a CTO voter identity — nothing to name in the datum's challenged_voter_key. */
export async function gatherSybilChallengeEvidence(
  blockfrostClient: BlockfrostClient,
  registry: CtoVoterRegistry,
  params: GatherEvidenceParams,
): Promise<SybilChallengeEvidence | null> {
  const registration = await registry.lookup(params.accusedCardanoAddress, params.launchIdHex);
  if (!registration) return null;

  const [stakeKeyMatch, adaFlowMatch] = await Promise.all([
    checkStakeKeyMatch(blockfrostClient, params.accusedCardanoAddress, params.creatorAddress),
    checkNoDirectAdaFlow(
      blockfrostClient,
      params.accusedCardanoAddress,
      params.creatorAddress,
      params.adaFlowLookbackDays ?? 90,
    ),
  ]);

  return {
    accusedCardanoAddress: params.accusedCardanoAddress,
    challengedVoterKeyHex: registration.ctoVoterPubKeyHex,
    challengedProposalIdHex: params.challengedProposalIdHex,
    stakeKeyMatch,
    adaFlowMatch,
    gatheredAt: Math.floor(Date.now() / 1000),
  };
}

/** Same fixed-field-order-JSON canonicalization idiom as zk-cert-relayer.ts/cto-vote-relayer.ts, so the same evidence always hashes identically regardless of object key insertion order. */
function canonicalizeEvidence(evidence: SybilChallengeEvidence): Uint8Array {
  const ordered = {
    accusedCardanoAddress: evidence.accusedCardanoAddress,
    challengedVoterKeyHex: evidence.challengedVoterKeyHex,
    challengedProposalIdHex: evidence.challengedProposalIdHex,
    stakeKeyMatch: {
      eligible: evidence.stakeKeyMatch.eligible,
      registrantStakeAddress: evidence.stakeKeyMatch.registrantStakeAddress,
      creatorStakeAddress: evidence.stakeKeyMatch.creatorStakeAddress,
    },
    adaFlowMatch: {
      eligible: evidence.adaFlowMatch.eligible,
      violatingTxHash: evidence.adaFlowMatch.violatingTxHash,
    },
    gatheredAt: evidence.gatheredAt,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export function hashEvidence(evidence: SybilChallengeEvidence): Uint8Array {
  return blake2b(canonicalizeEvidence(evidence), { dkLen: 32 });
}
