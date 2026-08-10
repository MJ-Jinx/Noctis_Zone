// ============================================================================
// Noctis Protocol — Tier B Preprod, graduation submitter
// Real Cardano transaction submitter for a TIER B launch's graduation:
// bonding_curve_tier_b.ak's Graduate + lp_escrow.ak's SealLock +
// vesting.ak's StartVesting.
// ============================================================================
// This is a direct MIRROR of tier-a-graduation-submitter.ts (the proven Tier
// A flow — real Preprod txs a7531f4b… graduate+seal and 09d917d2… Minswap
// pool, TIER_A_PREPROD_MILESTONE.md Phase 5/5b). Everything that made the
// Tier A version correct applies here unchanged, because:
//   - lp_escrow.ak and vesting.ak are SHARED across Tier A and Tier B (one
//     validator each, not tier-specific). SealLock and StartVesting are
//     byte-for-byte the same redeemers with the same variant indices.
//   - Tier B's Graduate arm (bonding_curve_tier_b.ak) is structurally
//     identical to Tier A's — verified directly: same
//     `curve_state == Graduated`, `!lp_seeded`, `!staking_seeded`,
//     `new_datum == expected_datum` (only total_raised→0, lp_seeded→True,
//     staking_seeded→True change), and the same four value-movement helpers
//     (graduation_funds_left_curve / lp_seeding_output_ok /
//     staking_seeding_output_ok / curve_own_output_clean). NO DarkVeil-
//     specific precondition (dv_settled/dv_claimed are untouched, carried
//     through by the contract's own `..datum` spread — mirrored here by our
//     `...curveDatum` spread, which now preserves them because
//     BondingCurveTierBDatumSchema was synced to the real 31-field datum,
//     2026-07-23).
//
// The ONLY differences from the Tier A submitter:
//   - decodes/re-encodes the curve UTXO with BondingCurveTierBDatumSchema
//     (Tier B's genuinely different datum shape — adds dv_allocation_root /
//     dv_claimed / dv_settled).
//   - targets bonding_curve_tier_b.ak's compiled script instead of
//     bonding_curve.ak's.
//
// Graduate's redeemer variant index is 9 on BOTH curves — verified against
// bonding_curve_tier_b.ak's own `pub type BondingCurveTierBRedeemer`
// declaration order (ActivateCurve=0, BuyTokens=1, ClaimDarkVeilTokens=2,
// ClaimCreatorFees=3, ClaimTreasuryFees=4, ClaimOpsFees=5, CancelCurve=6,
// ExpireCurve=7, ClaimBuyback=8, Graduate=9, TriggerCTO=10, DissolveCTO=11,
// AnchorDvAllocationRoot=12), not assumed to match Tier A.
//
// Timestamp units — MILLISECONDS throughout, matching the Tier A submitter
// and Cardano's own validity range. This file is a mirror, and it inherits
// the units along with everything else:
//   - Graduate takes no timestamp parameter at all (bare variant).
//   - SealLock's `timestamp` and vesting's `start_timestamp` are each bound
//     through interval.contains(self.validity_range, ...) in the SHARED
//     lp_escrow.ak / vesting.ak named above, so both builders below set a
//     range and the value must fall inside it.
//   - Both are also stored: `lock_timestamp` is what is_lock_expired adds
//     lock_duration to, and `vest_start_timestamp` is what ClaimVested
//     subtracts from current_timestamp. Those comparisons are ms against
//     ms-scale constants (min_lock_duration, vest_days*86_400_000).
//
// Graduate and SealLock are PERMISSIONLESS; StartVesting requires the
// governor signature. Two-transaction split (TX1 = Graduate + SealLock,
// TX2 = StartVesting alone, built only after TX1 confirms) — same 16384-byte
// tx-size-cap fix and same independence proof as Tier A.
// ============================================================================

