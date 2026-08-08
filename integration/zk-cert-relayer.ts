// ============================================================================
// Noctis Protocol — ZK Fair Launch Certificate Relayer
// ============================================================================
// CLAUDE.md's design: after DarkVeil closes on Midnight, the resulting ZK Fair
// Launch Certificate needs to be anchored on Cardano L1
// (contracts/cardano/validators/zk_anchor.ak) so it's publicly verifiable —
// including for Tier C, whose launch otherwise has no Cardano footprint at
// all. CLAUDE.md's decision: "Default: Option A [direct Midnight SDK
// cross-chain posting] if supported, fall back to Option B [platform-
// operated relayer]. Do not use Option C [omit the anchor]."
//
// Option A confirmed NOT available (2026-07-10): every real Midnight SDK
// surface inspected this session — @midnight-ntwrk/midnight-js-contracts
// (earlier investigation), @midnight-ntwrk/dapp-connector-api (earlier
// investigation) — is entirely Midnight-side. Neither exposes any
// Cardano-aware primitive. This matches CLAUDE.md's own framing (Option B
// was already the practical default) rather than being a new finding, so
// this file implements Option B: a platform-operated relayer.
//
// SCOPE OF THIS FILE (honest, not aspirational):
//   - Fetching the FairLaunchCert from the connected Midnight contract: REAL.
//   - Assembling and Blake2b-256 hashing the proof bundle: REAL, matches
//     zk_anchor.ak's documented "Blake2b-256" hash exactly (verified against
//     the real @noble/hashes/blake2.js API before use, not guessed).
//   - IPFS pinning: a pluggable interface, not a hardcoded vendor — which
//     pinning service to use is an undecided operational choice (same
//     category as the stablecoin choice), not something to bake in here.
//   - Building + submitting the actual Cardano transaction that spends
//     zk_anchor.ak's UTXO via its AnchorCertificate redeemer: REAL as of
//     2026-07-10 — see `cardano-anchor-submitter.ts`'s `LucidAnchorSubmitter`,
//     which implements `CardanoTxSubmitter` below using `@lucid-evolution/
//     lucid` (confirmed real, published, actively maintained — Anvil's
//     documented endpoints and live docs site don't expose a generic
//     arbitrary-validator-plus-custom-redeemer spend, so Lucid Evolution was
//     used instead). The Data encoding, UTXO lookup, and transaction
//     construction are all built against Lucid Evolution's real, installed
//     API — not stubbed. What's NOT done: an actual end-to-end submission
//     against a live node, which needs a funded relayer key and a deployed
//     zk_anchor UTXO that don't exist in this dev environment. See that
//     file's header for the exact boundary of what's tested vs. not.
// ============================================================================

import { blake2b } from '@noble/hashes/blake2.js';
import type { NoctisLaunchManager } from './midnight-client.js';

// ============================================================================
// TYPES — mirror contracts/cardano/validators/zk_anchor.ak exactly
// ============================================================================

export type CertificateType = 'DarkVeilCert' | 'FullZKCert' | 'CtoVoteResult' | 'GraduationCert';

/** Mirrors bonding_curve.compact / darkveil.compact's `FairLaunchCert` struct. */
export interface FairLaunchCert {
  launchId: Uint8Array;
  totalParticipants: bigint;
  totalTokensAllocated: bigint;
  totalRaised: bigint;
  participationRate: number; // Uint<8> — percentage of allowlist that participated
  closeTimestamp: bigint;
  certHash: Uint8Array; // Compact's own persistentHash — NOT the Blake2b-256 hash below
}

/** What actually gets submitted to zk_anchor.ak's AnchorCertificate redeemer. */
export interface AnchorCertificateParams {
  certType: CertificateType;
  proofBundleHash: Uint8Array; // Blake2b-256, 32 bytes
  proofIpfsCid: Uint8Array; // encoded CID bytes (not the string form)
  metadataHash: Uint8Array; // Blake2b-256, 32 bytes
  /**
   * When the anchor transaction itself is submitted, POSIX MILLISECONDS.
   *
   * Deliberately NOT the DarkVeil close time: zk_anchor.ak validates this
   * against the transaction's own validity range, which is the only clock a
   * Cardano script can see, and that range is in milliseconds. A value taken
   * from Midnight's own close timestamp could never fall inside it.
   *
   * The DarkVeil close time is still part of the certificate — it travels in
   * the proof bundle and is committed to by metadataHash — it just is not
   * what `anchor_timestamp` records.
   */
  timestamp: bigint;
}

// ============================================================================
// PROOF BUNDLE ASSEMBLY + HASHING (real)
// ============================================================================

/**
 * The "proof bundle" is the JSON blob pinned to IPFS and referenced by
 * proof_bundle_hash on Cardano — the certificate's public, human/tool
 * readable form. Field order is fixed (not object insertion order) so the
 * hash is deterministic across runs/languages.
 */
