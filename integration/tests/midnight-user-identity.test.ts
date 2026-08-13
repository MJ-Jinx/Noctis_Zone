// Guards over the identity a wallet registers under.
//
// WHY THIS EXISTS
// `registerForDarkVeil` recomputes the caller's public key in-circuit and uses
// it to derive the allowlist leaf. The tree is built off-chain from the same
// value. If the two ever disagree the contract does not report a mismatch — it
// reports "Invalid allowlist proof", which reads like a broken tree rather than
// a broken identity, and every registrant fails at once.
//
// The properties below are the ones that would let that happen silently.

import { describe, expect, it } from 'vitest';
import { deriveUserPublicKey } from '../../packages/zk-proofs/src/eligibility-gate.js';
import { deriveDarkVeilBuyNonce, deriveLaunchIdentity, deriveUserSecretFromSeed } from '../midnight-user-identity.js';

const seedA = new Uint8Array(32).fill(1);
const seedB = new Uint8Array(32).fill(2);
const launch1 = new Uint8Array(32).fill(9);
const launch2 = new Uint8Array(32).fill(8);

describe('the user secret', () => {
  it('is the same every time for one seed', () => {
    expect(deriveUserSecretFromSeed(seedA)).toEqual(deriveUserSecretFromSeed(seedA));
  });

  it('differs between seeds', () => {
    expect(deriveUserSecretFromSeed(seedA)).not.toEqual(deriveUserSecretFromSeed(seedB));
  });

  it('is 32 bytes, the width the contract expects', () => {
    expect(deriveUserSecretFromSeed(seedA)).toHaveLength(32);
  });

  it('is not the seed itself', () => {
    // A derivation that leaked the seed through would hand anyone holding a
    // witness secret the wallet that funds it.
    expect(Buffer.from(deriveUserSecretFromSeed(seedA))).not.toEqual(Buffer.from(seedA));
  });
});

describe('the launch identity', () => {
  it('equals the contract-mirroring derivation applied to the derived secret', () => {
    // The one property that actually has to hold: this module must be a
    // composition of the two published steps, not its own third thing.
    expect(deriveLaunchIdentity(seedA, launch1)).toEqual(deriveUserPublicKey(deriveUserSecretFromSeed(seedA), launch1));
  });

  it('is stable for one wallet and one launch', () => {
    expect(deriveLaunchIdentity(seedA, launch1)).toEqual(deriveLaunchIdentity(seedA, launch1));
  });

  it('differs per launch for the same wallet', () => {
    // Registering for two launches must not be linkable through the identity,
    // and an allowlist built for one launch must not validate against another.
    expect(deriveLaunchIdentity(seedA, launch1)).not.toEqual(deriveLaunchIdentity(seedA, launch2));
  });

  it('differs per wallet for the same launch', () => {
    expect(deriveLaunchIdentity(seedA, launch1)).not.toEqual(deriveLaunchIdentity(seedB, launch1));
  });

  it('refuses a launch id that is not 32 bytes', () => {
    // A short id would hash to something the circuit never produces, so every
    // proof would fail with a message pointing at the tree instead of the input.
    expect(() => deriveLaunchIdentity(seedA, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe('deriveDarkVeilBuyNonce', () => {
  const contractA = `5dd23569${'0'.repeat(56)}`;
  const contractB = `aabbccdd${'0'.repeat(56)}`;

  it('reproduces the same nonce from the same seed and launch', () => {
    // The whole point: commit and reveal are separate transactions, possibly a
    // process restart apart. The reveal recomputes the commitment from this
    // value, so a nonce that differed between the two would be rejected as not
    // the commitment owner — after buying closed, with the bond locked.
    expect(deriveDarkVeilBuyNonce(seedA, contractA)).toEqual(deriveDarkVeilBuyNonce(seedA, contractA));
  });

  it('gives a different nonce per launch, so two launches are not linkable by it', () => {
    expect(deriveDarkVeilBuyNonce(seedA, contractA)).not.toEqual(deriveDarkVeilBuyNonce(seedA, contractB));
  });

  it('gives a different nonce per registrant', () => {
    expect(deriveDarkVeilBuyNonce(seedA, contractA)).not.toEqual(deriveDarkVeilBuyNonce(seedB, contractA));
  });

  it('is unrelated to the user secret derived from the same seed', () => {
    // Both come from one seed. If the nonce were derivable from the secret (or
    // vice versa) it would stop hiding the committed amount from anyone who
    // learned either.
    expect(deriveDarkVeilBuyNonce(seedA, contractA)).not.toEqual(deriveUserSecretFromSeed(seedA));
  });

  it('is 32 bytes, the width the commitment struct declares', () => {
    expect(deriveDarkVeilBuyNonce(seedA, contractA)).toHaveLength(32);
  });

  it('refuses an empty launch scope rather than silently sharing one nonce', () => {
    expect(() => deriveDarkVeilBuyNonce(seedA, '')).toThrow(/contractAddress is required/);
  });
});
