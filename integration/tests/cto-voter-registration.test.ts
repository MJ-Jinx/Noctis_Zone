import { CML, credentialToAddress, generatePrivateKey, signData } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { DOMAINS, deriveUserPublicKey } from '../../contracts/midnight/witnesses.js';
import { CTO_MASTER_SIGNATURE_DOMAIN, CTO_SK_DOMAIN } from '../cto-private-state-store.js';
import { verifyAndDeriveCtoVoterIdentity } from '../cto-voter-registration.js';
import { deriveFromSignature } from '../private-state-store.js';

function toUtf8Hex(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Builds a REAL Cardano keypair + enterprise address, and a REAL CIP-8
 * signature over CTO_MASTER_SIGNATURE_DOMAIN — no mocking. This is exactly
 * the same shape signData()/getAddressDetails() would produce for a real
 * connected wallet, giving genuine cryptographic coverage of
 * verifyAndDeriveCtoVoterIdentity rather than testing against fabricated
 * inputs a real wallet could never actually produce.
 */
function realSignedRegistration(network: 'Preprod' | 'Mainnet' = 'Preprod') {
  const privateKey = generatePrivateKey();
  const cmlPriv = CML.PrivateKey.from_bech32(privateKey);
  const paymentKeyHash = cmlPriv.to_public().hash().to_hex();
  const address = credentialToAddress(network, {
    type: 'Key',
    hash: paymentKeyHash,
  });

  const addressDetailsHex = CML.Address.from_bech32(address).to_hex();
  const payloadHex = toUtf8Hex(CTO_MASTER_SIGNATURE_DOMAIN);

  const signedMessage = signData(addressDetailsHex, payloadHex, privateKey);

  return { address, signedMessage, paymentKeyHash };
}

// The launch these registrations are for. A voter's identity is scoped per
// launch, so the derived key is only meaningful alongside this value.
const LAUNCH_ID_HEX = '09'.repeat(32);
const LAUNCH_ID = new Uint8Array(32).fill(0x09);

describe('cto-voter-registration.ts — verifyAndDeriveCtoVoterIdentity (real cryptographic round-trip)', () => {
  it('accepts a genuinely valid CIP-8 signature and derives the expected CTO voter identity', () => {
    const { address, signedMessage } = realSignedRegistration();

    const result = verifyAndDeriveCtoVoterIdentity({
      cardanoAddress: address,
      cip8SignatureHex: signedMessage.signature,
      cip8KeyHex: signedMessage.key,
      launchIdHex: LAUNCH_ID_HEX,
    });

    expect(result.cardanoAddress).toBe(address);
    expect(result.ctoVoterPubKeyHex).toMatch(/^[0-9a-f]{64}$/);

    // Cross-check against the SAME derivation cto-private-state-store.ts's
    // client-side getOrCreateIdentity() would produce from this exact
    // signature -- proves server and client land on the identical identity.
    const expectedSk = deriveFromSignature(CTO_SK_DOMAIN, signedMessage.signature);
    const expectedPubKey = deriveUserPublicKey({ bytes: expectedSk }, DOMAINS.CTO_USER, LAUNCH_ID);
    const expectedHex = Array.from(expectedPubKey.bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(result.ctoVoterPubKeyHex).toBe(expectedHex);
  });

  it('rejects a signature over the WRONG message (not CTO_MASTER_SIGNATURE_DOMAIN)', () => {
    const privateKey = generatePrivateKey();
    const cmlPriv = CML.PrivateKey.from_bech32(privateKey);
    const paymentKeyHash = cmlPriv.to_public().hash().to_hex();
    const address = credentialToAddress('Preprod', {
      type: 'Key',
      hash: paymentKeyHash,
    });
    const addressHex = CML.Address.from_bech32(address).to_hex();

    const wrongPayloadHex = toUtf8Hex('some completely different message');
    const signedMessage = signData(addressHex, wrongPayloadHex, privateKey);

    expect(() =>
      verifyAndDeriveCtoVoterIdentity({
        cardanoAddress: address,
        cip8SignatureHex: signedMessage.signature,
        cip8KeyHex: signedMessage.key,
        launchIdHex: LAUNCH_ID_HEX,
      }),
    ).toThrow(/invalid cip-8 signature/i);
  });

  it('rejects a valid signature presented under a DIFFERENT claimed address', () => {
    const { signedMessage } = realSignedRegistration();

    // A second, unrelated real address -- the signature was never produced
    // for this one.
    const otherPrivateKey = generatePrivateKey();
    const otherCmlPriv = CML.PrivateKey.from_bech32(otherPrivateKey);
    const otherKeyHash = otherCmlPriv.to_public().hash().to_hex();
    const otherAddress = credentialToAddress('Preprod', {
      type: 'Key',
      hash: otherKeyHash,
    });

    expect(() =>
      verifyAndDeriveCtoVoterIdentity({
        cardanoAddress: otherAddress,
        cip8SignatureHex: signedMessage.signature,
        cip8KeyHex: signedMessage.key,
        launchIdHex: LAUNCH_ID_HEX,
      }),
    ).toThrow();
  });

  it('rejects a tampered signature (bit-flipped)', () => {
    const { address, signedMessage } = realSignedRegistration();

    // Flip the last hex character of the signature -- still well-formed
    // CBOR-decodable hex, but cryptographically invalid.
    const tampered = signedMessage.signature.slice(0, -1) + (signedMessage.signature.endsWith('0') ? '1' : '0');

    expect(() =>
      verifyAndDeriveCtoVoterIdentity({
        cardanoAddress: address,
        cip8SignatureHex: tampered,
        cip8KeyHex: signedMessage.key,
        launchIdHex: LAUNCH_ID_HEX,
      }),
    ).toThrow();
  });

  it('two different real wallets derive two different CTO voter identities', () => {
    const a = realSignedRegistration();
    const b = realSignedRegistration();

    const resultA = verifyAndDeriveCtoVoterIdentity({
      cardanoAddress: a.address,
      cip8SignatureHex: a.signedMessage.signature,
      cip8KeyHex: a.signedMessage.key,
      launchIdHex: LAUNCH_ID_HEX,
    });
    const resultB = verifyAndDeriveCtoVoterIdentity({
      cardanoAddress: b.address,
      cip8SignatureHex: b.signedMessage.signature,
      cip8KeyHex: b.signedMessage.key,
      launchIdHex: LAUNCH_ID_HEX,
    });

    expect(resultA.ctoVoterPubKeyHex).not.toBe(resultB.ctoVoterPubKeyHex);
  });

  it('the SAME wallet re-registering produces the IDENTICAL identity (deterministic, recoverable)', () => {
    // Simulates the exact recovery scenario cto-private-state-store.ts was
    // built for: the same wallet signs the same fixed message again (e.g.
    // after a cleared browser) and must land on the same derived identity.
    const privateKey = generatePrivateKey();
    const cmlPriv = CML.PrivateKey.from_bech32(privateKey);
    const paymentKeyHash = cmlPriv.to_public().hash().to_hex();
    const address = credentialToAddress('Preprod', {
      type: 'Key',
      hash: paymentKeyHash,
    });
    const addressHex = CML.Address.from_bech32(address).to_hex();
    const payloadHex = toUtf8Hex(CTO_MASTER_SIGNATURE_DOMAIN);

    // Real Ed25519 signing is deterministic -- same key + same message ->
    // same signature every time, which is exactly the property this whole
    // recovery design depends on.
    const first = signData(addressHex, payloadHex, privateKey);
    const second = signData(addressHex, payloadHex, privateKey);
    expect(second.signature).toBe(first.signature);

    const resultFirst = verifyAndDeriveCtoVoterIdentity({
      cardanoAddress: address,
      cip8SignatureHex: first.signature,
      cip8KeyHex: first.key,
      launchIdHex: LAUNCH_ID_HEX,
    });
    const resultSecond = verifyAndDeriveCtoVoterIdentity({
      cardanoAddress: address,
      cip8SignatureHex: second.signature,
      cip8KeyHex: second.key,
      launchIdHex: LAUNCH_ID_HEX,
    });

    expect(resultSecond.ctoVoterPubKeyHex).toBe(resultFirst.ctoVoterPubKeyHex);
  });
});
