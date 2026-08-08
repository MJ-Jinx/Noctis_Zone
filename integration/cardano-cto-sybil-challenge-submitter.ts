// ============================================================================
// Noctis Protocol — Real Cardano transaction submitter for
// contracts/cardano/validators/cto_sybil_challenge.ak
// ============================================================================
// The submission/resolution half of item #16's off-chain evidence pipeline
// (integration/cto-sybil-challenge-evidence.ts builds the evidence this
// submitter deposits a bond against).
//
// Two real transactions, two different signers:
//   - submitChallenge — the CHALLENGER's own wallet pays the bond
//     (NHOP_CHALLENGE_BOND, 25 ADA) and deposits it plus an inline datum at
//     the contract's fixed script address. This needs no SpendingValidator
//     attached and no redeemer at all — creating a script UTXO requires no
//     validator approval, only SPENDING one does (same insight
//     CLAUDE.md's staking_pool.ak section already documents: "Staking
//     itself needs no validator redeemer at all"). Modeled on
//     darkveil-claim-submitter.ts's buyer-wallet-signed pattern
//     (lucid.selectWallet.fromAPI).
//   - resolveChallenge — GOVERNOR-signed (matches the validator's own
//     list.has(self.extra_signatories, datum.governor_pub_key_hash) check),
//     spends the challenge UTXO with ResolveChallenge, paying either the
//     challenger in full (Upheld) or treasury+ops split 60/40 (Rejected).
//     Modeled on cardano-cto-anchor-submitter.ts's relayer-private-key
//     pattern.
//
// Datum/redeemer schema hand-mirrored from a FRESHLY REGENERATED
// contracts/cardano/plutus.json (`aiken build`, 2026-07-19) — field
// names/order/constructor index (0, the only redeemer variant) read
// directly from the blueprint's real JSON, not from the .ak source
// comments — same discipline every other submitter in this session
// established (earlier fixes already document this codebase's drift risk on
// exactly this point).
//
// What is NOT tested: an actual end-to-end submission against a live
// Cardano node — needs funded challenger/governor keys and a deployed
// contract instance, neither available in this dev environment. Same
// honest boundary as every other submitter in this codebase.
// ============================================================================

import type {
  LucidEvolution,
  Network as LucidNetwork,
  SpendingValidator,
  UTxO,
  WalletApi,
} from '@lucid-evolution/lucid';
import {
  Blockfrost,
  credentialToAddress,
  Data,
  getAddressDetails,
  Lucid,
  validatorToAddress,
} from '@lucid-evolution/lucid';

// ============================================================================
// DATA SCHEMAS — mirror the fresh contracts/cardano/plutus.json exactly
// ============================================================================

const CtoSybilChallengeDatumShape = Data.Object({
  launch_id: Data.Bytes(),
  governor_pub_key_hash: Data.Bytes(),
  challenged_voter_key: Data.Bytes(),
  challenged_proposal_id: Data.Bytes(),
  challenger_key_hash: Data.Bytes(),
  bond_amount: Data.Integer(),
  submitted_at: Data.Integer(),
  evidence_hash: Data.Bytes(),
  treasury_pub_key_hash: Data.Bytes(),
  ops_pub_key_hash: Data.Bytes(),
});
type CtoSybilChallengeDatumData = Data.Static<typeof CtoSybilChallengeDatumShape>;
const CtoSybilChallengeDatumSchema = CtoSybilChallengeDatumShape as unknown as CtoSybilChallengeDatumData;

/**
 * ResolveChallenge — the only real redeemer variant (constructor index 0,
 * verified against the fresh blueprint, 2026-07-19). A plain Data.Object is
 * sufficient since this is the sole variant — same reasoning
 * cardano-cto-anchor-submitter.ts already established for AnchorVoteResult.
 */
const ResolveChallengeRedeemerShape = Data.Object({
  upheld: Data.Boolean(),
  current_timestamp: Data.Integer(),
});
type ResolveChallengeRedeemerData = Data.Static<typeof ResolveChallengeRedeemerShape>;
const ResolveChallengeRedeemerSchema = ResolveChallengeRedeemerShape as unknown as ResolveChallengeRedeemerData;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ============================================================================
// PARAMS
// ============================================================================

