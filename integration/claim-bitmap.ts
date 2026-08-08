// claim-bitmap.ts — the off-chain mirror of `lib/noctis/bitmap.ak`.
//
// Two validators keep a "has this already been claimed?" record as a fixed-size
// bitmap rather than a list of claimants: the DarkVeil claim window, and the
// staking pool's per-root reward nullifier. A list grows one entry per
// claimant forever and is compared by structural equality on every spend, so
// the UTXO holding it gets steadily more expensive to spend and eventually
// cannot be spent at all — worst exactly when a launch has done best.
//
// Bit ordering is MSB-first: bit 0 is the high bit of byte 0, matching Aiken's
// `bytearray.test_bit`. Getting that backwards would produce a map that reads
// correctly here and is rejected on chain, so both readers of these values
// share one implementation rather than each keeping its own.

/** Whether bit `ix` is set in a hex-encoded bitmap. */
export function testBit(bitsHex: string, ix: number): boolean {
  const at = (ix >> 3) * 2;
  const byte = Number.parseInt(bitsHex.slice(at, at + 2), 16);
  if (Number.isNaN(byte)) {
    throw new Error(`testBit: bit ${ix} is outside a ${bitsHex.length / 2}-byte map`);
  }
  return (byte & (1 << (7 - (ix % 8)))) !== 0;
}

/**
 * `bitsHex` with bit `ix` set. Length is preserved, so a datum cannot grow by
 * claiming — which is the whole point of using a map.
 */
export function setBit(bitsHex: string, ix: number): string {
  const at = (ix >> 3) * 2;
  const byte = Number.parseInt(bitsHex.slice(at, at + 2), 16);
  if (Number.isNaN(byte)) {
    throw new Error(`setBit: bit ${ix} is outside a ${bitsHex.length / 2}-byte map`);
  }
  const updated = byte | (1 << (7 - (ix % 8)));
  return bitsHex.slice(0, at) + updated.toString(16).padStart(2, '0') + bitsHex.slice(at + 2);
}

/** How many bits a hex-encoded map addresses. */
export function bitCount(bitsHex: string): number {
  return (bitsHex.length / 2) * 8;
}

/**
 * A cleared map with one bit per claimant, rounded up to whole bytes.
 *
 * Both validators require a freshly-published map to be all zero: otherwise
 * whoever publishes it could burn a claimant's entitlement before they ever
 * made a claim, by handing out a map with their bit already set.
 */
export function clearedBitmapHex(claimantCount: number): string {
  if (!Number.isInteger(claimantCount) || claimantCount <= 0) {
    throw new Error(`clearedBitmapHex: claimantCount must be a positive whole number, got ${claimantCount}`);
  }
  return '00'.repeat(Math.ceil(claimantCount / 8));
}
