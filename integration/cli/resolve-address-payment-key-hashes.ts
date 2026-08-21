// ============================================================================
// Noctis Zone — batch Cardano address -> payment key hash resolver
// ============================================================================
// bonding_curve_tier_b.ak's hash_dv_leaf needs each DarkVeil buyer's real
// VerificationKeyHash, not their bech32 address — darkveil-registration.php's
// intake registry only stores the address (what a registrant actually
// submits). Reuses Lucid Evolution's real getAddressDetails() (the same,
// already-proven helper cto-voter-registration.ts uses for CIP-8
// verification) rather than hand-rolling bech32/address parsing in PHP —
// one real, already-tested implementation, not two divergent copies in two
// languages, same discipline as build-allowlist-tree.ts's own header.
//
// Pure, local, no-network computation (bech32 decode only) — batched in one
// process invocation for efficiency, same reasoning as
// build-allowlist-tree.ts taking an array rather than one CLI call per key.
//
// Input: JSON on stdin — { "addresses": ["addr_test1...", ...] }.
// Output: { "results": [{ "address": "...", "vkhHex": "..." } | { "address":
// "...", "error": "..." }, ...] } — one entry per input address, in the
// same order; a per-address error (script-controlled address, no payment
// credential, malformed address) never aborts the whole batch.
// ============================================================================

import { getAddressDetails } from '@lucid-evolution/lucid';
import { parseJsonStdin, readStdin } from './cli-io.js';

interface Input {
  addresses: string[];
}

async function main() {
  const raw = await readStdin();
  const input = parseJsonStdin<Input>(raw);

  if (!Array.isArray(input.addresses) || input.addresses.length === 0) {
    throw new Error('addresses must be a non-empty array.');
  }

  const results = input.addresses.map((address) => {
    try {
      const details = getAddressDetails(address);
      if (!details.paymentCredential) {
        return {
          address,
          error: 'Address has no payment credential (not a base or enterprise address)',
        };
      }
      if (details.paymentCredential.type !== 'Key') {
        return {
          address,
          error: 'Address payment credential is a script, not a real signing key',
        };
      }
      return { address, vkhHex: details.paymentCredential.hash };
    } catch (err) {
      return {
        address,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  process.stdout.write(JSON.stringify({ results }));
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exitCode = 1;
});