import type { Assets, LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { BONDING_CURVE_TIER_B_REDEEMER, LP_ESCROW_REDEEMER, VESTING_REDEEMER } from './redeemer-indices.js';
import {
  type BondingCurveTierBDatumData,
  BondingCurveTierBDatumSchema,
  type LpEscrowDatumData,
  LpEscrowDatumSchema,
  loadValidator,
  type ThreadNftRole,
  type VestingDatumData,
  VestingDatumSchema,
} from './tier-a-schemas.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** Same conversion the Tier A submitter proved on real Preprod — the
 *  governor key is a shared, tier-agnostic role, so this is reused verbatim. */
function extendedHexToBech32PrivateKey(extendedHex: string): string {
  const bytes = fromHex(extendedHex);
  if (bytes.length !== 64) {
    throw new Error(`Expected a 64-byte extended private key (kL||kR), got ${bytes.length} bytes.`);
  }
  return CML.PrivateKey.from_extended_bytes(bytes).to_bech32();
}

/** Cardano's real ledger has no explicit-zero multi-asset entries — a
 *  computed-to-zero token quantity must be dropped from the assets map
 *  entirely, not passed through as 0. */
function pruneZero(assets: Assets): Assets {
  const out: Assets = {};
  for (const [unit, qty] of Object.entries(assets)) {
    if ((qty as bigint) !== 0n) out[unit] = qty as bigint;
  }
  return out;
}

export interface TierBGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveTierBScriptCbor: string;
  lpEscrowScriptCbor: string;
  vestingScriptCbor: string;
  launchIdHex: string;
  /**
   * The launch's thread-NFT policy id, hex, from the platform's own record of
   * the launch. Every state UTXO is authenticated against it — reading the
   * policy off the datum being checked would authenticate that datum against
   * itself. See launch-utxo-lookup.ts.
   */
  threadNftPolicyId: string;
}

