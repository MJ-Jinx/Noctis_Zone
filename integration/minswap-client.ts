// ============================================================================
// Noctis Zone — Minswap NIGHT/ADA TWAP Client (eligibility check #2 / Oracle Strategy)
// ============================================================================
//
// Minswap has a real, live NIGHT-ADA pool (confirmed 2026-07-13, ~$3.1M
// liquidity per GeckoTerminal/Minswap — well above CLAUDE.md's 5,000 ADA
// floor), but no native TWAP endpoint (checked docs.minswap.org/developer/
// minswap-apis — only price/candlestick and price/timeseries, both spot/
// historical snapshots). This computes a real 30-min TWAP client-side by
// averaging price points from the real `price/timeseries` endpoint
// (confirmed live: GET https://api-mainnet-prod.minswap.org/v1/pools/{id}/
// price/timeseries?period=1d returns real {value, timestamp} pairs at
// ~30-min spacing).
//
// Price is scaled to a fixed-point BigInt immediately on receipt (rather
// than carrying JS floats through further arithmetic) — Minswap's own API
// only returns floats, so this can't eliminate float imprecision at the
// source, but it stops it from compounding through this module's own math.
// ============================================================================

const MINSWAP_API_BASE = 'https://api-mainnet-prod.minswap.org';

// NIGHT-ADA pool LP asset ID — confirmed live via GeckoTerminal/Minswap
// 2026-07-13 (https://minswap.org/pools/f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169).
export const NIGHT_ADA_POOL_ID =
  'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ce74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169';

// Fixed-point scale for the returned price: 10^12, matching the precision
// Minswap's floats already carry (their timeseries values commonly show
// ~14-17 significant digits) without pretending to more precision than the
// upstream float actually has.
const PRICE_SCALE = 1_000_000_000_000n;

interface TimeseriesPoint {
  value: number;
  timestamp: number;
}

export interface NightAdaTwapResult {
  /** NIGHT/ADA price, scaled by PRICE_SCALE (i.e. divide by PRICE_SCALE for the real ratio). */
  priceScaled: bigint;
  scale: bigint;
  /** How many real data points fell inside the TWAP window and were averaged. */
  samplesUsed: number;
  windowMinutes: number;
}

/**
 * Compute a real 30-min (default) TWAP for the NIGHT-ADA pool by averaging
 * every real timeseries point whose timestamp falls within the window,
 * ending at `now`.
 */
export async function getNightAdaTwap(windowMinutes = 30, now: number = Date.now()): Promise<NightAdaTwapResult> {
  const response = await fetch(`${MINSWAP_API_BASE}/v1/pools/${NIGHT_ADA_POOL_ID}/price/timeseries?period=1d`);
  if (!response.ok) {
    throw new Error(`Minswap timeseries request failed: ${response.status} ${await response.text()}`);
  }
  const points = (await response.json()) as TimeseriesPoint[];

  const cutoff = now - windowMinutes * 60 * 1000;
  const inWindow = points.filter((p) => p.timestamp >= cutoff && p.timestamp <= now);

  if (inWindow.length === 0) {
    throw new Error(
      `No Minswap price points found in the last ${windowMinutes} minutes — pool may be stale or illiquid`,
    );
  }

  // Scale each point to a BigInt before averaging so the summation itself
  // doesn't accumulate additional float error beyond what each point already carries.
  const scaledSum = inWindow.reduce((sum, p) => sum + BigInt(Math.round(p.value * Number(PRICE_SCALE))), 0n);
  const priceScaled = scaledSum / BigInt(inWindow.length);

  return {
    priceScaled,
    scale: PRICE_SCALE,
    samplesUsed: inWindow.length,
    windowMinutes,
  };
}
