// ============================================================================
// Noctis Zone — DarkVeil widget: local-storage password derivation
// ============================================================================
// private-state-store.ts's DarkVeilPrivateStore needs a real password
// meeting @midnight-ntwrk/midnight-js-utils's validatePassword policy
// (16+ chars, 3+ character classes, no 4+-char run/sequence, <=3 consecutive
// identical chars — confirmed against the real installed package, not
// assumed). Per the DarkVeil widget plan's design decision #3: rather than
// ask the user to invent and remember a SECOND password on top of their
// wallet, derive one deterministically from a CIP-8 signature their already-
// connected Cardano wallet produces over a fixed domain string — same
// wallet, same message, same signature, same password every session, with
// nothing new to remember and no secret leaving the wallet (a signature is
// not the private key).
//
// Rather than hand-reimplement validatePassword's exact rule set (real risk
// of getting a subtle rule wrong — 4+-char RUN vs 4+-char SEQUENCE are
// different checks), this derives a candidate from the signature and asks
// the REAL validatePassword whether it passes, deterministically re-salting
// and retrying on the rare rejection rather than guessing at a transform
// that's "probably" compliant. Same "verify against real source, don't
// assume" discipline as everything else built this session.
// ============================================================================

import { PasswordValidationError, validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { sha256 } from '@noble/hashes/sha2.js';

const DOMAIN = 'noctis:darkveil:local-storage-password:v1';
const MAX_ATTEMPTS = 64;

/**
 * cto-session.ts (2026-07-19) reuses this same derivation logic for its own
 * password, driven by a DIFFERENT underlying signature (CTO_MASTER_SIGNATURE_DOMAIN,
 * not DarkVeil's) — but the domain string below is a SEPARATE layer of
 * separation on top of that, same double-domain-separation convention as
 * private-state-store.ts/cto-private-state-store.ts's own SK_DOMAIN
 * constants. Keeping it distinct (rather than reusing DarkVeil's DOMAIN
 * constant for an unrelated CTO password) avoids the name lying about what
 * it's for, even though the two can never actually collide (they're always
 * fed different signatures to begin with).
 */
const CTO_PASSWORD_DOMAIN = 'noctis:cto:local-storage-password:v1';

function toUtf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Base64url-encodes the hash — a mix of upper/lower/digit (and `-`/`_` as a
 * 4th class once present) gives validatePassword's 3-class requirement a
 * real chance of passing on the first attempt, unlike a raw hex digest
 * (only 2 classes: lowercase + digit).
 */
function candidateFromHash(hashBytes: Uint8Array): string {
  let binary = '';
  for (const b of hashBytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary).replace(/\+/g, 'A').replace(/\//g, 'b').replace(/=+$/, '');
  // 32-byte sha256 → 43-44 base64 chars, comfortably over the 16-char floor.
  return b64;
}

/**
 * Derives a validatePassword-compliant password from a CIP-8 signature.
 * `signHex` is the hex `signature` field CIP-30's signData returns (NOT the
 * `key` field, and NOT any wallet secret — a signature over a fixed public
 * domain string, safe to re-derive from every session). `domain` defaults
 * to DarkVeil's own constant for existing callers; pass CTO_DOMAIN (or any
 * other caller-specific constant) to derive an unrelated password from a
 * different signature without reusing DarkVeil's naming for it.
 */
export function derivePasswordFromSignature(signHex: string, domain: string = DOMAIN): string {
  let salt = 0;
  let lastError: PasswordValidationError | null = null;

  while (salt < MAX_ATTEMPTS) {
    const input = toUtf8Bytes(`${domain}:${signHex}:${salt}`);
    const hash = sha256(input);
    const candidate = candidateFromHash(hash);
    try {
      validatePassword(candidate);
      return candidate;
    } catch (err) {
      if (err instanceof PasswordValidationError) {
        lastError = err;
        salt++;
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Could not derive a valid local-storage password after ${MAX_ATTEMPTS} attempts` +
      (lastError ? `: ${lastError.message}` : ''),
  );
}

export { CTO_PASSWORD_DOMAIN, DOMAIN as PASSWORD_DERIVATION_DOMAIN, toHex };
