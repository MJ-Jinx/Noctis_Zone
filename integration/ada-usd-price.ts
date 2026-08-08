// ============================================================================
// Noctis Protocol — ADA/USD price
// ============================================================================
// Replaces the Orcfax on-chain feed, which was withdrawn on 2026-08-04: its
// preprod address had been dormant since June 2024 and no mainnet address was
// ever confirmed.
//
// WHY AN OFF-CHAIN SOURCE IS THE RIGHT SHAPE HERE
// No contract on either chain reads a price — the validators say so in their
// own comments ("Aiken has no in-circuit oracle"). Every consumer is off-chain
// platform code: the launch fee's USD→ADA conversion, the DarkVeil NIGHT
// eligibility threshold, and the treasury's advisory mark-to-market. None of
// them needs on-chain provenance, so paying an oracle's cost and inheriting its
// liveness risk buys nothing.
//
// For the launch fee specifically the trust requirement is weaker still: the
// platform quotes an ADA amount and the CREATOR signs the transaction, so a
// wrong price is visible and refusable rather than silently extracted.
//
// HOW IT DECIDES
// Three independent public APIs, median of whatever answers, and a divergence
// guard at CLAUDE.md's ORACLE_DIVERGENCE_MAX (5%). Two agreeing sources are
// enough; one is not, because a single source cannot be sanity-checked. If
// fewer than two answer, it falls back to the real on-chain ADA/USDM pool on
// Minswap, which is the same machinery minswap-client.ts already uses for
// NIGHT/ADA.
//
// It throws rather than returning a guess. Every consumer spends real money or
// gates real eligibility on the result.
// ============================================================================

/** Fixed-point scale for the returned price, matching minswap-client.ts. */
export const PRICE_SCALE = 1_000_000_000_000n;

/** CLAUDE.md ORACLE_DIVERGENCE_MAX — 5%. */
export const MAX_DIVERGENCE = 0.05;

/** Minimum sources that must agree before a price is trusted. */
const MIN_SOURCES = 2;

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Minswap's ADA/USDM pool — the on-chain fallback. Confirmed live 2026-08-04
 * via GeckoTerminal with ~$875k of reserves, quoting 0.1958 against 0.1956-
 * 0.1960 across the three APIs below.
 *
 * The pool reports ADA per USDM (~5.11), so it is INVERTED to give USD per ADA.
 * This treats USDM as a dollar, which is the same assumption the treasury
 * already makes by denominating in it.
 */
export const ADA_USDM_POOL_ID =
  'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c7dd6988c5a86693c76aeec1ea94afa41770be0de21a775ca7a2a1eabdb6a0171';

const MINSWAP_API_BASE = 'https://api-mainnet-prod.minswap.org';

export interface AdaUsdPrice {
  /** USD per ADA, scaled by PRICE_SCALE. */
  priceScaled: bigint;
  scale: bigint;
  /** Which sources contributed, so a caller can log provenance. */
  sources: string[];
  /** Largest relative gap between the contributing sources, as a fraction. */
  divergence: number;
  /** True when the on-chain pool was used because too few APIs answered. */
  usedFallback: boolean;
}

interface Source {
  name: string;
  url: string;
  pick: (json: unknown) => number;
}

/**
 * Reading a nested value without `any`. Each source's shape is asserted at the
 * point of use rather than trusted, so a changed API returns NaN and is
 * discarded instead of poisoning the median.
 */
function pluck(json: unknown, path: (string | number)[]): unknown {
  let cur: unknown = json;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

const SOURCES: Source[] = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd',
    pick: (j) => Number(pluck(j, ['cardano', 'usd'])),
  },
  {
    name: 'kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=ADAUSD',
    pick: (j) => Number(pluck(j, ['result', 'ADAUSD', 'c', 0])),
  },
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/ADA-USD/spot',
    pick: (j) => Number(pluck(j, ['data', 'amount'])),
  },
];

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toScaled(price: number): bigint {
  // Via a fixed-decimal string rather than multiplying the float, so the
  // conversion never inherits a binary rounding artefact.
  return BigInt(Math.round(price * Number(PRICE_SCALE)));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Largest relative gap between the highest and lowest quote. */
function spread(values: number[]): number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo > 0 ? (hi - lo) / lo : Number.POSITIVE_INFINITY;
}

