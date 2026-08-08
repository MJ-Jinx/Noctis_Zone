// The off-chain bitmap has to agree with `lib/noctis/bitmap.ak` bit for bit.
// A map built with the ordering reversed reads back correctly here and is
// rejected on chain, so these pin the exact byte values the validators expect
// rather than round-tripping through this module's own reader.

import { describe, expect, it } from 'vitest';

import { bitCount, clearedBitmapHex, setBit, testBit } from '../claim-bitmap.js';

describe('setBit — MSB-first, matching bytearray.test_bit', () => {
  it('sets the high bit of the first byte', () => {
    expect(setBit('0000', 0)).toBe('8000');
  });

  it('sets the low bit of the first byte', () => {
    expect(setBit('0000', 7)).toBe('0100');
  });

  // The boundary a byte-indexed map is most likely to get wrong.
  it('crosses into the second byte', () => {
    expect(setBit('0000', 8)).toBe('0080');
  });

  it('preserves length, so a datum cannot grow by claiming', () => {
    expect(setBit('000000', 17)).toHaveLength(6);
  });

  it('leaves every other bit alone', () => {
    expect(setBit('8000', 15)).toBe('8001');
  });

  // Matches the validator's own set_bit, which is idempotent on purpose so
  // that the explicit double-claim check is what refuses a second claim.
  it('is idempotent on an already-set bit', () => {
    expect(setBit('8000', 0)).toBe('8000');
  });

  it('refuses an index past the end of the map rather than growing it', () => {
    expect(() => setBit('00', 8)).toThrow(/outside/);
  });
});

describe('testBit', () => {
  it('reads back what setBit wrote', () => {
    const bits = setBit(setBit('0000', 3), 11);
    expect(testBit(bits, 3)).toBe(true);
    expect(testBit(bits, 11)).toBe(true);
    expect(testBit(bits, 4)).toBe(false);
    expect(testBit(bits, 10)).toBe(false);
  });

  it('refuses an index past the end of the map rather than reading zero', () => {
    expect(() => testBit('00', 8)).toThrow(/outside/);
  });
});

describe('clearedBitmapHex', () => {
  it('rounds up to whole bytes', () => {
    expect(clearedBitmapHex(1)).toBe('00');
    expect(clearedBitmapHex(8)).toBe('00');
    expect(clearedBitmapHex(9)).toBe('0000');
    expect(clearedBitmapHex(20)).toBe('000000');
  });

  it('addresses at least one bit per claimant', () => {
    for (const n of [1, 7, 8, 9, 100, 401]) {
      expect(bitCount(clearedBitmapHex(n))).toBeGreaterThanOrEqual(n);
    }
  });

  it('starts every bit clear', () => {
    expect(clearedBitmapHex(64)).toMatch(/^0+$/);
  });

  it('refuses a roster of nobody', () => {
    expect(() => clearedBitmapHex(0)).toThrow(/positive whole number/);
  });
});
