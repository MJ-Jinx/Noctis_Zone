// ============================================================================
// Noctis Zone — Tier A Preprod Milestone, Phase 5
// Real Cardano transaction submitter for graduation: bonding_curve.ak's
// Graduate + lp_escrow.ak's SealLock + vesting.ak's StartVesting.
// ============================================================================
// Finding (2026-07-17): the original design fired all 3 redeemers in
// ONE transaction (see finding #5 in TIER_A_PREPROD_MILESTONE.md's header).
// A real Preprod submission against patched bytecode (bonding_curve.ak
// and lp_escrow.ak both grew — the validity_range_is_narrow helper is
// compiled into the shared `spend` entry point every redeemer shares, not
// just ExpireCurve/ExecuteDexChange) came in at 16387 bytes — 3 over
// Cardano's real 16384-byte tx size cap. Investigated true CIP-33 reference
// scripts as the fix (deploy each validator once, reference it instead of
// re-embedding); ruled out after reading @lucid-evolution/lucid's own
// bundled source directly (both the installed 0.5.5 and the latest 0.6.0
// tarball) — `collectFrom`'s witness-building always calls
// `PlutusScriptWitness.new_script(script)` unconditionally, never
// `new_ref(hash)`, regardless of any `readFrom`-supplied reference input.
// `readFrom` in this library only adds a reference input for reading a
// UTXO's datum; it does not let `collectFrom` skip re-embedding the script.
// Real fix: split into two transactions. Verified directly against both
// contracts (not assumed) that this is safe:
//   - Graduate's own checks (graduation_funds_left_curve,
//     lp_seeding_output_ok, staking_seeding_output_ok) only inspect the
//     CURRENT transaction's own inputs/outputs — lp_seeding_output_ok looks
//     for a correctly-valued output at lp_escrow's address in Graduate's
//     OWN tx, it does not require lp_escrow's SealLock redeemer to also
//     fire in the same tx.
//   - StartVesting (vesting.ak) checks ONLY the governor signature and its
//     own datum's `vesting_state == NotStarted` — zero reference to
//     bonding_curve.ak or lp_escrow.ak state of any kind.
// So: TX1 = Graduate + SealLock (bonding_curve + lp_escrow scripts, the two
// that ARE coupled via lp_seeding_output_ok / lp_value_received's shared
// lp_ada value). TX2 = StartVesting alone (fully independent). TX2 is built
// only after TX1 is confirmed (lucid.awaitTx) so its fee/collateral input
// selection sees TX1's real spent/change UTxOs, not a stale pre-TX1 set.
// ============================================================================
// Graduate and SealLock are both PERMISSIONLESS (no extra_signatories check
// at all — "the correctness of the resulting real value movement is the
// authorization", same idiom as ExpireCurve/ExecuteDexChange). StartVesting
// is the only one of the three that requires a signature
// (governor_pub_key_hash), so this whole flow still needs the governor's
// key — same CML.PrivateKey.from_extended_bytes() +
// selectWallet.fromAddress() pattern tier-a-curve-submitter.ts's
// activateCurve() already established and proved on real Preprod,
// reused here rather than re-derived.
//
// Timestamp units — MILLISECONDS throughout, matching Cardano's own validity
// range, and verified against each contract's current redeemer logic:
//   - Graduate takes no timestamp parameter at all (bare variant).
//   - SealLock's `timestamp` and vesting's `start_timestamp` are both bound
//     through interval.contains(self.validity_range, ...), so each builder
//     below sets a range and the value must fall inside it.
//   - They are also stored: `lock_timestamp` is what is_lock_expired adds
//     lock_duration to, and `vest_start_timestamp` is what ClaimVested
//     subtracts from current_timestamp. Both of those comparisons are in ms,
//     so storing seconds here would make a vesting schedule read as complete
//     from its first day.