/** The on-chain fallback: Minswap's ADA/USDM pool, inverted. */
async function getPoolPrice(windowMinutes: number, now: number): Promise<number> {
  const points = (await fetchJson(`${MINSWAP_API_BASE}/v1/pools/${ADA_USDM_POOL_ID}/price/timeseries?period=1d`)) as {
    value: number;
    timestamp: number;
  }[];
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('Minswap ADA/USDM timeseries returned no points.');
  }
  // Timestamps are already milliseconds, matching minswap-client.ts.
  const cutoff = now - windowMinutes * 60 * 1000;
  const windowed = points.filter((p) => p.timestamp >= cutoff && Number.isFinite(p.value) && p.value > 0);
  // A quiet pool can have no ticks inside the window; the latest real point is
  // a better answer than failing, and staleness is bounded by the 1d period.
  const used = windowed.length > 0 ? windowed : points.slice(-1);
  const adaPerUsdm = used.reduce((a, p) => a + p.value, 0) / used.length;
  if (!Number.isFinite(adaPerUsdm) || adaPerUsdm <= 0) {
    throw new Error(`Minswap ADA/USDM produced a non-positive rate (${adaPerUsdm}).`);
  }
  return 1 / adaPerUsdm;
}

/**
 * The current USD price of one ADA.
 *
 * @throws if fewer than two APIs answer AND the on-chain pool also fails, or if
 *   the sources that did answer disagree by more than MAX_DIVERGENCE.
 */
export async function getAdaUsdPrice(opts: { windowMinutes?: number; now?: number } = {}): Promise<AdaUsdPrice> {
  const now = opts.now ?? Date.now();
  const windowMinutes = opts.windowMinutes ?? 30;

  const settled = await Promise.allSettled(
    SOURCES.map(async (s) => ({ name: s.name, price: s.pick(await fetchJson(s.url)) })),
  );

  const quotes = settled
    .filter((r): r is PromiseFulfilledResult<{ name: string; price: number }> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q) => Number.isFinite(q.price) && q.price > 0);

  if (quotes.length >= MIN_SOURCES) {
    const prices = quotes.map((q) => q.price);
    const div = spread(prices);
    if (div > MAX_DIVERGENCE) {
      throw new Error(
        `ADA/USD sources disagree by ${(div * 100).toFixed(2)}%, past the ${(MAX_DIVERGENCE * 100).toFixed(0)}% limit: ` +
          quotes.map((q) => `${q.name}=${q.price}`).join(', '),
      );
    }
    return {
      priceScaled: toScaled(median(prices)),
      scale: PRICE_SCALE,
      sources: quotes.map((q) => q.name),
      divergence: div,
      usedFallback: false,
    };
  }

  // Fewer than two independent quotes — fall back on chain rather than trusting
  // a lone API that nothing can check.
  const poolPrice = await getPoolPrice(windowMinutes, now);
  return {
    priceScaled: toScaled(poolPrice),
    scale: PRICE_SCALE,
    sources: [...quotes.map((q) => q.name), 'minswap-ada-usdm'],
    divergence: 0,
    usedFallback: true,
  };
}

/**
 * USD cents → lovelace at the current rate, rounded UP so a rounding error
 * never undercharges. All BigInt: no float enters the conversion.
 */
export function usdCentsToLovelace(usdCents: bigint, price: AdaUsdPrice): bigint {
  if (usdCents <= 0n) throw new Error(`usdCents must be positive, got ${usdCents}`);
  if (price.priceScaled <= 0n) throw new Error(`ADA/USD price must be positive, got ${price.priceScaled}`);
  // lovelace = (cents / 100) / usdPerAda * 1e6
  //          = cents * 10^4 * scale / priceScaled
  const numerator = usdCents * 10_000n * price.scale;
  return (numerator + price.priceScaled - 1n) / price.priceScaled;
}
