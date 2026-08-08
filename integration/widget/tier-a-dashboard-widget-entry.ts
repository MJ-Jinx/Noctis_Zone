// ============================================================================
// Noctis Protocol — Tier A Creator Dashboard Widget: browser entry point
// ============================================================================
// Webpack browser target (integration/webpack.widgets.config.cjs) — bundled
// to assets/js/tier-a-dashboard-widget.bundle.js in the theme, enqueued only
// on a creator's own dashboard page for a Tier A launch, following the exact
// pattern inc/enqueue.php already uses for tier-a-buy-widget.bundle.js on
// lp-chart-buy.php.
//
// Exposes window.NoctisTierADashboard, a plain object of async functions the
// theme's vanilla JS calls directly from DOM event handlers — same shape as
// window.NoctisTierABuy (tier-a-buy-widget-entry.ts).
//
// WHY THIS IS A SEPARATE BUNDLE: ClaimVested (vesting.ak) and
// ClaimCreatorFees (bonding_curve.ak) are both custom-Plutus-redeemer
// spends — the same Anvil-can't-do-this gap tier-a-buy-widget-entry.ts's
// own header already documents for BuyTokens. This widget needs Lucid
// Evolution running IN THE BROWSER, signing via the connected wallet's real
// CIP-30 API, via tier-a-claims-submitter.ts's claimVestedWithWallet()/
// claimCreatorFeesWithWallet().
//
// HONEST SCOPE — read before wiring a template to this:
//
// 1. Same Blockfrost-key-in-page-source limitation as tier-a-buy-widget-
//    entry.ts's own scope note — not solved here either.
//
// 2. This widget only ever calls the *WithWallet() variants (creator-
//    signed via their own connected wallet). The private-key-based
//    claimVested()/claimCreatorFees() (this session's CLI verification
//    path) are deliberately NOT exposed here — same reasoning as the buy
//    widget never exposing ActivateCurve or the mnemonic-based buyTokens().
//
// 3. getVestingState() computes `vestedToDate`/`claimable` CLIENT-SIDE using
//    the browser's real current wall-clock time (Date.now()), mirroring
//    vesting.ak's own exact formula (token_allocation * elapsed_seconds /
//    vest_seconds, floor division) — this is the real, honest "how much can
//    I claim right now" figure for an actual creator, not a backdated test
//    value. It reads live on-chain state on every call (no caching), same
//    "stale price could get a tx rejected" reasoning as the buy widget's
//    getCurveState().
// ============================================================================

import type { Network as LucidNetwork, WalletApi } from '@lucid-evolution/lucid';
import { getAddressDetails } from '@lucid-evolution/lucid';
import { type TierAClaimsConfig, TierAClaimsSubmitter } from '../tier-a-claims-submitter.js';

export interface TierADashboardWidgetConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** vesting.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for vesting.vesting.spend. */
  vestingScriptCbor: string;
  /** bonding_curve.ak's compiled PlutusV3 script CBOR — plutus.json's
   *  validators[].compiledCode for bonding_curve.bonding_curve.spend. */
  bondingCurveScriptCbor: string;
  launchIdHex: string;
}

export interface VestingStateSummary {
  vestingState: string;
  tokenAllocation: string;
  claimedTokens: string;
  vestDays: string;
  vestStartTimestamp: string;
  /** Computed client-side against real current time — floor(token_allocation * elapsed / (vestDays*86400)). */
  vestedToDate: string;
  /** vestedToDate - claimedTokens, floored at 0. */
  claimable: string;
}

export interface CreatorFeesStateSummary {
  creatorFeesAccrued: string;
  ctoTriggered: boolean;
}

let config: TierADashboardWidgetConfig | null = null;
let submitter: TierAClaimsSubmitter | null = null;

function requireSubmitter(): TierAClaimsSubmitter {
  if (!config || !submitter) {
    throw new Error('NoctisTierADashboard.configure() must be called before any other method.');
  }
  return submitter;
}

