// ============================================================================
// Noctis Zone — a server-held wallet's Midnight user identity
// ============================================================================
// `registerForDarkVeil` identifies its caller as
// `deriveUserPublicKey(getUserSecret(), launchId)` — a hash of a witness secret
// and the launch it is registering for. Two things follow from that, and both
// shape this module:
//
//   1. The identity is NOT the wallet's seed, key, or address. A wallet pays the
//      fee; a user secret says who is registering. They are separate values.
//   2. The identity is per-launch. The same secret registering for two launches
//      produces two unrelated public keys, so an allowlist tree is only valid
//      for the launch it was built against.
//
// The secret itself is derived from the wallet seed rather than generated and
// stored. A generated secret exists in exactly one place, and if that place is
// lost the registrant can never prove membership again — the allowlist leaf
// committing to their identity would be unreachable. Deriving it means the seed
// is the only thing that has to survive, which is already true of the wallet.
//
// Domain separation is what keeps that safe: the seed is used for wallet key
// derivation too, and this must not produce anything related to those keys.
// ============================================================================

import { createHmac } from 'node:crypto';
import { deriveUserPublicKey } from '../packages/zk-proofs/src/eligibility-gate.js';

/**
 * The user secret for a server-held wallet, derived from its seed.
 *
 * HMAC rather than a plain hash so the seed acts as keying material rather than
 * as a message, and the label cannot be extended into a related value.
 */
export function deriveUserSecretFromSeed(seed: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', 'noctis:midnight:user-secret:v1').update(seed).digest());
}

/**
 * The public identity a wallet registers under for one specific launch.
 *
 * Mirrors `deriveUserPublicKey` in eligibility_gate.compact exactly — this value
 * is what the circuit recomputes in-circuit, so anything that disagrees here
 * produces an allowlist proof the contract will reject.
 */
export function deriveLaunchIdentity(seed: Uint8Array, launchId: Uint8Array): Uint8Array {
  if (launchId.length !== 32) {
    throw new Error(`launchId must be 32 bytes, got ${launchId.length}.`);
  }
  return deriveUserPublicKey(deriveUserSecretFromSeed(seed), launchId);
}

/**
 * The nonce that hides a registrant's DarkVeil buy amount between commit and
 * reveal.
 *
 * Derived rather than generated, for the same reason the user secret is: the
 * commit and the reveal are separate transactions, potentially hours and a
 * process restart apart, and the reveal has to reproduce this exact value or
 * the contract rejects it as not the commitment owner — with the buying window
 * closed and the bond already locked. A generated nonce would have to survive
 * in storage for that to work; a derived one only needs the seed, which the
 * registrant already has to keep.
 *
 * Scoped per contract address, so the same registrant taking part in two
 * launches commits under two unrelated nonces.
 *
 * Its own domain, distinct from the user secret's: the two are derived from the
 * same seed and must not be relatable.
 */
export function deriveDarkVeilBuyNonce(seed: Uint8Array, contractAddress: string): Uint8Array {
  if (!contractAddress) {
    throw new Error('contractAddress is required — a buy nonce is scoped to one launch.');
  }
  return new Uint8Array(
    createHmac('sha256', 'noctis:midnight:dv-buy-nonce:v1').update(seed).update(contractAddress).digest(),
  );
}
