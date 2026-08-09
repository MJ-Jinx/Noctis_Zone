// ============================================================================
// Noctis Protocol — CTO Governance: Governor-Side Voter Registration
// ============================================================================
// The other half of item #13 — cto-private-state-store.ts /
// widget/cto-session.ts (built earlier this session) give a voter a real,
// recoverable Midnight voting identity derived from their Cardano wallet
// alone. What was missing: a way for the GOVERNOR to learn which Cardano
// address maps to which derived voter public key, so item #12 (the
// balance-snapshot builder) can build cto_governance.compact's Merkle tree
// leaves correctly.
//
// SECURITY-CRITICAL — verified against real, tested code, not derived from
// spec alone. The verification primitive is @lucid-evolution/lucid's own
// `verifyData` (re-exported from @lucid-evolution/sign_data), the exact
// same package family already used everywhere else in this codebase for
// Cardano transaction building. Confirmed via its real, public source
// (github.com/Anastasia-Labs/lucid-evolution, packages/sign_data/src/
// sign_data.ts, fetched and read directly 2026-07-19) that it performs a
// genuinely complete CIP-8 verification: binds the claimed address (read
// from the COSE protected header, not just trusted from the caller),
// confirms the recovered public key's hash matches the expected payment
// credential, checks algorithm (EdDSA)/curve (Ed25519)/key-type (OKP), and
// performs the real Ed25519 signature verification via CML's own
// PublicKey.verify() — not a hand-rolled reimplementation. An earlier
// draft of this file used @stricahq/cip08 + @stricahq/bip32ed25519
// (verified against the real, official cardano-foundation/
// cardano-verify-datasignature reference first) before finding
// verifyData already does the same job using packages already installed
// in this exact codebase (@emurgo/cardano-message-signing-nodejs,
// @anastasia-labs/cardano-multiplatform-lib-nodejs) — switched to avoid an
// unnecessary new dependency tree.
//
// DESIGN — never trusts a client-submitted public key or claimed identity:
// the caller submits {cardanoAddress, cip8SignatureHex, cip8KeyHex} — the
// RAW signature and key CIP-30's signData returned, never a pre-computed
// derived pubkey. The server independently verifies the signature is
// genuinely valid for the claimed address and the exact expected message,
// THEN re-derives the CTO voter identity from the now-verified signature
// itself (same deterministic derivation cto-private-state-store.ts's
// client-side getOrCreateIdentity() uses — CTO_SK_DOMAIN, sha256, then
// deriveUserPublicKey under cto_governance.compact's own on-chain domain).
// A forged submission cannot produce a valid registration: either the
// signature fails verification, or it succeeds and the resulting derived
// identity is provably the one that specific signature (and therefore that
// specific wallet) actually produces — there is no path to registering an
// arbitrary pubkey for an address you don't control.
// ============================================================================

import { getAddressDetails, verifyData } from '@lucid-evolution/lucid';
import { DOMAINS, deriveUserPublicKey, type UserSecretKey } from '../contracts/midnight/witnesses.js';
import { CTO_MASTER_SIGNATURE_DOMAIN, CTO_SK_DOMAIN } from './cto-private-state-store.js';
import { bytesToHex, deriveFromSignature, hexToBytes } from './private-state-store.js';

function toUtf8Hex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface RegistrationInput {
  /** Bech32 Cardano address (addr1.../addr_test1...) the voter claims to control. */
  cardanoAddress: string;
  /** Hex COSE_Sign1 CBOR — the `signature` field CIP-30's signData returned. */
  cip8SignatureHex: string;
  /** Hex COSE_Key CBOR — the `key` field CIP-30's signData returned. */
  cip8KeyHex: string;
  /** The launch whose CTO ballot this identity is for, hex. A voter's
   *  identity is scoped per launch, so the same wallet registers a different
   *  key for each one — which is what stops the two registrations being
   *  matched to the same person. */
  launchIdHex: string;
}

export interface VerifiedCtoVoterRegistration {
  cardanoAddress: string;
  /** deriveUserPublicKey(sk, DOMAINS.CTO_USER, launchId).bytes, hex — the Merkle leaf identity the balance-snapshot builder needs, for this launch only. */
  ctoVoterPubKeyHex: string;
}

/**
 * Verifies a CIP-8 signature is genuinely valid for the claimed address and
 * the exact expected CTO master signature message, then re-derives the
 * resulting CTO voter identity. Throws on any verification failure — never
 * returns a partial/unverified result.
 */
export function verifyAndDeriveCtoVoterIdentity(input: RegistrationInput): VerifiedCtoVoterRegistration {
  const details = getAddressDetails(input.cardanoAddress);

  if (!details.paymentCredential) {
    throw new Error('Address has no payment credential (not a base or enterprise address)');
  }
  if (details.paymentCredential.type !== 'Key') {
    throw new Error('Address payment credential is a script, not a real signing key');
  }

  const expectedPayloadHex = toUtf8Hex(CTO_MASTER_SIGNATURE_DOMAIN);

  const valid = verifyData(details.address.hex, details.paymentCredential.hash, expectedPayloadHex, {
    signature: input.cip8SignatureHex,
    key: input.cip8KeyHex,
  });

  if (!valid) {
    throw new Error('Invalid CIP-8 signature for the claimed address and expected message');
  }

  // Re-derive the SAME secret cto-private-state-store.ts's client-side
  // getOrCreateIdentity() would derive from this exact signature. The
  // server never learns or needs any wallet secret — a signature is
  // inherently public/shareable data, not the private key itself; only
  // re-deriving the resulting PUBLIC identity from it, exactly mirroring
  // the client's own deterministic derivation.
  const sk: UserSecretKey = {
    bytes: deriveFromSignature(CTO_SK_DOMAIN, input.cip8SignatureHex),
  };
  const pubKey = deriveUserPublicKey(sk, DOMAINS.CTO_USER, hexToBytes(input.launchIdHex));

  return {
    cardanoAddress: input.cardanoAddress,
    ctoVoterPubKeyHex: bytesToHex(pubKey.bytes),
  };
}