export interface ProofBundle {
  launchId: string; // hex
  tier: 'B' | 'C';
  totalParticipants: string; // decimal string — bigint doesn't survive JSON.stringify
  totalTokensAllocated: string;
  totalRaised: string;
  participationRate: number;
  closeTimestamp: string;
  certHash: string; // hex — Compact's own persistentHash, included for cross-verification
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function assembleProofBundle(cert: FairLaunchCert, tier: 'B' | 'C'): ProofBundle {
  return {
    launchId: toHex(cert.launchId),
    tier,
    totalParticipants: cert.totalParticipants.toString(),
    totalTokensAllocated: cert.totalTokensAllocated.toString(),
    totalRaised: cert.totalRaised.toString(),
    participationRate: cert.participationRate,
    closeTimestamp: cert.closeTimestamp.toString(),
    certHash: toHex(cert.certHash),
  };
}

/** Deterministic serialization — fixed key order, no whitespace. */
function canonicalizeProofBundle(bundle: ProofBundle): Uint8Array {
  const ordered = {
    launchId: bundle.launchId,
    tier: bundle.tier,
    totalParticipants: bundle.totalParticipants,
    totalTokensAllocated: bundle.totalTokensAllocated,
    totalRaised: bundle.totalRaised,
    participationRate: bundle.participationRate,
    closeTimestamp: bundle.closeTimestamp,
    certHash: bundle.certHash,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Blake2b-256 (32-byte output — zk_anchor.ak's datum comment specifies
 * "Blake2b-256" for both proof_bundle_hash and metadata_hash). Verified
 * against the real @noble/hashes/blake2.js API (blake2b(msg, {dkLen})) by
 * extracting the actual published package before writing this — not
 * assumed from a generic "blake2b" memory.
 */
export function computeProofBundleHash(bundle: ProofBundle): Uint8Array {
  return blake2b(canonicalizeProofBundle(bundle), { dkLen: 32 });
}

/**
 * Additional metadata the anchor stores hash-committed rather than in the
 * clear (zk_anchor.ak: "Additional metadata ... hash-committed to preserve
 * privacy of underlying data"). What goes in here beyond the proof bundle
 * itself (e.g. launch display name, tier label for the certificate badge
 * UI) is a product decision, not fixed by the contract — this function
 * takes whatever the caller decides belongs here.
 */
export function computeMetadataHash(metadata: Record<string, string | number | boolean>): Uint8Array {
  const keys = Object.keys(metadata).sort();
  const ordered: Record<string, string | number | boolean> = {};
  for (const k of keys) ordered[k] = metadata[k];
  return blake2b(new TextEncoder().encode(JSON.stringify(ordered)), {
    dkLen: 32,
  });
}

// ============================================================================
// IPFS PINNING (pluggable — no vendor hardcoded)
// ============================================================================

export interface IpfsPinner {
  /** Pins `content` and returns the resulting CID as raw bytes (not the base32/base58 string form). */
  pin(content: Uint8Array): Promise<Uint8Array>;
}

// ============================================================================
// CARDANO SUBMISSION — honestly not implemented (see file header)
// ============================================================================

/**
 * What relayCertificate() below needs in order to actually anchor a
 * certificate. Implemented for real 2026-07-10 by `LucidAnchorSubmitter` in
 * `cardano-anchor-submitter.ts`, using `@lucid-evolution/lucid` (Anvil's
 * documented endpoints don't expose a generic arbitrary-validator-plus-
 * custom-redeemer spend, confirmed by checking its live docs site, so this
 * repo's Cardano tx-building layer is Lucid Evolution rather than Anvil).
 * This interface stays here so the rest of the relayer (cert fetching,
 * hashing, bundle assembly) can also be developed and tested against a
 * lightweight mock implementation, independent of Cardano wiring.
 */
export interface CardanoTxSubmitter {
  submitAnchorCertificate(params: AnchorCertificateParams, relayerAddress: string): Promise<{ txHash: string }>;
}

// ============================================================================
// ORCHESTRATION
// ============================================================================

export interface RelayCertificateResult {
  bundle: ProofBundle;
  proofBundleHash: Uint8Array;
  proofIpfsCid: Uint8Array;
  metadataHash: Uint8Array;
  txHash: string;
}

/**
 * Full relay flow: fetch the cert from Midnight, assemble + hash the proof
 * bundle, pin it to IPFS, then anchor the hashes on Cardano L1.
 *
 * `tier` determines certType: Tier B closes DarkVeil into a public curve on
 * Cardano already so its cert is 'DarkVeilCert'; Tier C's is the
 * 'FullZKCert' (the whole launch, not just DarkVeil, lives on Midnight).
 */
export async function relayCertificate(
  launchManager: NoctisLaunchManager,
  tier: 'B' | 'C',
  ipfsPinner: IpfsPinner,
  cardanoSubmitter: CardanoTxSubmitter,
  relayerAddress: string,
  extraMetadata: Record<string, string | number | boolean> = {},
): Promise<RelayCertificateResult> {
  const certResult = await launchManager.getFairLaunchCert();
  // Real field per @midnight-ntwrk/midnight-js-contracts' CallResult type:
  // the JS-typed circuit return value lives at `.private.result`, not
  // `.result` directly — confirmed against the installed package's real
  // .d.ts (call.d.ts) before writing this, per the "hand-verify every
  // .callTx return shape" rule (compact-js's CompiledContract widening
  // means the compiler won't catch a wrong field name here).
  const cert = certResult.private.result as FairLaunchCert;

  const bundle = assembleProofBundle(cert, tier);
  const proofBundleHash = computeProofBundleHash(bundle);
  const metadataHash = computeMetadataHash({ tier, ...extraMetadata });
  const proofIpfsCid = await ipfsPinner.pin(canonicalizeProofBundle(bundle));

  const { txHash } = await cardanoSubmitter.submitAnchorCertificate(
    {
      certType: tier === 'B' ? 'DarkVeilCert' : 'FullZKCert',
      proofBundleHash,
      proofIpfsCid,
      metadataHash,
      // The anchoring time, not cert.closeTimestamp — see the field's own
      // doc comment on AnchorCertificateParams.
      timestamp: BigInt(Date.now()),
    },
    relayerAddress,
  );

  return { bundle, proofBundleHash, proofIpfsCid, metadataHash, txHash };
}
