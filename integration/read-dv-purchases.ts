// ============================================================================
// Noctis Protocol — Tier B: read eligibility_gate.compact's real DarkVeil
// purchase totals
// ============================================================================
// Closes the same "how do you enumerate a Map off-chain" question
// cto-badge.ts already solved for cto_governance.compact's `proposals`
// field — Compact's Map has NO in-circuit enumeration (confirmed there
// against the real compiler: [Symbol.iterator] is tagged js-only, no VM
// opcode), but the compiled contract's own generated `ledger(state.data)`
// function decodes a real, TS-native object whose Map fields DO implement
// [Symbol.iterator] off-chain (confirmed directly against
// contracts/midnight/compiled/eligibility_gate/contract/index.d.ts:
// `dvTokensPurchased: { ..., [Symbol.iterator](): Iterator<[Uint8Array,
// bigint]> }`). Same query -> decode -> iterate shape, reused rather than
// re-derived.
//
// Governor-side building block for the allocation-tree pipeline: this
// gives the real (userPubKeyHex, dvAmount) pairs for every real DarkVeil
// buyer, keyed by Midnight UserPublicKey — cross-referencing each key back
// to a real Cardano wallet (needed for bonding_curve_tier_b.ak's
// hash_dv_leaf's `vkh` field) is a SEPARATE step, done by the PHP-side
// batch job using darkveil-registration.php's own intake registry (which
// already recorded each registrant's (cardano_address, midnight_pub_key)
// pair at registration time) — this module deliberately does not attempt
// that binding itself, matching the documented trust boundary
// (the governor's off-chain computation is trusted, not re-derived here).
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { ledger } from '../contracts/midnight/compiled/eligibility_gate/contract/index.js';

type ContractAddress = string;

export interface DvPurchase {
  userPubKeyHex: string;
  dvAmount: string; // decimal string — bigint doesn't survive JSON.stringify
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Minimal shape this needs from a decoded Ledger — kept narrow so tests can construct fakes without touching real Midnight runtime types. */
export interface DecodedEligibilityGateLedger {
  dvTokensPurchased: Iterable<[Uint8Array, bigint]>;
}

/** Pure extraction logic — no I/O, trivially testable. Only real (nonzero) purchases are returned; a zero entry (never legitimately written by revealBuyCommit, which always increments by a positive tokenAmount) is filtered defensively rather than assumed impossible. */
export function extractDvPurchases(decoded: DecodedEligibilityGateLedger): DvPurchase[] {
  const out: DvPurchase[] = [];
  for (const [userPubKey, dvAmount] of decoded.dvTokensPurchased) {
    if (dvAmount > 0n) {
      out.push({
        userPubKeyHex: bytesToHex(userPubKey),
        dvAmount: dvAmount.toString(),
      });
    }
  }
  return out;
}

/** Real I/O wrapper — queries the indexer's current contract state and decodes it via the compiled contract's own generated ledger() function. */
export async function readDvPurchases(
  publicDataProvider: PublicDataProvider,
  contractAddress: ContractAddress,
): Promise<{ deployed: boolean; purchases: DvPurchase[] }> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    return { deployed: false, purchases: [] };
  }
  const decoded = ledger(contractState.data);
  return { deployed: true, purchases: extractDvPurchases(decoded) };
}
