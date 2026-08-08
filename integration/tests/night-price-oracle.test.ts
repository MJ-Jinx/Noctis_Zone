// Tests for night-price-oracle.ts — triangulates NIGHT/USD through Minswap's
// NIGHT/ADA TWAP and the ADA/USD price, because no direct NIGHT/USD feed exists
// on any network (CLAUDE.md's Oracle Strategy). This is a security-relevant
// conversion — it gates DarkVeil's $50 NIGHT bond eligibility — and is
// integer-only until the final display float. Both inputs are mocked so the
// arithmetic, including the divide-by-zero guard, is exercised precisely.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../minswap-client.js', () => ({ getNightAdaTwap: vi.fn() }));
vi.mock('../ada-usd-price.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ada-usd-price.js')>();
  return { ...actual, getAdaUsdPrice: vi.fn() };
});

import { type AdaUsdPrice, getAdaUsdPrice, PRICE_SCALE } from '../ada-usd-price.js';
import { getNightAdaTwap } from '../minswap-client.js';
import { NIGHT_ATOMIC_UNITS_PER_NIGHT, usdToMinNightAtomic } from '../night-price-oracle.js';

const SCALE = 1_000_000_000_000n;

function priceOf(usdPerAda: number): AdaUsdPrice {
  return {
    priceScaled: BigInt(Math.round(usdPerAda * Number(PRICE_SCALE))),
    scale: PRICE_SCALE,
    sources: ['coingecko', 'kraken'],
    divergence: 0,
    usedFallback: false,
  };
}

function twapOf(nightPerAda: number, samplesUsed = 4) {
  return {
    priceScaled: BigInt(Math.round(nightPerAda * Number(SCALE))),
    scale: SCALE,
    samplesUsed,
    windowMinutes: 30,
  };
}

describe('usdToMinNightAtomic', () => {
  it('computes atomic NIGHT via NIGHT_USD = NIGHT/ADA x ADA/USD', async () => {
    // NIGHT/ADA = 0.5, ADA/USD = 2 -> NIGHT/USD = 1.0; $10 -> 10 NIGHT
    vi.mocked(getNightAdaTwap).mockResolvedValue(twapOf(0.5));
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(2));

    const result = await usdToMinNightAtomic(10);

    expect(result.minNightAtomic).toBe(10n * NIGHT_ATOMIC_UNITS_PER_NIGHT);
    expect(result.nightUsdApprox).toBeCloseTo(1.0, 10);
    expect(result.sources).toEqual(['coingecko', 'kraken']);
    expect(result.twapSamplesUsed).toBe(4);
  });

  it('floors rather than rounding up, so eligibility is never overstated', async () => {
    // NIGHT/USD = 3.0; $10 / 3.0 = 3.3333... -> 3_333_333, not 3_333_334
    vi.mocked(getNightAdaTwap).mockResolvedValue(twapOf(3, 1));
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(1));

    const result = await usdToMinNightAtomic(10);
    expect(result.minNightAtomic).toBe(3_333_333n);
  });

  it('throws rather than dividing by zero when NIGHT/USD computes to zero', async () => {
    vi.mocked(getNightAdaTwap).mockResolvedValue(twapOf(0, 1));
    vi.mocked(getAdaUsdPrice).mockResolvedValue(priceOf(5));

    await expect(usdToMinNightAtomic(10)).rejects.toThrow(/zero NIGHT\/USD price/);
  });

  it('fetches the TWAP and the ADA/USD price concurrently, not sequentially', async () => {
    let twapResolved = false;
    let priceStartedBeforeTwapResolved = false;

    vi.mocked(getNightAdaTwap).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            twapResolved = true;
            resolve(twapOf(1, 1));
          }, 10),
        ),
    );
    vi.mocked(getAdaUsdPrice).mockImplementation(async () => {
      priceStartedBeforeTwapResolved = !twapResolved;
      return priceOf(1);
    });

    await usdToMinNightAtomic(1);
    expect(priceStartedBeforeTwapResolved).toBe(true);
  });

  it('accepts a caller-supplied price and does not fetch one', async () => {
    vi.mocked(getNightAdaTwap).mockResolvedValue(twapOf(0.5));
    vi.mocked(getAdaUsdPrice).mockClear();

    const result = await usdToMinNightAtomic(10, priceOf(2));

    expect(result.minNightAtomic).toBe(10n * NIGHT_ATOMIC_UNITS_PER_NIGHT);
    expect(getAdaUsdPrice).not.toHaveBeenCalled();
  });
});
