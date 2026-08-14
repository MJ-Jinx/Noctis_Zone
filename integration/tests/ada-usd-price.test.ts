// Tests for ada-usd-price.ts — the ADA/USD source that replaced Orcfax.
//
// This module prices the launch fee a creator actually pays, so the cases that
// matter are the ones where it must REFUSE to answer: sources that disagree,
// sources that return a shape it did not expect, and a lone survivor that
// nothing can check. Each of those is asserted here, not just the happy path.
//
// global.fetch is stubbed per-test, matching minswap-client.test.ts; the
// production module is untouched.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADA_USDM_POOL_ID, getAdaUsdPrice, MAX_DIVERGENCE, PRICE_SCALE, usdCentsToLovelace } from '../ada-usd-price.js';

/** The real response shapes, so a changed pick() path fails these tests. */
const coingecko = (usd: number) => ({ cardano: { usd } });
const kraken = (usd: number) => ({ result: { ADAUSD: { c: [String(usd), '100'] } } });
const coinbase = (usd: number) => ({ data: { amount: String(usd) } });

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) });

/**
 * Routes by URL rather than by call order: getAdaUsdPrice fires all three
 * sources through Promise.allSettled, so settlement order is not guaranteed
 * and an order-keyed mock would be testing the scheduler.
 */
function routedFetch(routes: { coingecko?: unknown; kraken?: unknown; coinbase?: unknown; minswap?: unknown }) {
  return vi.fn(async (url: string) => {
    if (url.includes('coingecko')) return routes.coingecko ?? fail();
    if (url.includes('kraken')) return routes.kraken ?? fail();
    if (url.includes('coinbase')) return routes.coinbase ?? fail();
    if (url.includes('minswap')) return routes.minswap ?? fail();
    throw new Error(`unexpected url ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getAdaUsdPrice', () => {
  it('returns the median of three agreeing sources, naming each one', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ coingecko: ok(coingecko(0.5)), kraken: ok(kraken(0.51)), coinbase: ok(coinbase(0.52)) }),
    );

    const price = await getAdaUsdPrice();

    // Median of 0.50 / 0.51 / 0.52 is 0.51 — NOT the mean, which is also 0.51
    // here only by symmetry; the asymmetric case below separates them.
    expect(price.priceScaled).toBe(510_000_000_000n);
    expect(price.scale).toBe(PRICE_SCALE);
    expect(price.sources.sort()).toEqual(['coinbase', 'coingecko', 'kraken']);
    expect(price.usedFallback).toBe(false);
  });

  it('takes the median, not the mean, when one source is an outlier', async () => {
    // 0.500 / 0.505 / 0.520 — mean is 0.50833, median is 0.505.
    vi.stubGlobal(
      'fetch',
      routedFetch({ coingecko: ok(coingecko(0.5)), kraken: ok(kraken(0.505)), coinbase: ok(coinbase(0.52)) }),
    );

    const price = await getAdaUsdPrice();

    expect(price.priceScaled).toBe(505_000_000_000n);
  });

  it('averages the two middle quotes when an even number of sources answer', async () => {
    vi.stubGlobal('fetch', routedFetch({ coingecko: ok(coingecko(0.5)), kraken: ok(kraken(0.52)) }));

    const price = await getAdaUsdPrice();

    expect(price.priceScaled).toBe(510_000_000_000n);
    expect(price.usedFallback).toBe(false);
  });

  it('throws rather than guessing when the sources disagree past the 5% limit', async () => {
    // 0.50 vs 0.53 is a 6% spread against the low quote.
    vi.stubGlobal('fetch', routedFetch({ coingecko: ok(coingecko(0.5)), kraken: ok(kraken(0.53)) }));

    await expect(getAdaUsdPrice()).rejects.toThrow(/disagree by 6\.00%/);
  });

  // The 5% limit is compared in binary floating point, so a spread that is
  // "exactly 5%" in decimal lands fractionally either side of it depending on
  // the two quotes. Both cases are pinned here because the difference is real
  // and the rejecting side is the safe one — anyone tempted to "fix" the
  // boundary should see that loosening it weakens a guard for a ~1e-16 gain.
  it('rejects a nominally-exact 5% spread that floats round up', async () => {
    // (0.525 - 0.5) / 0.5 === 0.050000000000000044
    vi.stubGlobal('fetch', routedFetch({ coingecko: ok(coingecko(0.5)), kraken: ok(kraken(0.525)) }));

    await expect(getAdaUsdPrice()).rejects.toThrow(/disagree by 5\.00%/);
  });

  it('accepts a nominally-exact 5% spread that floats round down', async () => {
    // (0.42 - 0.40) / 0.40 === 0.049999999999999906
    vi.stubGlobal('fetch', routedFetch({ coingecko: ok(coingecko(0.4)), kraken: ok(kraken(0.42)) }));

    const price = await getAdaUsdPrice();

    expect(price.divergence).toBeLessThan(MAX_DIVERGENCE);
    expect(price.priceScaled).toBe(410_000_000_000n);
  });

  it('discards a source whose shape changed instead of letting NaN into the median', async () => {
    // A renamed field yields undefined -> Number(undefined) is NaN. That quote
    // must be dropped, leaving two good ones rather than poisoning the result.
    vi.stubGlobal(
      'fetch',
      routedFetch({
        coingecko: ok({ cardano: { price: 0.5 } }), // wrong key
        kraken: ok(kraken(0.5)),
        coinbase: ok(coinbase(0.51)),
      }),
    );

    const price = await getAdaUsdPrice();

    expect(price.sources).not.toContain('coingecko');
    expect(price.priceScaled).toBe(505_000_000_000n);
  });

  it('discards a non-positive quote', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({ coingecko: ok(coingecko(0)), kraken: ok(kraken(0.5)), coinbase: ok(coinbase(0.5)) }),
    );

    const price = await getAdaUsdPrice();

    expect(price.sources.sort()).toEqual(['coinbase', 'kraken']);
    expect(price.priceScaled).toBe(500_000_000_000n);
  });

  it('falls back to the on-chain pool when only one API answers', async () => {
    const now = 1_000_000_000;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        coingecko: ok(coingecko(0.5)),
        // The pool reports ADA per USDM, so 5 inverts to 0.20 USD per ADA.
        minswap: ok([{ value: 5, timestamp: now - 1000 }]),
      }),
    );

    const price = await getAdaUsdPrice({ now });

    expect(price.usedFallback).toBe(true);
    expect(price.sources).toEqual(['coingecko', 'minswap-ada-usdm']);
    expect(price.priceScaled).toBe(200_000_000_000n);
    expect(price.divergence).toBe(0);
  });

  it('asks the real ADA/USDM pool when it falls back', async () => {
    const fetchMock = routedFetch({ minswap: ok([{ value: 5, timestamp: Date.now() }]) });
    vi.stubGlobal('fetch', fetchMock);

    await getAdaUsdPrice();

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain(
      `https://api-mainnet-prod.minswap.org/v1/pools/${ADA_USDM_POOL_ID}/price/timeseries?period=1d`,
    );
  });

  it('averages only the pool points inside the window', async () => {
    const now = 1_000_000_000;
    const cutoff = now - 30 * 60 * 1000;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        minswap: ok([
          { value: 100, timestamp: cutoff - 1 }, // outside — excluded
          { value: 4, timestamp: cutoff }, // on the cutoff — included
          { value: 6, timestamp: now - 1 }, // inside — included
        ]),
      }),
    );

    const price = await getAdaUsdPrice({ now });

    // mean(4, 6) = 5 ADA per USDM -> 0.20 USD per ADA
    expect(price.priceScaled).toBe(200_000_000_000n);
  });

  it('uses the latest point when the window is empty rather than failing', async () => {
    const now = 1_000_000_000;
    vi.stubGlobal(
      'fetch',
      routedFetch({
        minswap: ok([
          { value: 100, timestamp: now - 10 * 60 * 60 * 1000 },
          { value: 4, timestamp: now - 9 * 60 * 60 * 1000 }, // latest, still stale
        ]),
      }),
    );

    const price = await getAdaUsdPrice({ now });

    expect(price.priceScaled).toBe(250_000_000_000n); // 1/4
  });

  it('throws when every API fails and the pool has no points', async () => {
    vi.stubGlobal('fetch', routedFetch({ minswap: ok([]) }));

    await expect(getAdaUsdPrice()).rejects.toThrow(/no points/);
  });

  it('throws when every API fails and the pool is unreachable', async () => {
    vi.stubGlobal('fetch', routedFetch({}));

    await expect(getAdaUsdPrice()).rejects.toThrow(/HTTP 500/);
  });

  it('rejects a pool rate that is not a positive number', async () => {
    const now = 1_000_000_000;
    vi.stubGlobal('fetch', routedFetch({ minswap: ok([{ value: -1, timestamp: now }]) }));

    await expect(getAdaUsdPrice({ now })).rejects.toThrow(/non-positive/);
  });
});

