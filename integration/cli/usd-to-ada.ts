// ============================================================================
// Noctis Protocol — USD → lovelace at the live ADA/USD rate
// ============================================================================
// The launch fee is denominated in USD and paid in ADA, so something has to
// convert it. This is that something.
//
// The price comes from ada-usd-price.ts: the median of three independent
// public APIs with a 5% divergence guard, falling back to Minswap's on-chain
// ADA/USDM pool if fewer than two answer. It refuses rather than guessing —
// charging real money at an invented rate is worse than failing.
//
// No network parameter: an ADA/USD price is the same fact whichever Cardano
// network a launch is on.
//
// Input: single JSON object on stdin. Output: single JSON object on stdout,
// or { error }.
// ============================================================================

import { getAdaUsdPrice, usdCentsToLovelace } from '../ada-usd-price.js';
import { jsonSafe, parseJsonStdin, readStdin, requireFieldsStrict } from './cli-io.js';

interface Input {
  /** The amount to convert, in whole US cents, so no float enters the maths. */
  usdCents: number;
}

async function main() {
  const input = parseJsonStdin<Input>(await readStdin());
  requireFieldsStrict(input, ['usdCents']);

  if (!Number.isInteger(input.usdCents) || input.usdCents <= 0) {
    throw new Error(`usdCents must be a positive whole number of cents, got ${input.usdCents}`);
  }

  const price = await getAdaUsdPrice();
  const lovelace = usdCentsToLovelace(BigInt(input.usdCents), price);

  process.stdout.write(
    JSON.stringify(
      jsonSafe({
        lovelace,
        usdCents: input.usdCents,
        adaUsdPrice: Number(price.priceScaled) / Number(price.scale),
        sources: price.sources,
        divergence: price.divergence,
        usedFallback: price.usedFallback,
      }),
    ),
  );
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