import type { Assets, LucidEvolution, Network as LucidNetwork, SpendingValidator, UTxO } from '@lucid-evolution/lucid';
import { Blockfrost, CML, Constr, Data, Lucid, validatorToAddress } from '@lucid-evolution/lucid';
import { selectLaunchUtxo } from './launch-utxo-lookup.js';
import { BONDING_CURVE_REDEEMER, LP_ESCROW_REDEEMER, VESTING_REDEEMER } from './redeemer-indices.js';
import {
  type BondingCurveDatumData,
  BondingCurveDatumSchema,
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

/** Same conversion tier-a-curve-submitter.ts's activateCurve() already
 *  proved on real Preprod — reused verbatim rather than re-derived. */
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

export interface TierAGraduationConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  bondingCurveScriptCbor: string;
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

export class TierAGraduationSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private bondingCurveValidator: SpendingValidator;
  private lpEscrowValidator: SpendingValidator;
  private vestingValidator: SpendingValidator;
  private bondingCurveAddress: string;
  private lpEscrowAddress: string;
  private vestingAddress: string;

  constructor(private config: TierAGraduationConfig) {
    this.bondingCurveValidator = {
      type: 'PlutusV3',
      script: config.bondingCurveScriptCbor,
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
    // Nothing awaits this until a method runs, so a caller that constructs the
    // submitter and then fails before calling one leaves the rejection with no
    // handler — and Node prints it to stderr after the real answer has already
    // been written to stdout. Attaching a no-op handler marks it handled
    // WITHOUT swallowing it: a later `await this.lucidPromise` still rejects
    // with the same error, which is the whole point (verified, not assumed).
    this.lucidPromise.catch(() => {});
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
   * TX1 of the graduation flow — Graduate (bonding_curve) + SealLock
   * (lp_escrow). See file header for why this is now separate from
   * StartVesting. Independently retriable: safe to call again only if the
   * curve is still Graduated/not-yet-lp_seeded (checked below) — if a prior
   * call already landed on-chain, this throws instead of double-spending.
   *
   * @param lockSealTimestampMs  MILLISECONDS — becomes lp_escrow's
   *   lock_timestamp (real-day-arithmetic field, see file header —
   *   deliberately NOT the same units as ActivateCurve's ms-scale
   *   current_timestamp).
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

    const { utxo: curveUtxo, datum: curveDatum } = await this.findUtxo<BondingCurveDatumData>(
      lucid,
      this.bondingCurveAddress,
      'bondingCurve',
      BondingCurveDatumSchema,
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

    // Fix (2026-07-19, full-suite security audit): total_raised can
    // legitimately go negative or zero after heavy SellTokens
    // activity before a curve's final buy pushes it to 100% sold — the
    // fixed contract now requires total_raised > 0 as a hard precondition
    // for Graduate (see that redeemer's own doc comment for why a
    // zero/negative-backed "Graduated" LP would be worse than just
    // blocking graduation). Fail fast here with a clear message rather
    // than building a transaction the contract will reject.
    if (curveDatum.total_raised <= 0n) {
      throw new Error(
        `total_raised (${curveDatum.total_raised}) is not positive — Graduate requires real, positive backing for the LP. This curve likely saw heavy net selling before reaching 100% sold.`,
      );
    }
    const lpAda = curveDatum.total_raised;
    const tokensLeaving = curveDatum.lp_reserve_tokens + curveDatum.staking_reserve_tokens;
    const tokenUnit = curveDatum.token_policy_id + curveDatum.token_asset_name;

    // ---- bonding_curve's own continuing output (Graduate) ----
    const newCurveAssets = pruneZero({
      lovelace: (curveUtxo.assets.lovelace ?? 0n) - lpAda,
      [tokenUnit]: (curveUtxo.assets[tokenUnit] ?? 0n) - tokensLeaving,
    });
    const newCurveDatum: BondingCurveDatumData = {
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

    // Two contracts, two redeemers, both named rather than numbered. The
    // comment that stood here recorded Graduate as variant 9 while the code
    // sent 8 — the exact drift `redeemer-indices.ts` exists to end, since a
    // wrong index decodes as a different redeemer rather than failing.
    const graduateRedeemer = new Constr(BONDING_CURVE_REDEEMER.Graduate, []);
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
          value: Data.to<BondingCurveDatumData>(newCurveDatum, BondingCurveDatumSchema),
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
      // Multi-script (2 different Plutus validators in one tx) — forcing
      // provider (Blockfrost) evaluation instead of the local WASM/Aiken
      // evaluator, same reasoning as before (rule out a local-evaluator-
      // specific issue with multiple distinct scripts in one transaction).
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
   * TX2 of the graduation flow — StartVesting (vesting.ak). Fully
   * independent of Graduate/SealLock (verified — see file header), so this
   * can be called any time after mint, and independently retried if it
   * fails without needing to touch the curve/lp_escrow state at all.
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
   * sequence, waiting for TX1 to confirm before building TX2 so TX2's fee/
   * collateral UTXO selection sees real post-TX1 governor state. If TX2
   * fails, TX1's hash is NOT lost — it's included in the thrown error so a
   * caller can tell graduation already landed and only StartVesting needs a
   * retry (via startVesting() directly).
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