describe('usdCentsToLovelace', () => {
  const at = (usdPerAda: number) => ({
    priceScaled: BigInt(Math.round(usdPerAda * Number(PRICE_SCALE))),
    scale: PRICE_SCALE,
    sources: ['test'],
    divergence: 0,
    usedFallback: false,
  });

  it('converts a clean rate exactly', () => {
    // $10.00 at $0.50/ADA = 20 ADA = 20_000_000 lovelace
    expect(usdCentsToLovelace(1000n, at(0.5))).toBe(20_000_000n);
  });

  it('rounds UP, so a rounding error never undercharges', () => {
    // $0.01 at $0.30/ADA = 0.0333… ADA = 33_333.33 lovelace -> 33_334
    expect(usdCentsToLovelace(1n, at(0.3))).toBe(33_334n);
  });

  it('does not round up a result that is already exact', () => {
    // $0.01 at $0.50/ADA = 0.02 ADA = 20_000 lovelace exactly.
    expect(usdCentsToLovelace(1n, at(0.5))).toBe(20_000n);
  });

  it('stays exact at a price no float could represent cleanly', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. All arithmetic here is
    // BigInt, so the result is decided by priceScaled alone.
    const price = { ...at(0), priceScaled: 196_000_000_000n }; // $0.196/ADA
    // $10 = 1000c -> 1000 * 10^4 * 10^12 / 1.96e11 = 51_020_408.16… -> ceil
    expect(usdCentsToLovelace(1000n, price)).toBe(51_020_409n);
  });

  it('refuses a non-positive amount', () => {
    expect(() => usdCentsToLovelace(0n, at(0.5))).toThrow(/must be positive/);
    expect(() => usdCentsToLovelace(-1n, at(0.5))).toThrow(/must be positive/);
  });

  it('refuses a non-positive price', () => {
    expect(() => usdCentsToLovelace(1000n, { ...at(0.5), priceScaled: 0n })).toThrow(/price must be positive/);
  });
});