export class TierBGraduationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private bondingCurveValidator: SpendingValidator;
  private lpEscrowValidator: SpendingValidator;
  private vestingValidator: SpendingValidator;
  private bondingCurveAddress: string;
  private lpEscrowAddress: string;
  private vestingAddress: string;

  constructor(private config: TierBGraduationConfig) {
    this.bondingCurveValidator = {
      type: 'PlutusV3',
      script: config.bondingCurveTierBScriptCbor,
    };
    this.lpEscrowValidator = {
      type: 'PlutusV3',
      script: config.lpEscrowScriptCbor,
    };
    this.vestingValidator = {
      type: 'PlutusV3',
      script: config.vestingScriptCbor,
    };
    this.bondingCurveAddress = validatorToAddress(config.network, this.bondingCurveValidator);
    this.lpEscrowAddress = validatorToAddress(config.network, this.lpEscrowValidator);
    this.vestingAddress = validatorToAddress(config.network, this.vestingValidator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  }

  /**
   * This launch's own UTXO in one role, authenticated by its thread NFT.
   *
   * All three of these validators are unparameterized, so every launch's
   * curve, escrow and vesting UTXOs sit at three shared addresses. Matching on
   * the datum's `launch_id` alone matched a claim anyone could author, and
   * taking the first match meant a second UTXO answering to the same launch
   * was silently passed over. See launch-utxo-lookup.ts.
   */
  private async findUtxo<T extends { launch_id: string; thread_nft_policy: string }>(
    lucid: LucidEvolution,
    address: string,
    role: ThreadNftRole,
    schema: unknown,
  ): Promise<{ utxo: UTxO; datum: T }> {
    const utxos = await lucid.utxosAt(address);
    return selectLaunchUtxo<T>(utxos, address, this.config.launchIdHex, role, schema, this.config.threadNftPolicyId);
  }

  /**
   * TX1 of the graduation flow — Graduate (bonding_curve_tier_b) + SealLock
   * (lp_escrow). See file header for why this is separate from
   * StartVesting. Independently retriable: if a prior call already landed
   * on-chain, this throws (on the state guards below) instead of
   * double-spending.
   *
   * @param lockSealTimestampMs  MILLISECONDS — becomes lp_escrow's
   *   lock_timestamp, which is_lock_expired adds lock_duration to. See file
   *   header.
   */
  async graduateAndSealLp(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampMs: number,
  ): Promise<{
    txHash: string;
    lpAda: bigint;
    lpReserveTokens: bigint;
    stakingReserveTokens: bigint;
  }> {
    const lucid = await this.lucidPromise;

    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveTierBDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurveTierB',
      BondingCurveTierBDatumSchema,
    );
    const { utxo: lpUtxo, datum: lpDatum } = await this.findUtxo<LpEscrowDatumData>(
      lucid,
      this.lpEscrowAddress,
      'lpEscrow',
      LpEscrowDatumSchema,
    );

    if (curveDatum.curve_state !== 'Graduated') {
      throw new Error(`Curve is not Graduated (state: ${curveDatum.curve_state}) — cannot call Graduate yet.`);
    }
    if (curveDatum.lp_seeded || curveDatum.staking_seeded) {
      throw new Error('Curve already lp_seeded/staking_seeded — Graduate already ran for this launch.');
    }
    if (lpDatum.lock_timestamp !== 0n) {
      throw new Error('lp_escrow already sealed (lock_timestamp != 0) — SealLock already ran for this launch.');
    }

    // total_raised must be real, positive backing for the LP — same
    // guard as the Tier A submitter (fail fast with a clear message rather
    // than building a tx the contract's value helpers will reject).
    if (curveDatum.total_raised <= 0n) {
      throw new Error(
        `total_raised (${curveDatum.total_raised}) is not positive — Graduate requires real, positive backing for the LP. This curve likely saw heavy net selling before reaching 100% sold.`,
      );
    }
    const lpAda = curveDatum.total_raised;
    const tokensLeaving = curveDatum.lp_reserve_tokens + curveDatum.staking_reserve_tokens;
    const tokenUnit = curveDatum.token_policy_id + curveDatum.token_asset_name;

    // ---- bonding_curve_tier_b's own continuing output (Graduate) ----
    // The spread carries every unchanged field through — crucially including
    // Tier B's DarkVeil fields (dv_allocation_root /
    // dv_claimed / dv_settled) and the cto_governance_* fields, matching the
    // contract's own `..datum` spread. Only these three change.
    const newCurveAssets = pruneZero({
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - lpAda,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) - tokensLeaving,
    });
    const newCurveDatum: BondingCurveTierBDatumData = {
      ...curveDatum,
      total_raised: 0n,
      lp_seeded: true,
      staking_seeded: true,
    };

    // ---- lp_escrow's own continuing output (SealLock) ----
    const newLpAssets = pruneZero({
      lovelace: (lpUtxo.assets.lovelace ?? 0n) + lpAda,
      [tokenUnit]: lpDatum.lp_token_amount,
    });
    const newLpDatum: LpEscrowDatumData = {
      ...lpDatum,
      lock_timestamp: BigInt(lockSealTimestampMs),
      lp_state: 'Locked',
    };

    // Named rather than numbered — the comment that stood here recorded
    // Graduate as variant 9 while the code sent 8. `redeemer-indices.ts` is
    // held against the compiled blueprint by a test, so it cannot say that.
    const graduateRedeemer = new Constr(BONDING_CURVE_TIER_B_REDEEMER.Graduate, []);
    const sealLockRedeemer = new Constr(LP_ESCROW_REDEEMER.SealLock, [BigInt(lockSealTimestampMs), lpAda]);

    // SealLock binds its timestamp to the range, so the range has to exist.
    const sealValidFrom = lockSealTimestampMs - 240_000;
    const sealValidTo = lockSealTimestampMs + 240_000;

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .validFrom(sealValidFrom)
      .validTo(sealValidTo)
      .collectFrom([curveUtxo], Data.to(graduateRedeemer))
      .collectFrom([lpUtxo], Data.to(sealLockRedeemer))
      .attach.SpendingValidator(this.bondingCurveValidator)
      .attach.SpendingValidator(this.lpEscrowValidator)
      .pay.ToContract(
        this.bondingCurveAddress,
        {
          kind: 'inline',
          value: Data.to<BondingCurveTierBDatumData>(newCurveDatum, BondingCurveTierBDatumSchema),
        },
        newCurveAssets,
      )
      .pay.ToContract(
        this.lpEscrowAddress,
        {
          kind: 'inline',
          value: Data.to<LpEscrowDatumData>(newLpDatum, LpEscrowDatumSchema),
        },
        newLpAssets,
      )
      .addSigner(governorAddress)
      // Multi-script (2 distinct Plutus validators in one tx) — force
      // provider (Blockfrost) evaluation, same reasoning as the Tier A flow.
      .complete({ localUPLCEval: false });

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return {
      txHash,
      lpAda,
      lpReserveTokens: curveDatum.lp_reserve_tokens,
      stakingReserveTokens: curveDatum.staking_reserve_tokens,
    };
  }

  /**
   * TX2 of the graduation flow — StartVesting (vesting.ak, the SHARED
   * validator). Fully independent of Graduate/SealLock (verified — see file
   * header), so this can be called any time after mint and independently
   * retried.
   *
   * @param vestStartTimestampMs  MILLISECONDS.
   */
  async startVesting(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    vestStartTimestampMs: number,
  ): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;

    const { utxo: vestingUtxo, datum: vestingDatum } = await this.findUtxo<VestingDatumData>(
      lucid,
      this.vestingAddress,
      'vesting',
      VestingDatumSchema,
    );

    if (vestingDatum.vesting_state !== 'NotStarted') {
      throw new Error(`Vesting is not NotStarted (state: ${vestingDatum.vesting_state}) — StartVesting already ran.`);
    }

    const newVestingDatum: VestingDatumData = {
      ...vestingDatum,
      vesting_state: 'Vesting',
      vest_start_timestamp: BigInt(vestStartTimestampMs),
    };

    const startVestingRedeemer = new Constr(VESTING_REDEEMER.StartVesting, [BigInt(vestStartTimestampMs)]);

    // StartVesting binds start_timestamp to the range the same way.
    const vestValidFrom = vestStartTimestampMs - 240_000;
    const vestValidTo = vestStartTimestampMs + 240_000;

    const bech32Key = extendedHexToBech32PrivateKey(governorPrivateKeyExtendedHex);
    const governorUtxos = await lucid.utxosAt(governorAddress);
    lucid.selectWallet.fromAddress(governorAddress, governorUtxos);

    const tx = await lucid
      .newTx()
      .validFrom(vestValidFrom)
      .validTo(vestValidTo)
      .collectFrom([vestingUtxo], Data.to(startVestingRedeemer))
      .attach.SpendingValidator(this.vestingValidator)
      .pay.ToContract(
        this.vestingAddress,
        {
          kind: 'inline',
          value: Data.to<VestingDatumData>(newVestingDatum, VestingDatumSchema),
        },
        vestingUtxo.assets,
      )
      .addSigner(governorAddress)
      .complete();

    const signed = await tx.sign.withPrivateKey(bech32Key).complete();
    const txHash = await signed.submit();

    return { txHash };
  }

  /**
   * Convenience wrapper: runs graduateAndSealLp() then startVesting() in
   * sequence, waiting for TX1 to confirm before building TX2. If TX2 fails,
   * TX1's hash is preserved in the thrown error so a caller can tell
   * graduation already landed and only StartVesting needs a retry.
   *
   * @param lockSealTimestampMs  MILLISECONDS — used for both
   *   lp_escrow's lock_timestamp and vesting's vest_start_timestamp.
   */
  async graduate(
    governorPrivateKeyExtendedHex: string,
    governorAddress: string,
    lockSealTimestampMs: number,
  ): Promise<{
    graduateSealLockTxHash: string;
    startVestingTxHash: string;
    lpAda: bigint;
    lpReserveTokens: bigint;
    stakingReserveTokens: bigint;
  }> {
    const lucid = await this.lucidPromise;

    const step1 = await this.graduateAndSealLp(governorPrivateKeyExtendedHex, governorAddress, lockSealTimestampMs);

    await lucid.awaitTx(step1.txHash);

    let step2TxHash: string;
    try {
      const step2 = await this.startVesting(governorPrivateKeyExtendedHex, governorAddress, lockSealTimestampMs);
      step2TxHash = step2.txHash;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `graduateAndSealLp succeeded (txHash: ${step1.txHash}) but startVesting failed: ${message}. ` +
          'Retry with startVesting() directly — do not re-run graduate().',
      );
    }

    return {
      graduateSealLockTxHash: step1.txHash,
      startVestingTxHash: step2TxHash,
      lpAda: step1.lpAda,
      lpReserveTokens: step1.lpReserveTokens,
      stakingReserveTokens: step1.stakingReserveTokens,
    };
  }
}

export { loadValidator };