function configure(newConfig: TierADashboardWidgetConfig): void {
  config = newConfig;
  const submitterConfig: TierAClaimsConfig = {
    blockfrostProjectId: newConfig.blockfrostProjectId,
    blockfrostUrl: newConfig.blockfrostUrl,
    network: newConfig.network,
    vestingScriptCbor: newConfig.vestingScriptCbor,
    bondingCurveScriptCbor: newConfig.bondingCurveScriptCbor,
    launchIdHex: newConfig.launchIdHex,
  };
  submitter = new TierAClaimsSubmitter(submitterConfig);
}

async function getVestingState(): Promise<VestingStateSummary> {
  const s = requireSubmitter();
  const datum = await s.readVestingDatum();

  let vestedToDate = 0n;
  if (datum.vesting_state === 'Vesting' || datum.vesting_state === 'FullyClaimed') {
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    const elapsedSeconds = nowSeconds - datum.vest_start_timestamp;
    const vestSeconds = datum.vest_days * 86400n;
    if (elapsedSeconds > 0n && vestSeconds > 0n) {
      vestedToDate = (datum.token_allocation * elapsedSeconds) / vestSeconds;
      if (vestedToDate > datum.token_allocation) vestedToDate = datum.token_allocation;
    }
  }
  const claimableRaw = vestedToDate - datum.claimed_tokens;
  const claimable = claimableRaw > 0n ? claimableRaw : 0n;

  return {
    vestingState: datum.vesting_state,
    tokenAllocation: datum.token_allocation.toString(),
    claimedTokens: datum.claimed_tokens.toString(),
    vestDays: datum.vest_days.toString(),
    vestStartTimestamp: datum.vest_start_timestamp.toString(),
    vestedToDate: vestedToDate.toString(),
    claimable: claimable.toString(),
  };
}

async function getCreatorFeesState(): Promise<CreatorFeesStateSummary> {
  const s = requireSubmitter();
  const datum = await s.readCurveDatum();
  return {
    creatorFeesAccrued: datum.creator_fees_accrued.toString(),
    ctoTriggered: datum.cto_triggered,
  };
}

/**
 * Real claim. `claimAmount` must be a whole number of tokens (as a string,
 * to survive JSON/DOM round-tripping without float precision loss) — the
 * caller (theme JS) is responsible for not exceeding getVestingState()'s
 * live `claimable` figure, not a stale server-rendered value.
 */
async function claimVested(params: { claimAmount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  const currentTimestampSeconds = Math.floor(Date.now() / 1000);
  const result = await s.claimVestedWithWallet(params.walletApi, BigInt(params.claimAmount), currentTimestampSeconds);
  return { txHash: result.txHash };
}

async function claimCreatorFees(params: { amount: string; walletApi: WalletApi }): Promise<{ txHash: string }> {
  const s = requireSubmitter();
  const result = await s.claimCreatorFeesWithWallet(params.walletApi, BigInt(params.amount));
  return { txHash: result.txHash };
}

/**
 * Derives a connected wallet's payment-credential key hash from its bech32
 * address — WeldPress's own wallet state doesn't expose this directly
 * (only the bech32 address itself), so the theme's glue JS calls this to
 * compare against the launch's real on-chain creator_pub_key_hash before
 * showing the claim panels. Same derivation
 * tier-a-curve-submitter.ts's buyerKeyHashFromAddress() already uses
 * server/CLI-side, exposed here for the browser.
 */
function getPaymentKeyHash(address: string): string | null {
  return getAddressDetails(address).paymentCredential?.hash ?? null;
}

const NoctisTierADashboard = {
  configure,
  getVestingState,
  getCreatorFeesState,
  claimVested,
  claimCreatorFees,
  getPaymentKeyHash,
};

declare global {
  interface Window {
    NoctisTierADashboard: typeof NoctisTierADashboard;
  }
}

if (typeof window !== 'undefined') {
  window.NoctisTierADashboard = NoctisTierADashboard;
}

export default NoctisTierADashboard;