export interface SubmitChallengeParams {
  launchId: Uint8Array;
  governorPubKeyHash: Uint8Array;
  challengedVoterKey: Uint8Array;
  challengedProposalId: Uint8Array;
  bondAmountLovelace: bigint;
  evidenceHash: Uint8Array;
  treasuryPubKeyHash: Uint8Array;
  opsPubKeyHash: Uint8Array;
}

export interface ResolveChallengeParams {
  launchId: Uint8Array;
  /** Distinguishes multiple open challenges for the same launch (a launch may accumulate several over time). Matched against challenged_voter_key + challenged_proposal_id in the datum. */
  challengedVoterKey: Uint8Array;
  challengedProposalId: Uint8Array;
  upheld: boolean;
  currentTimestamp: bigint;
}

// ============================================================================
// SUBMITTER
// ============================================================================

export interface CardanoCtoSybilChallengeSubmitterConfig {
  blockfrostProjectId: string;
  blockfrostUrl: string;
  network: LucidNetwork;
  /** cto_sybil_challenge.ak's compiled PlutusV3 script CBOR — plutus.json's `validators[].compiledCode` for `cto_sybil_challenge.cto_sybil_challenge.spend`. One fixed address shared by every launch, same pattern as every other Tier A/B validator (no constructor params). */
  compiledScriptCbor: string;
  /** Governor's private key — only used by resolveChallenge, never by submitChallenge (which is challenger-wallet-signed). */
  governorPrivateKey?: string;
}

export class CardanoCtoSybilChallengeSubmitter {
  private lucidPromise: Promise<LucidEvolution>;
  private validator: SpendingValidator;
  private scriptAddress: string;

