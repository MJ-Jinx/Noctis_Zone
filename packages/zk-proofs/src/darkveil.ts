// Mirrors the `pure circuit` helpers in contracts/midnight/darkveil.compact.
// Domain strings and struct field orders are copied verbatim from that file
// — do not change either without updating the contract to match.
//
// STALE FILE WARNING (2026-07-15): the standalone darkveil.compact this
// file's doc comments cite no longer exists — its logic was merged into
// eligibility_gate.compact (Tier B) and bonding_curve.compact (Tier C)
// well before this comment was written. computeBuyCommit/computeNullifier/
// computeCertHash below are still correct (they only hash caller-supplied
// bytes, no identity derivation of their own) and safe to keep using.
// deriveUserPublicKey/deriveGovernorKey below are NOT — see each function's
// own comment for why using them for a real buyerKey silently produces a
// hash that never matches on-chain.

import { bytes32Type, hashDomainKey, persistentHash, structType, uintType } from './compact-types.js';

/**
 * @deprecated STALE DOMAIN, DO NOT USE for a real buyerKey
 * (2026-07-15). Hashes under the pre-merge domain
 * 'noctis:darkveil:user:pk:v1', which no longer matches either deployed
 * contract — both eligibility_gate.compact (Tier B) and
 * bonding_curve.compact (Tier C) derive identity under the unified
 * 'noctis:user:pk:v1' domain today (see either file's own "Identity note").
 * Using THIS function's output as computeBuyCommit's buyerKey produces a
 * commitment hash that will never match what revealBuyCommit recomputes
 * on-chain — every reveal would fail. Use
 * contracts/midnight/witnesses.ts's real deriveUserPublicKey(sk,
 * DOMAINS.CURVE_USER, launchId) instead (same function also correctly
 * covers Tier B, since ELIGIBILITY_USER and CURVE_USER are the same
 * string). The launch ID is required: identity is scoped per launch.
 */
export function deriveUserPublicKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:darkveil:user:pk:v1', secretKeyBytes);
}

/**
 * @deprecated STALE DOMAIN, DO NOT USE (2026-07-15) — same issue as
 * deriveUserPublicKey above, for the governor identity instead. Use
 * contracts/midnight/witnesses.ts's real deriveRoleKey(sk,
 * DOMAINS.CURVE_GOVERNOR) — a governor is one party across every launch,
 * so its key is not launch-scoped.
 */
export function deriveGovernorKey(secretKeyBytes: Uint8Array): Uint8Array {
  return hashDomainKey('noctis:darkveil:governor:pk:v1', secretKeyBytes);
}

interface BuyCommitInput {
  buyerKey: Uint8Array;
  launchId: Uint8Array;
  tokenAmount: bigint;
  pricePerToken: bigint;
  nonce: Uint8Array;
}

const buyCommitInputType = structType<BuyCommitInput>([
  ['buyerKey', bytes32Type],
  ['launchId', bytes32Type],
  ['tokenAmount', uintType(128)],
  ['pricePerToken', uintType(128)],
  ['nonce', bytes32Type],
]);

/** darkveil.compact:161 — `computeBuyCommit`. */
export function computeBuyCommit(input: BuyCommitInput): Uint8Array {
  return persistentHash(buyCommitInputType, input);
}

interface NullifierInput {
  buyerKey: Uint8Array;
  launchId: Uint8Array;
}

const nullifierInputType = structType<NullifierInput>([
  ['buyerKey', bytes32Type],
  ['launchId', bytes32Type],
]);

/** darkveil.compact:179 — `computeNullifier`. */
export function computeNullifier(input: NullifierInput): Uint8Array {
  return persistentHash(nullifierInputType, input);
}

interface CertHashInput {
  launchId: Uint8Array;
  totalParticipants: bigint;
  totalTokensAllocated: bigint;
  totalRaised: bigint;
  closeTimestamp: bigint;
}

const certHashInputType = structType<CertHashInput>([
  ['launchId', bytes32Type],
  ['totalParticipants', uintType(64)],
  ['totalTokensAllocated', uintType(128)],
  ['totalRaised', uintType(128)],
  ['closeTimestamp', uintType(64)],
]);

/** darkveil.compact:190 — `computeCertHash`. */
export function computeCertHash(input: CertHashInput): Uint8Array {
  return persistentHash(certHashInputType, input);
}
