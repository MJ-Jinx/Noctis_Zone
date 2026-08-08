// Tests for ada-price-oracle.ts's usdToMinAdaLovelace — converts a USD amount
// to minimum lovelace at the current ADA/USD rate. The price source is mocked
// so the integer arithmetic and the divide-by-zero guard are exercised exactly;
// the source's own behaviour is covered in ada-usd-price.test.ts.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../ada-usd-price.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ada-usd-price.js')>();
  return { ...actual, getAdaUsdPrice: vi.fn() };
});

import { LOVELACE_PER_ADA, usdToMinAdaLovelace } from '../ada-price-oracle.js';
import { type AdaUsdPrice, getAdaUsdPrice, PRICE_SCALE } from '../ada-usd-price.js';

/** A price of `usdPerAda`, in the fixed-point shape the real source returns. */
function priceOf(usdPerAda: number, sources = ['coingecko', 'kraken']): AdaUsdPrice {
  return {
    priceScaled: BigInt(Math.round(usdPerAda * Number(PRICE_SCALE))),
    scale: PRICE_SCALE,
    sources,
    divergence: 0,
    usedFallback: false,
  };
}

describe('usdToMinAdaLovelace', () => {
  it('computes minLovelace = usdAmount / (ADA/USD), in lovelace', async () => {
    // ADA/USD = 2.0; $10 / 2.0 = 5 ADA
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(2));

    const result = await usdToMinAdaLovelace(10);

    expect(result.minLovelace).toBe(5n * LOVELACE_PER_ADA);
    expect(result.adaUsdApprox).toBe(2);
    expect(result.sources).toEqual(['coingecko', 'kraken']);
  });

  it('floors at lovelace precision rather than whole-ADA precision', async () => {
    // $1 / 3.0 = 0.3333... ADA, which must not truncate to 0 whole ADA
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(3));
    const result = await usdToMinAdaLovelace(1);
    expect(result.minLovelace).toBe(333_333n);
  });

  it('handles a sub-cent price without losing precision', async () => {
    // A real ADA price is ~0.1957, so this is the case that actually matters.
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(0.1957));
    const result = await usdToMinAdaLovelace(10);
    // $10 / 0.1957 = 51.099... ADA
    expect(result.minLovelace).toBe(51_098_620n);
  });

  it('throws rather than dividing by zero when the price is zero', async () => {
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(0));
    await expect(usdToMinAdaLovelace(10)).rejects.toThrow(/ADA\/USD price is zero/);
  });

  it('accepts a caller-supplied price and does not fetch one', async () => {
    // Lets a caller price several things against one reading rather than
    // hitting the sources repeatedly and risking a mid-flow drift.
    vi.mocked(getAdaUsdPrice).mockClear();
    const result = await usdToMinAdaLovelace(10, priceOf(4, ['supplied']));
    expect(result.minLovelace).toBe(2n * LOVELACE_PER_ADA + 500_000n);
    expect(getAdaUsdPrice).not.toHaveBeenCalled();
  });
});