  constructor(private config: CardanoCtoSybilChallengeSubmitterConfig) {
    this.validator = { type: 'PlutusV3', script: config.compiledScriptCbor };
    this.scriptAddress = validatorToAddress(config.network, this.validator);
    this.lucidPromise = Lucid(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  }

  /** findChallengeUtxo only ever returns a UTXO it already confirmed has a
   *  datum (it skips undatumed UTXOs while scanning below) — this just
   *  makes that invariant explicit at each call site with a clear error
   *  instead of a silent `!` non-null assertion. */
  private requireDatum(utxo: UTxO): string {
    if (!utxo.datum) {
      throw new Error(
        'CTO sybil challenge UTXO has no inline datum (unexpected — findChallengeUtxo should only return UTXOs with one).',
      );
    }
    return utxo.datum;
  }

  private async findChallengeUtxo(
    lucid: LucidEvolution,
    challengedVoterKey: Uint8Array,
    challengedProposalId: Uint8Array,
  ): Promise<UTxO> {
    const utxos = await lucid.utxosAt(this.scriptAddress);
    const voterKeyHex = toHex(challengedVoterKey);
    const proposalIdHex = toHex(challengedProposalId);
    for (const utxo of utxos) {
      if (!utxo.datum) continue;
      let decoded: CtoSybilChallengeDatumData;
      try {
        decoded = Data.from<CtoSybilChallengeDatumData>(utxo.datum, CtoSybilChallengeDatumSchema);
      } catch {
        continue;
      }
      if (decoded.challenged_voter_key === voterKeyHex && decoded.challenged_proposal_id === proposalIdHex) {
        return utxo;
      }
    }
    throw new Error(
      `No open cto_sybil_challenge UTXO found for voter_key ${voterKeyHex} / proposal ${proposalIdHex} at ${this.scriptAddress}`,
    );
  }

  /**
   * Challenger-initiated: a plain deposit at the fixed script address, no
   * SpendingValidator attach and no redeemer needed — creating a script
   * UTXO needs no validator approval. Signed by the challenger's own
   * connected wallet, which pays the real bond.
   */
  async submitChallenge(walletApi: WalletApi, params: SubmitChallengeParams): Promise<{ txHash: string }> {
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromAPI(walletApi);

    const challengerAddress = await lucid.wallet().address();
    const challengerKeyHash = getAddressDetails(challengerAddress).paymentCredential?.hash;
    if (!challengerKeyHash) {
      throw new Error('Connected wallet has no resolvable payment key hash — cannot submit as challenger.');
    }

    // MILLISECONDS: the defence window is measured from this field, and the
    // resolve path compares it against a timestamp bound to the transaction's
    // own validity range, which Cardano expresses in ms.
    const submittedAt = BigInt(Date.now());

    const datum: CtoSybilChallengeDatumData = {
      launch_id: toHex(params.launchId),
      governor_pub_key_hash: toHex(params.governorPubKeyHash),
      challenged_voter_key: toHex(params.challengedVoterKey),
      challenged_proposal_id: toHex(params.challengedProposalId),
      challenger_key_hash: challengerKeyHash,
      bond_amount: params.bondAmountLovelace,
      submitted_at: submittedAt,
      evidence_hash: toHex(params.evidenceHash),
      treasury_pub_key_hash: toHex(params.treasuryPubKeyHash),
      ops_pub_key_hash: toHex(params.opsPubKeyHash),
    };

    const tx = await lucid
      .newTx()
      .pay.ToContract(
        this.scriptAddress,
        {
          kind: 'inline',
          value: Data.to<CtoSybilChallengeDatumData>(datum, CtoSybilChallengeDatumSchema),
        },
        { lovelace: params.bondAmountLovelace },
      )
      .addSigner(challengerAddress)
      .complete();

    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    return { txHash };
  }

  /**
   * Governor-initiated resolution. Pays out per the Upheld/Rejected split
   * the validator itself enforces — see cto_sybil_challenge.ak's
   * ResolveChallenge and{} block, mirrored exactly here since the
   * validator checks the real output values, not a claim.
   */
  async resolveChallenge(params: ResolveChallengeParams): Promise<{ txHash: string }> {
    if (!this.config.governorPrivateKey) {
      throw new Error('resolveChallenge requires governorPrivateKey in the submitter config.');
    }
    const lucid = await this.lucidPromise;
    lucid.selectWallet.fromPrivateKey(this.config.governorPrivateKey);

    const challengeUtxo = await this.findChallengeUtxo(lucid, params.challengedVoterKey, params.challengedProposalId);
    const datum = Data.from<CtoSybilChallengeDatumData>(this.requireDatum(challengeUtxo), CtoSybilChallengeDatumSchema);

    const redeemer: ResolveChallengeRedeemerData = {
      upheld: params.upheld,
      current_timestamp: params.currentTimestamp,
    };

    // The validator binds current_timestamp through
    // interval.contains(validity_range, ...), so a resolve transaction
    // without a range is refused outright.
    const resolveValidFrom = Number(params.currentTimestamp) - 240_000;
    const resolveValidTo = Number(params.currentTimestamp) + 240_000;

    let txBuilder = lucid
      .newTx()
      .validFrom(resolveValidFrom)
      .validTo(resolveValidTo)
      .collectFrom([challengeUtxo], Data.to<ResolveChallengeRedeemerData>(redeemer, ResolveChallengeRedeemerSchema))
      .attach.SpendingValidator(this.validator);

    if (params.upheld) {
      const challengerAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.challenger_key_hash,
      });
      txBuilder = txBuilder.pay.ToAddress(challengerAddress, {
        lovelace: datum.bond_amount,
      });
    } else {
      const treasuryShare = (datum.bond_amount * 60n) / 100n;
      const opsShare = datum.bond_amount - treasuryShare;
      const treasuryAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.treasury_pub_key_hash,
      });
      const opsAddress = credentialToAddress(this.config.network, {
        type: 'Key',
        hash: datum.ops_pub_key_hash,
      });
      txBuilder = txBuilder.pay
        .ToAddress(treasuryAddress, { lovelace: treasuryShare })
        .pay.ToAddress(opsAddress, { lovelace: opsShare });
    }

    const tx = await txBuilder.addSigner(datum.governor_pub_key_hash).complete();
    const signed = await tx.sign.withPrivateKey(this.config.governorPrivateKey).complete();
    const txHash = await signed.submit();
    return { txHash };
  }
}

export { toHex };
