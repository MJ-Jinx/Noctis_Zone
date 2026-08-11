// Tests for read-dv-purchases.ts — the governor-side read of every real
// DarkVeil purchase out of eligibility_gate.compact's ledger.
//
// WHY THIS MATTERS
// What this returns becomes the allocation Merkle tree, and that root is
// anchored on Cardano under an Inactive-only redeemer. A key encoded one
// character short, or an amount that lost precision on the way through, does
// not surface as an error — it surfaces as a buyer whose proof does not
// verify, after the root can no longer be replaced.
//
// The module's own docstring called extractDvPurchases "trivially testable".
// It was, and it wasn't tested.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../contracts/midnight/compiled/eligibility_gate/contract/index.js', () => ({
  ledger: vi.fn(),
}));

import { ledger } from '../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import { type DecodedEligibilityGateLedger, extractDvPurchases, readDvPurchases } from '../read-dv-purchases.js';

/** A 32-byte Midnight user public key whose first byte is the one given. */
function key(firstByte: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[0] = firstByte;
  bytes[31] = 0xff;
  return bytes;
}

function decoded(entries: [Uint8Array, bigint][]): DecodedEligibilityGateLedger {
  return { dvTokensPurchased: entries };
}

describe('extractDvPurchases', () => {
  it('returns one entry per real purchase, in ledger order', async () => {
    const result = extractDvPurchases(
      decoded([
        [key(0x01), 100n],
        [key(0x02), 250n],
      ]),
    );
    expect(result.map((p) => p.dvAmount)).toEqual(['100', '250']);
    expect(result[0].userPubKeyHex.startsWith('01')).toBe(true);
    expect(result[1].userPubKeyHex.startsWith('02')).toBe(true);
  });

  it('drops a zero-amount entry', async () => {
    // revealBuyCommit always increments by a positive amount, so a zero is
    // not something the contract writes — it is filtered because a leaf for a
    // buyer who bought nothing would still be a claimable leaf.
    expect(extractDvPurchases(decoded([[key(0x01), 0n]]))).toEqual([]);
  });

  it('drops a negative amount rather than encoding it', async () => {
    expect(extractDvPurchases(decoded([[key(0x01), -5n]]))).toEqual([]);
  });

  it('returns an empty list for an empty ledger', async () => {
    expect(extractDvPurchases(decoded([]))).toEqual([]);
  });

  it('pads a byte below 0x10 to two hex characters', async () => {
    // The failure this guards: without padding, 0x0a renders as "a" and the
    // key is 63 characters instead of 64. It still looks like hex, still
    // round-trips through JSON, and hashes to a leaf nobody can prove.
    const bytes = new Uint8Array(32);
    bytes[0] = 0x0a;
    bytes[1] = 0x00;
    const [purchase] = extractDvPurchases(decoded([[bytes, 1n]]));
    expect(purchase.userPubKeyHex.slice(0, 4)).toBe('0a00');
    expect(purchase.userPubKeyHex).toHaveLength(64);
  });

  it('encodes a high byte in lowercase', async () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0xff;
    bytes[1] = 0xab;
    const [purchase] = extractDvPurchases(decoded([[bytes, 1n]]));
    expect(purchase.userPubKeyHex.slice(0, 4)).toBe('ffab');
  });

  it('keeps an amount larger than Number.MAX_SAFE_INTEGER exact', async () => {
    // This is the whole reason dvAmount is a decimal string rather than a
    // number: a full-supply purchase exceeds 2^53, and going through a float
    // loses the low digits silently.
    const huge = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    const [purchase] = extractDvPurchases(decoded([[key(0x01), huge]]));
    expect(purchase.dvAmount).toBe('9007199254740993');
    expect(BigInt(purchase.dvAmount)).toBe(huge);
  });

  it('keeps two buyers with the same amount as two separate entries', async () => {
    const result = extractDvPurchases(
      decoded([
        [key(0x01), 500n],
        [key(0x02), 500n],
      ]),
    );
    expect(result).toHaveLength(2);
    expect(result[0].userPubKeyHex).not.toBe(result[1].userPubKeyHex);
  });
});

describe('readDvPurchases', () => {
  const mockedLedger = vi.mocked(ledger);

  function provider(state: unknown) {
    return {
      queryContractState: vi.fn(async () => state),
    } as unknown as Parameters<typeof readDvPurchases>[0];
  }

  it('reports not-deployed without attempting to decode', async () => {
    // A contract that is not there yet is a normal state during setup, not an
    // error — but decoding null would be.
    mockedLedger.mockClear();
    const result = await readDvPurchases(provider(null), 'addr_contract');
    expect(result).toEqual({ deployed: false, purchases: [] });
    expect(mockedLedger).not.toHaveBeenCalled();
  });

  it('decodes the queried state and returns its real purchases', async () => {
    mockedLedger.mockReturnValue(decoded([[key(0x07), 42n]]) as unknown as ReturnType<typeof ledger>);
    const result = await readDvPurchases(provider({ data: 'opaque-state' }), 'addr_contract');
    expect(result.deployed).toBe(true);
    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0].dvAmount).toBe('42');
  });

  it('passes the contract state through to the generated decoder untouched', async () => {
    // The decoder is the compiled contract's own; handing it anything other
    // than the exact `.data` it was given is how a decode silently produces
    // an empty ledger instead of throwing.
    mockedLedger.mockReturnValue(decoded([]) as unknown as ReturnType<typeof ledger>);
    const state = { data: { marker: 'exact-object' } };
    await readDvPurchases(provider(state), 'addr_contract');
    expect(mockedLedger).toHaveBeenCalledWith(state.data);
  });

  it('queries the contract address it was given', async () => {
    mockedLedger.mockReturnValue(decoded([]) as unknown as ReturnType<typeof ledger>);
    const p = provider({ data: {} });
    await readDvPurchases(p, 'addr_specific_contract');
    expect(vi.mocked(p.queryContractState)).toHaveBeenCalledWith('addr_specific_contract');
  });
});
