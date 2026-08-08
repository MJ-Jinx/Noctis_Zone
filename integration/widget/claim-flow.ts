// ============================================================================
// Noctis Protocol — DarkVeil widget: Tier B claim flow
// ============================================================================
// Thin wrapper around darkveil-claim-submitter.ts's real Lucid Evolution
// submitter. Unlike registration/buy-flow, this needs NO ContractProviders
// (it's a plain Cardano transaction) — just the buyer's own connected
// Cardano wallet API object.
//
// dvAmount/salt/merkleProof are inputs to this module, not something it
// fetches. They come from a DIFFERENT Merkle tree than registration's
// allowlist — bonding_curve_tier_b.ak's dv_allocation_root, built by the
// governor/relayer AFTER DarkVeil closes, containing each buyer's actual
// purchased amount (see the DarkVeil claim settlement design).
// darkveil-registration.php's allowlist-proof endpoint serves the EARLIER
// registration-eligibility tree, so it is not the source for these.
// Serving a buyer their own allocation proof is dedicated per-buyer work:
// it belongs behind an endpoint that returns one buyer's own leaf, which is
// what keeps the rest of the roster private. Callers supply these three
// values; this module deliberately fetches nothing.
// ============================================================================

import type { WalletApi } from '@lucid-evolution/lucid';
import { LucidDarkVeilClaimSubmitter, type LucidDarkVeilClaimSubmitterConfig } from '../darkveil-claim-submitter.js';

export interface ClaimTierBParams {
  dvAmount: bigint;
  salt: Uint8Array;
  merkleProof: Array<{ sibling: Uint8Array; goesLeft: boolean }>;
  buyerKeyHash: Uint8Array;
}

/**
 * `walletApi` is the raw CIP-30 API object (e.g. `await window.cardano[walletId].enable()`)
 * — the buyer signs and pays for this transaction themselves, no relayer
 * key involved.
 */
export async function claimTierBTokens(
  config: LucidDarkVeilClaimSubmitterConfig,
  walletApi: WalletApi,
  params: ClaimTierBParams,
): Promise<{ txHash: string }> {
  const submitter = new LucidDarkVeilClaimSubmitter(config);
  return submitter.claimDarkVeilTokens(walletApi, {
    dvAmount: params.dvAmount,
    salt: params.salt,
    merkleProof: params.merkleProof,
    buyerKeyHash: params.buyerKeyHash,
  });
}
