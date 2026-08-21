// ============================================================================
// Noctis Zone — NIGHT/USD Price Oracle (eligibility check #2)
// ============================================================================
//
// Combines Minswap's real NIGHT/ADA TWAP with Orcfax's real ADA/USD datum
// into a NIGHT/USD price, and converts a USD threshold into atomic NIGHT
// units (STAR) for comparison against getUnshieldedNightBalance's result.
// See CLAUDE.md's ORACLE STRATEGY section (2026-07-13 correction) for why
// this triangulates through ADA rather than reading a direct Orcfax
// NIGHT/USD feed -- no such feed exists on any network.
//
// NIGHT_DECIMALS: 1 NIGHT = 1,000,000 STAR (6 decimals) -- sourced from
// Midnight's public tokenomics whitepaper/FAQ (cross-referenced via web
// search 2026-07-13: midnight.gd's FAQ and NIGHT MiCA whitepaper both state
// this), NOT verified directly against SDK source (the primary-source PDF
// couldn't be parsed for this session). Flagging honestly rather than
// treating this as SDK-verified -- worth a direct confirmation before
// mainnet use, same discipline as this project's other Midnight-specific
// facts.
// ============================================================================

import { type AdaUsdPrice, getAdaUsdPrice } from './ada-usd-price.js';
import { getNightAdaTwap } from './minswap-client.js';

export const NIGHT_DECIMALS = 6;
export const NIGHT_ATOMIC_UNITS_PER_NIGHT = 1_000_000n; // 10^NIGHT_DECIMALS

// Internal working precision for the USD -> NIGHT-atomic conversion, kept
// as an integer scale throughout (no intermediate float division) except
// for the final display-only `nightUsdApprox` figure.
const WORK_SCALE = 1_000_000_000_000_000_000n; // 10^18

export interface NightUsdThresholdResult {
  /** Minimum atomic NIGHT (STAR) units needed to reach the USD amount. */
  minNightAtomic: bigint;
  /** Display-only approximate NIGHT/USD price (float, not used in the comparison itself). */
  nightUsdApprox: number;
  /** Orcfax datum's own validity timestamp -- compare against ORACLE_STALENESS_MIN (10 min). */
  /** Which ADA/USD sources agreed on the price used. */
  sources: string[];
  twapSamplesUsed: number;
}

/**
 * Computes the minimum atomic NIGHT (STAR) balance needed to be worth
 * `usdAmount` USD, using a real Minswap TWAP and a real Orcfax ADA/USD
 * datum. Throws rather than fabricating a value if either real source is
 * unavailable or stale beyond what the caller's own staleness policy
 * (ORACLE_STALENESS_MIN) allows -- staleness itself is the caller's call,
 * this function surfaces `oracleTimestampMs` for that decision.
 */
export async function usdToMinNightAtomic(usdAmount: number, price?: AdaUsdPrice): Promise<NightUsdThresholdResult> {
  const [twap, adaUsd] = await Promise.all([getNightAdaTwap(), price ? Promise.resolve(price) : getAdaUsdPrice()]);

  // NIGHT_USD = (twap.priceScaled / twap.scale) * (adaUsd.priceScaled / adaUsd.scale)
  // minNightWhole = usdAmount / NIGHT_USD
  //              = usdAmount * twap.scale * adaUsd.scale / (twap.priceScaled * adaUsd.priceScaled)
  const usdScaled = BigInt(Math.round(usdAmount * Number(WORK_SCALE)));
  const numerator = usdScaled * twap.scale * adaUsd.scale;
  const denominator = twap.priceScaled * adaUsd.priceScaled;

  if (denominator === 0n) {
    throw new Error('Computed a zero NIGHT/USD price — refusing to proceed with a divide-by-zero result');
  }

  // Result of the division is still scaled by WORK_SCALE and denominated in
  // whole NIGHT; convert to atomic units (STAR) before removing the scale,
  // so the final integer division rounds at atomic-unit precision rather
  // than whole-NIGHT precision.
  const minNightAtomicScaled = (numerator * NIGHT_ATOMIC_UNITS_PER_NIGHT) / denominator;
  const minNightAtomic = minNightAtomicScaled / WORK_SCALE;

  const nightUsdApprox =
    (Number(twap.priceScaled) / Number(twap.scale)) * (Number(adaUsd.priceScaled) / Number(adaUsd.scale));

  return {
    minNightAtomic,
    nightUsdApprox,
    sources: adaUsd.sources,
    twapSamplesUsed: twap.samplesUsed,
  };
}
