// ============================================================================
// Noctis Protocol — Cardano L1 CTO Governance Contract (Aiken)
// Used by Tier A, Tier B, and Tier C (CLAUDE.md Contract Architecture table)
// ============================================================================
// This contract is the Cardano L1 anchor for the Midnight CTO Governance PSM.
// It records the results of community takeover votes that happen privately
// on Midnight, making them publicly verifiable on Cardano.
//
// Key properties:
//   1. Anchors vote results from Midnight (open relay — any token holder
//      can submit the anchor with a signed proof bundle)
//   2. Records: proposal type, vote counts, creator vote composition,
//      quorum status, pass/fail, execution status
//   3. Once anchored, results are immutable — no reversal possible
//   4. Supports the full CTO lifecycle: trigger, vote, finalize, execute, dissolve
//
// Anchor resolution: Open relay (Option C) — any token holder can submit the
// anchor transaction using the signed proof bundle from Midnight. The
// contract only checks the proof bundle hash is present and the business
// rules (quorum, creator cap) hold — no signer authorization is required
// for this specific redeemer, by design.
//
// Creator vote resolution: Creator vote composition is recorded as an audit field.
// The community can see how many creator tokens voted yes/no.
//
// Lifecycle:
//   1. Creator goes silent (90+ days, tracked on Midnight)
//   2. Community creates proposal on Midnight cto_governance PSM
//   3. 72-hour ballot window — private voting on Midnight
//   4. Ballot closes — anyone can finalize on Midnight
//   5. Open relay: anyone submits the result to this Cardano anchor
//   6. Once anchored, the CTO is considered "triggered" on Cardano L1
//   7. Creator escrow + LP escrow contracts check this anchor for CTO status
//   8. If creator returns, community can dissolve CTO (another vote + anchor)
//
// Rewritten 2026-07-09 to match real Aiken v1.1.23 syntax — see
// bonding_curve.ak's header comment for the full explanation. Governor/
// community authorization now uses `self.extra_signatories` instead of
// manually re-verifying a signature passed through the redeemer.
// "Current time" checks (execution window) take an explicit
// `current_timestamp` redeemer field verified against the transaction's
// actual validity range via `interval.contains` — Cardano scripts can't
// read a wall-clock time directly, only reason about the tx's declared
// validity interval.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use aiken/interval.{Interval, IntervalBoundType}
use cardano/address.{Address, Credential, VerificationKey, from_verification_key,
  with_delegation_key}
use cardano/assets.{PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/lp_escrow_datum.{Locked, LpEscrowDatum}
use noctis/settlement
use noctis/thread_nft

/// Same finding/fix as Tier A's bonding_curve.ak — see that file's own
/// comment on `validity_range_is_narrow` for the full explanation. Applies
/// here to `AnchorProposal` (open-relay/permissionless by design) and
/// `ExpireProposal` (also permissionless) — NOT `ExecuteProposal`, which
/// requires a real governor-or-community signature (same "trusted signer"
/// exemption as `ActivateCurve`).
fn validity_range_is_narrow(range: Interval, max_width: Int) -> Bool {
  when (range.lower_bound.bound_type, range.upper_bound.bound_type) is {
    (IntervalBoundType.Finite(lo), IntervalBoundType.Finite(hi)) ->
      hi >= lo && hi - lo <= max_width
    _ -> False
  }
}

const max_validity_range_width = 600_000

// ============================================================================
// TYPES
// ============================================================================

/// CTO lifecycle states on Cardano L1
pub type CtoAnchorState {
  /// No CTO activity yet — creator is active
  PreCTO
  /// A CTO vote has been anchored — the community voted to trigger CTO
  CTOTriggered
  /// CTO was dissolved — creator returned and community voted to dissolve
  CTODissolved
}

/// Proposal types (mirrors Midnight cto_governance.compact)
pub type ProposalType {
  SilenceLockTrigger
  FundAllocation
  DexMigration
  WhitelistUpdate
  DissolveCTOProposal
}

/// Proposal outcome
pub type ProposalOutcome {
  Passed
  Failed
}

/// Execution status
pub type ExecutionStatus {
  PendingExecution
  Executed
  Expired
}

/// A proposal result anchored from Midnight
pub type ProposalAnchor {
  proposal_type: ProposalType,
  // Hash of the off-chain proposal description
  description_hash: ByteArray,
  // Midnight proof bundle hash (verifies the vote was legitimate)
  proof_bundle_hash: ByteArray,
  // Vote results
  yes_votes: Int,
  // Total YES token-weight
  no_votes: Int,
  // Total NO token-weight
  voter_count: Int,
  // Number of unique voters
  // Creator vote audit
  creator_yes_votes: Int,
  // Creator's YES weight (capped at 2%)
  creator_no_votes: Int,
  // Creator's NO weight (capped at 2%)
  // Outcome
  outcome: ProposalOutcome,
  // Timing
  start_timestamp: Int,
  // Ballot start (on Midnight)
  end_timestamp: Int,
  // Ballot end (on Midnight)
  anchor_timestamp: Int,
  // When this was anchored on Cardano
  // Execution
  execution_status: ExecutionStatus,
  // Execution payload (what happens when executed)
  target_dex_credential: Option<Credential>,
  // For DexMigration / WhitelistUpdate
  allocation_amount: Int,
  // For FundAllocation
  allocation_recipient_hash: VerificationKeyHash,
  // For FundAllocation
  // Relayer who anchored this (open relay)
  relayer_credential_hash: VerificationKeyHash,
}

/// The datum stored at the CTO Governance anchor UTxO
pub type CtoGovernanceDatum {
  // Launch identity
  launch_id: ByteArray,
  // Current CTO state on Cardano L1
  cto_state: CtoAnchorState,
  // Community wallet hash (set when CTO triggered, cleared when dissolved)
  community_wallet_hash: VerificationKeyHash,
  // Governor credential hash (platform admin for emergency actions)
  governor_credential_hash: VerificationKeyHash,
  // Total token supply (for quorum verification)
  total_supply: Int,
  // Quorum threshold in basis points (500 = 5%)
  quorum_bps: Int,
  // Anti-whale-takeover fix (2026-07-28): this used to be creator-only
  // (200 = 2%) — now the SAME cap applies to every voter's counted
  // weight on the Midnight side (cto_governance.compact's maxVoterCap),
  // not just the creator's. Field name kept as-is to limit blast radius
  // (every deploy/off-chain caller that constructs this datum), but the
  // value is now 100 (1%). This remains a defense-in-depth re-check of
  // the CREATOR's own aggregate specifically — the general per-voter cap
  // is enforced per-vote on Midnight, which this anchor has no way to
  // re-verify after the fact (only the aggregate creator tally is here).
  creator_vote_cap_bps: Int,
  // Anti-whale-takeover fix (2026-07-28): minimum distinct voters required
  // for quorum, alongside quorum_bps — mirrors cto_governance.compact's
  // minVoterCount. Closes the gap where a single large-enough wallet could
  // satisfy quorum and majority entirely alone.
  min_voter_count: Int,
  // Active proposal anchor (if any)
  active_proposal: Option<ProposalAnchor>,
  // Proposal history count
  proposal_count: Int,
  // Fix: set (never cleared) by ExecuteProposal, independent
  // of active_proposal — which ClearProposal (governor-only) can wipe.
  // Without this, a governor could let a vote pass, then call
  // ClearProposal before any downstream TriggerCTO/DissolveCTO reference-
  // input check ever ran against it, silently erasing the only on-chain
  // evidence a real vote happened and reopening the exact bare-signature
  // trust gap this fix exists to close. This field is the permanent
  // record those downstream checks read instead. A later proposal
  // overwrites it, but the mandatory cooldown_duration between any two
  // proposals gives a wide real-world window to act on it first.
  last_executed_proposal: Option<ProposalAnchor>,
  // Fix (2026-07-19, full-suite security audit): CRITICAL finding —
  // AnchorVoteResult (open relay) never verified the "proof bundle"
  // against anything real; an anchor must carry real evidence and a bond
  // result and, since AnchorVoteResult ALSO flipped cto_state/
  // community_wallet_hash immediately, self-sign a follow-up
  // ExecuteProposal as "the community" (a key they themselves control,
  // just written moments earlier) — a complete, two-transaction, no-real-
  // party-required forgery of a CTO takeover. Fixed via a bonded challenge
  // window, the same pattern already established in this codebase for
  // "can't verify an off-chain claim on-chain" (nhop_challenge.ak,
  // cto_sybil_challenge.ak): AnchorVoteResult now requires a real ADA
  // bond and no longer mutates cto_state/community_wallet_hash directly
  // (deferred to ExecuteProposal, which now also requires the challenge
  // window to have elapsed). The governor (same trust boundary already
  // used everywhere else in this codebase — hasClaimableBalance,
  // lastCreatorActivity) can void an anchor within the window via
  // VoidPendingProposal, slashing the relayer's bond as a real
  // deterrent. If unvoided, the relayer reclaims their bond via
  // ReclaimRelayerBond once the proposal is Executed or Expired.
  pending_relayer_bond: Int,
  pending_relayer_key_hash: VerificationKeyHash,
  // Genesis-fixed payout destinations for a slashed relayer bond — same
  // "no new payout address invented, real fixed destinations" discipline
  // as every other bonded mechanism in this codebase.
  treasury_pub_key_hash: VerificationKeyHash,
  ops_pub_key_hash: VerificationKeyHash,
  // Fix (2026-07-23 security audit): this governance UTXO's own thread
  // NFT policy id. Downstream validators (bonding_curve, bonding_curve_tier_b,
  // lp_escrow, vesting) read this UTXO as a REFERENCE input to decide whether
  // a CTO vote passed. A reference input is never spent, and paying to a
  // script address never runs its validator — so an address match alone
  // does not authenticate the governance record. Those validators additionally
  // require the referenced UTXO to hold exactly 1 of this NFT
  // (asset_name = launch_id), minted once under a governor-signature policy
  // no attacker can satisfy. This contract preserves the NFT in its
  // continuing output on EVERY spend (governance_nft_preserved), so the
  // genuine governance UTXO is the only place it can ever live.
  thread_nft_policy: PolicyId,
  // The ballot's own width, so an anchored result has to describe a ballot
  // that could really have run.
  //
  // AnchorVoteResult is open-relay on purpose: anyone may submit, because a
  // platform-only relay could suppress a legitimate takeover by simply never
  // submitting. That makes every field of the redeemer the relayer's to
  // choose, and it leaves this contract with one honest question it can ask —
  // not "is this the real tally", which no Cardano validator can answer about
  // a Midnight ballot, but "is this even a ballot that fits the rules this
  // launch was deployed under".
  //
  // This is the deployed-time answer to that. It lives in the datum rather
  // than as a literal so a launch's own configuration governs it, and it is
  // never written by any redeemer.
  //
  // ballot_duration pins the window's exact width, so a result cannot describe
  // a ballot that ran for a minute or for a year.
  ballot_duration: Int,
}

/// Redeemer actions
pub type CtoGovernanceRedeemer {
  /// Anchor a vote result from Midnight (open relay) — anyone can
  /// submit this, no signer authorization required by design.
  ///
  /// Fix: now requires a real relayer_bond (paid into this
  /// contract's own value — see this redeemer's real check below) and no
  /// longer mutates cto_state/community_wallet_hash directly — that now
  /// only happens via ExecuteProposal, once the challenge window has
  /// elapsed. See CtoGovernanceDatum's own doc comment on
  /// pending_relayer_bond for the full reasoning.
  AnchorVoteResult {
    proposal_type: ProposalType,
    description_hash: ByteArray,
    proof_bundle_hash: ByteArray,
    yes_votes: Int,
    no_votes: Int,
    voter_count: Int,
    creator_yes_votes: Int,
    creator_no_votes: Int,
    outcome: ProposalOutcome,
    start_timestamp: Int,
    end_timestamp: Int,
    anchor_timestamp: Int,
    target_dex_credential: Option<Credential>,
    allocation_amount: Int,
    allocation_recipient_hash: VerificationKeyHash,
    relayer_credential_hash: VerificationKeyHash,
    relayer_bond: Int,
  }
  /// Execute a passed proposal (governor or community wallet). Fix:
  /// now also requires the challenge window has elapsed since anchoring,
  /// and applies the cto_state/community_wallet_hash mutation that used
  /// to happen immediately in AnchorVoteResult.
  ExecuteProposal { current_timestamp: Int }
  /// Mark proposal as expired (if not executed within 30 days)
  ExpireProposal { current_timestamp: Int }
  /// Clear the active proposal (after execution or expiry)
  ClearProposal
  /// Emergency: governor sets community wallet (compromise detected)
  EmergencySetCommunityWallet { community_wallet_hash: VerificationKeyHash }
  /// Fix: governor-only, within the challenge window — voids a
  /// pending anchor found to be fraudulent (same trust boundary already
  /// used throughout this codebase for off-chain-verified claims) and
  /// slashes the relayer's bond, split 60/40 treasury/ops (same ratio as
  /// every other forfeited bond in this codebase — nhop_challenge.ak,
  /// cto_sybil_challenge.ak).
  VoidPendingProposal { current_timestamp: Int }
  /// Fix: the relayer reclaims their bond once their anchored
  /// proposal has been legitimately Executed or Expired (never voided) —
  /// permissionless, but the payout destination is fixed by the datum's
  /// own pending_relayer_key_hash, same "the invariant is the
  /// authorization" idiom as every other permissionless claim in this
  /// codebase.
  ReclaimRelayerBond
  /// Read-only query, no state change, no authorization required
  QueryState
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// 30 days in MILLISECONDS — max time to execute a passed proposal.
///
/// Fix (2026-07-17): was previously `2_592_000` (30 days in SECONDS).
/// `anchor_timestamp`/`current_timestamp` are checked via
/// `interval.contains(self.validity_range, ...)` (see AnchorProposal/
/// ExecuteProposal/ExpireProposal below), and Cardano's real transaction
/// validity range is natively expressed in MILLISECONDS — same root cause,
/// found and fixed in the same pass, as bonding_curve.ak's
/// `max_curve_duration` (see that file's own comment for the full
/// on-chain evidence). The documented "30-day execution window" was
/// actually only ~2,592 real seconds (~43 minutes).
const execution_window = 2_592_000_000

/// 24 hours in MILLISECONDS — same window length as
/// nhop_challenge.ak's own defence_seconds-equivalent concept (that file
/// uses seconds since it never binds to Cardano's own ms-scale
/// validity_range; here it does, via interval.contains, same as
/// execution_window above). How long a governor has to void a freshly-
/// anchored, potentially-fraudulent proposal before it becomes
/// executable.
const challenge_window = 86_400_000

/// 25 ADA — same fixed-figure-not-oracle-verified idiom as
/// NHOP_CHALLENGE_BOND, reused for consistency (this mechanism's purpose
/// — deter a costless forged anchor — is the same underlying concern).
const min_relayer_bond = 25_000_000

const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 100

// ============================================================================
// HELPERS
// ============================================================================

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum.
/// The governance UTXO's whole value, byte for byte, carried into the
/// continuing output.
///
/// For the redeemers that only advance proposal state. This UTXO holds a real
/// relayer bond, so pinning the continuing DATUM while leaving the VALUE free
/// makes a state transition into a withdrawal of that bond — and the branches
/// that legitimately move it (`VoidPendingProposal`, `ReclaimRelayerBond`)
/// already account for it directionally through `bond_paid_out`.
fn governance_value_unchanged(
  self: Transaction,
  own_ref: OutputReference,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  own_output.value == own_input.output.value
}

fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> CtoGovernanceDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: CtoGovernanceDatum = raw_datum
  new_datum
}

/// Verify some output pays at least `amount` lovelace to
/// `key_hash`'s wallet address — same pattern as nhop_challenge.ak's/
/// cto_sybil_challenge.ak's own `paid_to` helper.
fn paid_to(
  self: Transaction,
  own_ref: OutputReference,
  key_hash: VerificationKeyHash,
  amount: Int,
) -> Bool {
  let cred = from_verification_key(key_hash).payment_credential
  list.any(
    self.outputs,
    fn(output) {
      and {
        // Names THIS spend. See noctis/settlement, and the same tag on the
        // two challenge contracts' own payouts: address and amount are
        // precisely what two obligations owed to one wallet have in common,
        // so neither can tell them apart.
        settlement.settles(output, own_ref),
        // The payment credential, not the whole address.
        // `from_verification_key` builds a bare ENTERPRISE address, while an
        // ordinary wallet hands out BASE addresses — payment credential plus a
        // staking part — so matching the whole address asks for a destination
        // almost nobody uses, and the bond could not be returned to one. Same
        // fix already applied to the curve, staking and escrow payouts.
        output.address.payment_credential == cred,
        assets.lovelace_of(output.value) >= amount,
      }
    },
  )
}

/// Verify this contract's own continuing output lovelace increased
/// by exactly `amount` relative to the input — the receiving-side mirror
/// of bonding_curve.ak's payment_received, applied here to a relayer's
/// posted bond.
fn bond_received(self: Transaction, own_ref: OutputReference, amount: Int) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_output.value) == assets.lovelace_of(own_input.output.value) + amount
}

/// Verify this contract's own continuing output lovelace decreased
/// by exactly `amount` relative to the input — the paying-side mirror of
/// bond_received, applied to reclaiming or slashing a relayer's bond.
fn bond_paid_out(self: Transaction, own_ref: OutputReference, amount: Int) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  assets.lovelace_of(own_input.output.value) == assets.lovelace_of(own_output.value) + amount
}

/// Same double-satisfaction closure as bonding_curve.ak/lp_escrow.ak
/// etc. — see those files' own single_own_utxo comment for the full
/// explanation.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  // Compared by PAYMENT credential, never by the full Address. The staking
  // part of an address is chosen freely by whoever builds the output, so two
  // UTXOs at this same script can carry different delegation keys while being
  // equally "ours". Matching on the whole Address would let those two stop
  // counting as one another's company, which is exactly what this check
  // exists to prevent.
  let own_payment = own_address.payment_credential
  list.length(
    list.filter(
      self.inputs,
      fn(input) { input.output.address.payment_credential == own_payment },
    ),
  ) <= 1 && list.length(
    list.filter(
      self.outputs,
      fn(output) { output.address.payment_credential == own_payment },
    ),
  ) <= 1
}

/// Fix (2026-07-23 security audit): every spend of this governance UTXO
/// must carry its thread NFT forward into the continuing output unchanged
/// (exactly 1, asset_name = launch_id). Downstream validators (bonding_curve,
/// bonding_curve_tier_b, lp_escrow, vesting) trust the PRESENCE of this NFT
/// as proof they are reading the genuine governance UTXO as a reference
/// input. Every redeemer here produces a continuing output (state machine),
/// and several are permissionless by design (AnchorVoteResult open-relay,
/// ExpireProposal, ClearProposal). Without this check, such a caller
/// could spend the real governance UTXO and send the NFT to an address they
/// control, then plant it in a forged governance UTXO — defeating the
/// entire fix. Applied at the top of the validator (like single_own_utxo), so
/// the NFT can never leave the genuine governance UTXO by any path.
fn governance_nft_preserved(
  self: Transaction,
  own_ref: OutputReference,
  datum: CtoGovernanceDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  // 2026-08-03 audit: role-tagged asset name — one policy now carries a
  // distinct thread NFT for each of this launch's state UTXOs, so the bare
  // launch_id no longer identifies which one this is. See noctis/thread_nft.
  let name =
    thread_nft.thread_asset_name(
      thread_nft.role_cto_governance,
      datum.launch_id,
    )
  // The input half was added in the same pass. Checking only the continuing
  // output proved the NFT ends up somewhere correct, but not that the UTXO
  // being spent was ever the genuine one. Requiring it on both sides is what
  // makes a UTXO that never held the NFT unspendable here.
  when list.find(self.outputs, fn(output) { output.address == own_address }) is {
    None -> False
    Some(own_output) -> and {
        assets.quantity_of(own_input.output.value, datum.thread_nft_policy, name) == 1,
        assets.quantity_of(own_output.value, datum.thread_nft_policy, name) == 1,
      }
  }
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

/// CLAUDE.md's CTO_MIN_DAYS_POSTGRD (90 days), in MILLISECONDS to match
/// Cardano's own validity range and lp_escrow's `lock_timestamp`.
const min_post_grad_delay_ms: Int = 7_776_000_000

/// Whether this launch graduated long enough ago for a ballot to be eligible.
///
/// The delay is a real rule in the product — a healthy launch gets runway
/// before it can be challenged — and until now it existed only in the Midnight
/// contract's own `createProposal`. On this side a relayer named
/// `start_timestamp` freely, so a ballot could describe a window before the
/// launch had graduated, or before it had graduated for long enough.
///
/// Graduation time is not written here and cannot be: this UTXO is created at
/// mint, when no graduation has happened, so a field for it would sit at 0 and
/// read as enforcement while enforcing nothing. It is read instead from the
/// launch's own LP escrow UTXO, whose `lock_timestamp` is set by `SealLock` —
/// which runs AT graduation, in the same transaction as the curve's
/// `Graduate`. That makes it the one on-chain record of when this launch
/// graduated, written by the mechanism that graduates it.
///
/// The reference input is authenticated by the launch's own LP escrow thread
/// NFT, not by address. A reference input is never spent, so no validator runs
/// on it — anyone can pay a UTXO carrying a forged datum to any address they
/// like. Only the real escrow can carry the NFT, which is what makes reading
/// its datum safe. Same reasoning bonding_curve.ak's `cto_vote_verified`
/// already applies to reading THIS contract.
fn post_graduation_delay_ok(
  self: Transaction,
  datum: CtoGovernanceDatum,
  start_timestamp: Int,
) -> Bool {
  expect Some(lp_ref) =
    list.find(
      self.reference_inputs,
      fn(input) {
        assets.quantity_of(
          input.output.value,
          datum.thread_nft_policy,
          thread_nft.thread_asset_name(
            thread_nft.role_lp_escrow,
            datum.launch_id,
          ),
        ) == 1
      },
    )
  expect InlineDatum(lp_raw_datum) = lp_ref.output.datum
  expect lp_datum: LpEscrowDatum = lp_raw_datum

  and {
    lp_datum.launch_id == datum.launch_id,
    // 0 until SealLock runs, so this also refuses a launch that has not
    // graduated at all — not only one that graduated too recently.
    lp_datum.lock_timestamp != 0,
    start_timestamp >= lp_datum.lock_timestamp + min_post_grad_delay_ms,
  }
}

validator cto_governance {
  spend(
    datum_opt: Option<CtoGovernanceDatum>,
    redeemer: CtoGovernanceRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      when redeemer is {
        AnchorVoteResult {
        proposal_type,
        description_hash,
        proof_bundle_hash,
        yes_votes,
        no_votes,
        voter_count,
        creator_yes_votes,
        creator_no_votes,
        outcome,
        start_timestamp,
        end_timestamp,
        anchor_timestamp,
        target_dex_credential,
        allocation_amount,
        allocation_recipient_hash,
        relayer_credential_hash,
        relayer_bond,
      } -> {
        let total_votes = yes_votes + no_votes
        // A ballot below the distinct-voter floor is not a vote that failed —
        // it never reached the threshold to be a vote at all, whatever outcome
        // it claims. Required for EVERY outcome, not only a passing one: an
        // anchor takes the launch's single proposal slot and starts its
        // cooldown either way, so a ballot nobody attended must not be able to
        // claim either of those. The weight and majority tests below stay
        // specific to a passing result, since a real ballot can legitimately
        // fail by falling short of them.
        let voter_floor_ok = voter_count >= datum.min_voter_count
        let quorum_ok = if outcome == Passed {
          let quorum_required = datum.total_supply * datum.quorum_bps
          let quorum_actual = total_votes * 10_000
          quorum_actual >= quorum_required && yes_votes > no_votes
        } else {
          True
        }

        // A result can only describe a ballot that has actually finished, and
        // whose window is the one this launch deploys with. Both timestamps
        // are the relayer's to name, so without this the window is whatever
        // they say it is — including one that had not opened when the result
        // was submitted. anchor_timestamp is itself held inside the
        // transaction's validity range below, which is what gives these two
        // comparisons a real clock to work against.
        let ballot_window_ok = and {
            end_timestamp - start_timestamp == datum.ballot_duration,
            end_timestamp <= anchor_timestamp,
          }

        let creator_total = creator_yes_votes + creator_no_votes
        let creator_cap = datum.total_supply * datum.creator_vote_cap_bps / 10_000
        let creator_cap_ok = creator_total <= creator_cap

        // SilenceLockTrigger and the dissolve proposal must pass to have
        // any effect on cto_state / community_wallet_hash
        let trigger_ok = if proposal_type == SilenceLockTrigger {
          outcome == Passed
        } else {
          True
        }
        let dissolve_ok = if proposal_type == DissolveCTOProposal {
          outcome == Passed
        } else {
          True
        }

        let proposal =
          ProposalAnchor {
            proposal_type,
            description_hash,
            proof_bundle_hash,
            yes_votes,
            no_votes,
            voter_count,
            creator_yes_votes,
            creator_no_votes,
            outcome,
            start_timestamp,
            end_timestamp,
            anchor_timestamp,
            execution_status: PendingExecution,
            target_dex_credential,
            allocation_amount,
            allocation_recipient_hash,
            relayer_credential_hash,
          }

        // Fix: cto_state/community_wallet_hash are NO LONGER mutated
        // here — only ExecuteProposal applies them, once the challenge
        // window has elapsed unvoided. See this redeemer's own doc
        // comment in CtoGovernanceRedeemer above for the full reasoning.
        let expected_datum =
          CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(proposal),
            proposal_count: datum.proposal_count + 1,
            pending_relayer_bond: relayer_bond,
            pending_relayer_key_hash: relayer_credential_hash,
          }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          single_own_utxo(self, own_input.output.address),
          datum.active_proposal == None,
          interval.contains(self.validity_range, anchor_timestamp),
          // Bound the declared validity range's own width — this
          // redeemer is open-relay/permissionless by design, and
          // anchor_timestamp becomes the permanent base every later
          // execution-window check is computed from.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          voter_floor_ok,
          quorum_ok,
          ballot_window_ok,
          post_graduation_delay_ok(self, datum, start_timestamp),
          creator_cap_ok,
          trigger_ok,
          dissolve_ok,
          // CRITICAL fix: a real relayer bond is now required and
          // actually paid into the contract's own value — closes the
          // "forge a vote result for free" gap. See CtoGovernanceDatum's
          // pending_relayer_bond doc comment for the full mechanism.
          relayer_bond >= min_relayer_bond,
          bond_received(self, own_ref, relayer_bond),
          new_datum == expected_datum,
        }
      }

      ExecuteProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let executed_proposal =
          ProposalAnchor { ..proposal, execution_status: Executed }
        let new_datum = own_continuing_datum(self, own_ref)

        // Fix: cto_state/community_wallet_hash mutation moved here
        // from AnchorVoteResult (see that redeemer's own comment).
        let new_cto_state = if proposal.proposal_type == SilenceLockTrigger {
          CTOTriggered
        } else if proposal.proposal_type == DissolveCTOProposal {
          CTODissolved
        } else {
          datum.cto_state
        }
        let new_community_wallet = if proposal.proposal_type == SilenceLockTrigger {
          proposal.allocation_recipient_hash
        } else if proposal.proposal_type == DissolveCTOProposal {
          #""
        } else {
          datum.community_wallet_hash
        }

        and {
          single_own_utxo(self, own_input.output.address),
          proposal.outcome == Passed,
          // Executing marks the proposal done and flips cto_state; the
          // downstream contracts move the value, not this one.
          governance_value_unchanged(self, own_ref),
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          // Fix: permissionless (no signature requirement — a real
          // governor/community signature is no longer meaningful trust
          // here, now that anchoring itself is bonded and
          // governor-reviewable during the challenge window; requiring a
          // signature on EXECUTE too would just reopen the exact
          // censorship risk the open-relay design was resolved to avoid, since
          // community_wallet_hash doesn't exist yet for a launch's FIRST
          // SilenceLockTrigger). validity_range_is_narrow closes the same
          // "declare an arbitrarily wide range" gap every other
          // permissionless deadline check in this codebase already closes.
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          // CRITICAL fix: the challenge window must have elapsed —
          // this is what actually closes the forgery gap (a fraudulent
          // anchor can be voided by the governor before this point).
          current_timestamp >= proposal.anchor_timestamp + challenge_window,
          current_timestamp <= proposal.anchor_timestamp + execution_window,
          new_datum == CtoGovernanceDatum {
            ..datum,
            cto_state: new_cto_state,
            community_wallet_hash: new_community_wallet,
            active_proposal: Some(executed_proposal),
            // Enforcement: permanent record for downstream reference-
            // input checks — see the field's own doc comment above.
            last_executed_proposal: Some(executed_proposal),
          },
        }
      }

      // Fix: governor-only, within the challenge window — voids a
      // pending anchor found to be fraudulent, slashing the relayer's
      // bond. See this redeemer's own doc comment in CtoGovernanceRedeemer
      // above for the full reasoning.
      VoidPendingProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let voided_proposal =
          ProposalAnchor { ..proposal, execution_status: Expired }
        let new_datum = own_continuing_datum(self, own_ref)
        let treasury_share = datum.pending_relayer_bond * treasury_bps / bps_denominator
        let ops_share = datum.pending_relayer_bond - treasury_share

        and {
          single_own_utxo(self, own_input.output.address),
          list.has(self.extra_signatories, datum.governor_credential_hash),
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp < proposal.anchor_timestamp + challenge_window,
          paid_to(self, own_ref, datum.treasury_pub_key_hash, treasury_share),
          paid_to(self, own_ref, datum.ops_pub_key_hash, ops_share),
          bond_paid_out(self, own_ref, datum.pending_relayer_bond),
          new_datum == CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(voided_proposal),
            pending_relayer_bond: 0,
            pending_relayer_key_hash: #"",
          },
        }
      }

      // Fix: the relayer reclaims their bond once their anchored
      // proposal has been legitimately Executed or Expired (a natural
      // 30-day timeout, not a void) — never reachable if the governor
      // voided it, since VoidPendingProposal already zeroes
      // pending_relayer_bond. Permissionless — the payout destination is
      // fixed by the datum's own pending_relayer_key_hash.
      ReclaimRelayerBond -> {
        expect Some(proposal) = datum.active_proposal
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          single_own_utxo(self, own_input.output.address),
          proposal.execution_status == Executed || proposal.execution_status == Expired,
          datum.pending_relayer_bond > 0,
          paid_to(self, own_ref, datum.pending_relayer_key_hash, datum.pending_relayer_bond),
          bond_paid_out(self, own_ref, datum.pending_relayer_bond),
          new_datum == CtoGovernanceDatum {
            ..datum,
            pending_relayer_bond: 0,
            pending_relayer_key_hash: #"",
          },
        }
      }

      ExpireProposal { current_timestamp } -> {
        expect Some(proposal) = datum.active_proposal
        let expired_proposal =
          ProposalAnchor { ..proposal, execution_status: Expired }
        let new_datum = own_continuing_datum(self, own_ref)

        and {
          single_own_utxo(self, own_input.output.address),
          proposal.execution_status == PendingExecution,
          interval.contains(self.validity_range, current_timestamp),
          // Bound the declared validity range's own width — this
          // redeemer is permissionless by design (same idiom as ExpireCurve).
          validity_range_is_narrow(self.validity_range, max_validity_range_width),
          current_timestamp > proposal.anchor_timestamp + execution_window,
          new_datum == CtoGovernanceDatum {
            ..datum,
            active_proposal: Some(expired_proposal),
          },
          // Marking a proposal expired settles nothing. The relayer's bond
          // stays here for ReclaimRelayerBond, which is the only path that
          // may pay it out and pays it to the datum's own recorded relayer.
          governance_value_unchanged(self, own_ref),
        }
      }

      ClearProposal -> {
        expect Some(proposal) = datum.active_proposal
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          proposal.execution_status == Executed || proposal.execution_status == Expired,
          // Fix: without this, a governor could ClearProposal (which
          // resets active_proposal to None) BEFORE the relayer calls
          // ReclaimRelayerBond — which itself requires `datum.
          // active_proposal` to be Some — permanently stranding a
          // legitimate relayer's bond in the contract with no path to
          // reclaim it. Requiring the bond already be reclaimed (or
          // already zeroed by VoidPendingProposal) enforces the correct
          // order: settle the bond first, only then clear the record.
          datum.pending_relayer_bond == 0,
          new_datum == CtoGovernanceDatum { ..datum, active_proposal: None },
          single_own_utxo(self, own_input.output.address),
          governance_value_unchanged(self, own_ref),
        }
      }

      EmergencySetCommunityWallet { community_wallet_hash } -> {
        let new_datum = own_continuing_datum(self, own_ref)
        and {
          list.has(self.extra_signatories, datum.governor_credential_hash),
          datum.cto_state == CTOTriggered,
          new_datum == CtoGovernanceDatum {
            ..datum,
            community_wallet_hash: community_wallet_hash,
          },
          single_own_utxo(self, own_input.output.address),
          governance_value_unchanged(self, own_ref),
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks).
      // Lower direct-fund-value here than the other 5 files (this contract
      // mostly anchors vote evidence rather than holding principal), but
      // still a real unauthenticated-spend gap, closed the same way for
      // consistency and to remove the attack surface entirely.
      QueryState -> False
      },
      // Fix (2026-07-23 audit): preserve the governance thread NFT on
      // EVERY successful spend — see governance_nft_preserved's doc comment.
      // Every redeemer above produces a continuing output (state machine),
      // and several are permissionless by design (AnchorVoteResult open-relay,
      // ExpireProposal, ClearProposal). Without this, such a caller
      // could spend the real governance UTXO, move the NFT to an address they
      // control, and plant it in a forged governance UTXO — defeating every
      // downstream check at once. Placed last so it is only reached once
      // a redeemer's own logic has otherwise succeeded (QueryState/fail paths
      // short-circuit before it), but a genuine state change can never drop
      // the NFT.
      governance_nft_preserved(self, own_ref, datum),
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum(active_proposal: Option<ProposalAnchor>) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: #"01",
    cto_state: PreCTO,
    community_wallet_hash: #"",
    governor_credential_hash: #"22",
    total_supply: 1_000_000,
    quorum_bps: 500,
    // 5%
    creator_vote_cap_bps: 100,
    // 1% — anti-whale-takeover fix (2026-07-28): unified cap, was 200 (2%,
    // creator-only)
    min_voter_count: 15,
    // anti-whale-takeover fix (2026-07-28)
    active_proposal: active_proposal,
    proposal_count: 0,
    last_executed_proposal: None,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    treasury_pub_key_hash: #"55",
    ops_pub_key_hash: #"66",
    thread_nft_policy: mock_cto_nft_policy(),
    ballot_duration: 500,
  }
}

/// Fix: mock governance thread NFT policy id used across the tests. The
/// genuine governance UTXO (and its continuing output) must carry exactly 1
/// of `(mock_cto_nft_policy(), launch_id)`.
fn mock_cto_nft_policy() -> PolicyId {
  #"c0ffee"
}

/// Thread NFT: the governance thread NFT's asset name for a given launch id.
/// Derived rather than hard-coded so a change to the naming scheme cannot
/// leave these fixtures silently passing against a stale literal.
fn mock_cto_nft_name(launch_id: ByteArray) -> ByteArray {
  thread_nft.thread_asset_name(thread_nft.role_cto_governance, launch_id)
}

/// Thread NFT: the bare thread NFT, for fixtures building a governance UTXO's own
/// INPUT value (the output side goes through cto_out_value below).
fn mock_cto_nft_value() -> assets.Value {
  assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1)
}

/// Fix: build a governance-UTXO value carrying the thread NFT, used by the
/// success-path tests whose continuing output must satisfy
/// governance_nft_preserved. The NFT is a token, not lovelace, so this does
/// not disturb the lovelace-based bond checks.
fn cto_out_value(lovelace: Int) -> assets.Value {
  assets.from_lovelace(lovelace)
    |> assets.add(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1)
}

/// The same proposal, with the ballot window stated explicitly. Anchor tests
/// need this because their ballots now sit on a real, eligibility-relative
/// timescale, while every other consumer of mock_proposal only cares about
/// the anchor time and is left on the original toy values.
fn mock_proposal_windowed(
  outcome: ProposalOutcome,
  execution_status: ExecutionStatus,
  start_timestamp: Int,
  end_timestamp: Int,
  anchor_timestamp: Int,
) -> ProposalAnchor {
  ProposalAnchor {
    ..mock_proposal(outcome, execution_status, anchor_timestamp),
    start_timestamp: start_timestamp,
    end_timestamp: end_timestamp,
  }
}

fn mock_proposal(
  outcome: ProposalOutcome,
  execution_status: ExecutionStatus,
  anchor_timestamp: Int,
) -> ProposalAnchor {
  ProposalAnchor {
    proposal_type: SilenceLockTrigger,
    description_hash: #"aa",
    proof_bundle_hash: #"bb",
    yes_votes: 60_000,
    no_votes: 10_000,
    // Anti-whale-takeover fix (2026-07-28): was 5, below the new
    // min_voter_count (15) — every existing success-path test implicitly
    // relies on this default satisfying quorum, so it's bumped here rather
    // than at each call site. Dedicated failure-path coverage for "below
    // minimum voter count" is its own test, below.
    voter_count: 15,
    creator_yes_votes: 0,
    creator_no_votes: 0,
    outcome: outcome,
    start_timestamp: 0,
    end_timestamp: 500,
    anchor_timestamp: anchor_timestamp,
    execution_status: execution_status,
    target_dex_credential: None,
    allocation_amount: 0,
    allocation_recipient_hash: #"ff",
    relayer_credential_hash: #"33",
  }
}

// The anchored result must describe a ballot that could really have run
// under this launch's own configuration.
//
// AnchorVoteResult is open-relay by design, so every field is the relayer's
// to choose. This contract cannot check a Midnight tally, but it can check
// the shape: a window of the deployed width, closed before it was submitted,
// and opened no earlier than the launch was eligible to hold a ballot at all.

/// Thread NFT: the LP escrow thread NFT's asset name for a given launch id.
fn mock_lp_nft_name(launch_id: ByteArray) -> ByteArray {
  thread_nft.thread_asset_name(thread_nft.role_lp_escrow, launch_id)
}

/// When the launch in these fixtures graduated — lp_escrow's `lock_timestamp`,
/// written by `SealLock` in the same transaction as the curve's `Graduate`.
const mock_grad_ts: Int = 1_000

/// The earliest a ballot may open for that launch. Every anchor fixture below
/// is expressed relative to this rather than to a bare number, so each one
/// states the rule it is satisfying instead of carrying a magic timestamp.
const eligible_start: Int = mock_grad_ts + min_post_grad_delay_ms

/// The launch's LP escrow datum. Only launch_id and lock_timestamp are read
/// by this contract; the rest are the shape the type requires.
fn mock_lp_datum(lock_timestamp: Int) -> LpEscrowDatum {
  LpEscrowDatum {
    launch_id: #"01",
    lock_timestamp: lock_timestamp,
    lock_duration: 31_536_000_000,
    lp_state: Locked,
    governor_pub_key_hash: #"11",
    community_wallet_hash: #"22",
    cto_triggered: False,
    fee_recipient_pub_key_hash: #"33",
    dex_whitelist: [],
    multisig_signers: [],
    multisig_threshold: 1,
    pending_dex_change: None,
    lp_token_policy_id: #"44",
    lp_token_name: #"55",
    lp_token_amount: 1_000,
    cto_governance_credential: VerificationKey(#"66"),
    thread_nft_policy: mock_cto_nft_policy(),
    last_migration_timestamp: 0,
  }
}

/// An LP escrow UTXO carrying the RIGHT thread NFT but a datum naming a
/// different launch. The NFT's asset name only commits to the first 31 bytes
/// of a launch id, so the NFT alone does not fully bind which launch the datum
/// describes — the datum's own launch_id is what closes that.
fn mock_lp_ref_input_foreign_datum() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"dd",
      output_index: 0,
    },
    output: Output {
      address: from_verification_key(#"1e"),
      value: assets.from_asset(
        mock_cto_nft_policy(),
        mock_lp_nft_name(#"01"),
        1,
      ),
      datum: InlineDatum(
        LpEscrowDatum { ..mock_lp_datum(mock_grad_ts), launch_id: #"99" },
      ),
      reference_script: None,
    },
  }
}

/// The launch's real LP escrow UTXO, as a reference input: sealed, carrying
/// the genuine LP escrow thread NFT. `post_graduation_delay_ok` finds it by
/// that NFT, so a fixture without it is not merely incomplete — the validator
/// cannot find a graduation time at all and refuses.
fn mock_lp_ref_input(lock_timestamp: Int) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"dd",
      output_index: 0,
    },
    output: Output {
      address: from_verification_key(#"1e"),
      value: assets.from_asset(
        mock_cto_nft_policy(),
        mock_lp_nft_name(#"01"),
        1,
      ),
      datum: InlineDatum(mock_lp_datum(lock_timestamp)),
      reference_script: None,
    },
  }
}

/// One complete AnchorVoteResult spend, parameterised only by the ballot's own
/// timestamps, so each test below differs from a known-good anchor by exactly
/// the thing it is testing. The validity range is built around
/// anchor_timestamp so it always contains it — otherwise a test could pass on
/// the pre-existing interval check rather than the one it names.
fn anchor_spend_with_window(
  datum: CtoGovernanceDatum,
  start_timestamp: Int,
  end_timestamp: Int,
  anchor_timestamp: Int,
) -> Bool {
  anchor_spend_with_window_and_grad(
    datum,
    start_timestamp,
    end_timestamp,
    anchor_timestamp,
    mock_grad_ts,
  )
}

/// The same spend, with the launch's graduation time varied — so a test can
/// describe a launch that graduated too recently, or never graduated at all.
fn anchor_spend_with_window_and_grad(
  datum: CtoGovernanceDatum,
  start_timestamp: Int,
  end_timestamp: Int,
  anchor_timestamp: Int,
  lp_lock_timestamp: Int,
) -> Bool {
  anchor_spend_with_lp_ref(
    datum,
    start_timestamp,
    end_timestamp,
    anchor_timestamp,
    mock_lp_ref_input(lp_lock_timestamp),
  )
}

/// The known-good anchor with a known-good ballot window, and the LP escrow
/// reference input supplied directly — so a test can hand it one that is wrong
/// in exactly one way.
fn anchor_spend_with_foreign_lp_datum(datum: CtoGovernanceDatum) -> Bool {
  anchor_spend_with_lp_ref(
    datum,
    eligible_start,
    eligible_start + 500,
    eligible_start + 500,
    mock_lp_ref_input_foreign_datum(),
  )
}

fn anchor_spend_with_lp_ref(
  datum: CtoGovernanceDatum,
  start_timestamp: Int,
  end_timestamp: Int,
  anchor_timestamp: Int,
  lp_ref: Input,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal =
    ProposalAnchor {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 15,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: start_timestamp,
      end_timestamp: end_timestamp,
      anchor_timestamp: anchor_timestamp,
      execution_status: PendingExecution,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
    }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: datum.proposal_count + 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(27_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [lp_ref],
      outputs: [continuing_output],
      validity_range: interval.between(anchor_timestamp - 100, anchor_timestamp + 100),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 15,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: start_timestamp,
      end_timestamp: end_timestamp,
      anchor_timestamp: anchor_timestamp,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

/// The control. Everything below differs from this by its timestamps alone, so
/// a rejection means the window was rejected and not something incidental.
test anchor_accepts_a_ballot_that_really_ran() {
  anchor_spend_with_window(
    mock_datum(None),
    eligible_start,
    eligible_start + 500,
    eligible_start + 500,
  )
}

/// A ballot scheduled to open long after the result was submitted.
test anchor_rejects_a_ballot_that_has_not_run() {
  !anchor_spend_with_window(
    mock_datum(None),
    eligible_start + 10_000,
    eligible_start + 10_500,
    eligible_start + 500,
  )
}

/// A ballot of the right width, anchored while it was still open. Voting had
/// not finished, so the tally being claimed was not final.
test anchor_rejects_a_result_submitted_before_the_ballot_closed() {
  !anchor_spend_with_window(
    mock_datum(None),
    eligible_start,
    eligible_start + 500,
    eligible_start + 450,
  )
}

/// A window narrower than the one this launch deploys with — a shortened
/// ballot that real holders had less time to reach.
test anchor_rejects_a_ballot_window_of_the_wrong_width() {
  !anchor_spend_with_window(
    mock_datum(None),
    eligible_start + 100,
    eligible_start + 500,
    eligible_start + 500,
  )
}



test anchor_rejects_graduation_time_from_another_launch() {
  // Same known-good anchor, with the escrow reference input swapped for one
  // that carries the right NFT and another launch's datum. Without the
  // launch_id comparison this would be accepted, and a ballot could borrow a
  // graduation time from a launch that graduated earlier.
  !anchor_spend_with_foreign_lp_datum(mock_datum(None))
}

test anchor_rejects_a_ballot_opened_before_the_launch_was_eligible() {
  // The launch graduated, but this ballot opened one millisecond inside the
  // 90-day delay. Everything else about it is a known-good anchor.
  !anchor_spend_with_window(
    mock_datum(None),
    eligible_start - 1,
    eligible_start + 499,
    eligible_start + 499,
  )
}

test anchor_rejects_a_ballot_for_a_launch_that_never_graduated() {
  // lock_timestamp is 0 until SealLock runs at graduation, so this is a
  // launch with no graduation to measure a delay from — not merely one that
  // graduated too recently.
  !anchor_spend_with_window_and_grad(
    mock_datum(None),
    eligible_start,
    eligible_start + 500,
    eligible_start + 500,
    0,
  )
}

test anchor_vote_result_succeeds_with_quorum_met() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // 70_000 total votes out of 1_000_000 supply = 7% > 5% quorum. Yes > No.
  let proposal =
    mock_proposal_windowed(
      Passed,
      PendingExecution,
      eligible_start,
      eligible_start + 500,
      eligible_start + 500,
    )
  // AnchorVoteResult no longer mutates cto_state/community_wallet_hash
  // directly (that's ExecuteProposal's job now, after the challenge window)
  // — it only records the pending proposal + the relayer's posted bond.
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(27_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 15, // bumped 5 -> 15 (anti-whale-takeover fix, 2026-07-28): must meet the new min_voter_count
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// Regression (2026-07-23 audit): a spend that DROPS the governance thread
// NFT from its continuing output must be rejected. Downstream validators rely
// on the NFT living ONLY in the genuine governance UTXO, so no redeemer here
// (several are permissionless — open relay) may move it out to be
// planted in a forgery. Identical to anchor_vote_result_succeeds_with_quorum_met
// except the continuing output carries plain lovelace and no NFT, so
// governance_nft_preserved returns False and the whole spend returns False.
test anchor_vote_result_rejects_dropping_thread_nft() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: cto_out_value(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  // The continuing output DROPS the NFT — plain lovelace only. The lovelace
  // bond arithmetic still balances (27M == 2M + 25M), so ONLY the missing
  // NFT can be what rejects this spend.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// Regression (2026-07-23 audit): the cross-launch reuse variant — the NFT
// asset_name is bound to launch_id, so a genuine NFT minted for a DIFFERENT
// launch (wrong asset_name) must not satisfy the preservation check either.
test anchor_vote_result_rejects_wrong_launch_nft() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: cto_out_value(2_000_000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  // Right NFT policy, WRONG asset_name (another launch's id `#"02"`, not this
  // launch's `#"01"`) — quantity_of(value, policy, #"01") == 1 is False.
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_lovelace(27_000_000)
        |> assets.add(mock_cto_nft_policy(), mock_cto_nft_name(#"02"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// Same as the success case above but the relayer posts less than
// min_relayer_bond — a costless forged anchor attempt must be rejected.
test anchor_vote_result_rejects_underfunded_bond() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 1_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(3_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 1_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// relayer_bond claimed in the redeemer is above the floor, but no
// matching real lovelace ever lands in the contract's own continuing
// output — must be rejected (a claimed-but-unpaid bond).
test anchor_vote_result_rejects_unpaid_bond() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      // Bond claimed is 25 ADA but the continuing output's real lovelace
      // never increased — no real payment made.
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

// Identical to anchor_vote_result_succeeds_with_quorum_met except the
// declared validity range is far wider than max_validity_range_width —
// before this fix, ANY relayer (this redeemer is open-relay/permissionless
// by design) could anchor a proposal with a fabricated anchor_timestamp
// by declaring a wide range, corrupting the permanent base every later
// execution-window check is computed from.
test anchor_vote_result_rejects_wide_validity_range() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(proposal),
      proposal_count: 1,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start, eligible_start + 700_000),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 5,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_vote_result_fails_without_quorum() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Only 10_000 total votes out of 1_000_000 supply = 1% < 5% quorum.
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(proposal),
      proposal_count: 1,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 9_000,
      no_votes: 1_000,
      // Bumped to 15 (the new min_voter_count) so this test isolates the
      // quorum-weight failure alone, not conflated with the separate
      // min-voter-count check added 2026-07-28.
      voter_count: 15,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_vote_result_fails_when_voter_count_below_minimum() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  // Anti-whale-takeover fix (2026-07-28): 70_000 total votes out of
  // 1_000_000 supply = 7% > 5% quorum, and yes > no — both the old checks
  // pass. Only voter_count (1, a single wallet) is below min_voter_count
  // (15), which is exactly the scenario this safeguard exists to block: a
  // single sufficiently large wallet satisfying quorum and majority alone.
  let proposal = mock_proposal(Passed, PendingExecution, 500)
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(proposal),
      proposal_count: 1,
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: SilenceLockTrigger,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 1,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test anchor_vote_result_fails_when_creator_cap_exceeded() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  // Creator cap is 1% of 1_000_000 = 10_000 (anti-whale-takeover fix,
  // 2026-07-28 — was 2% = 20_000). Creator voted 25_000 total, still over
  // either threshold. voter_count bumped to 15 (the new min_voter_count)
  // so this test isolates the creator-cap failure alone, not conflated
  // with the separate min-voter-count check.
  let redeemer =
    AnchorVoteResult {
      proposal_type: FundAllocation,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 60_000,
      no_votes: 10_000,
      voter_count: 15,
      creator_yes_votes: 25_000,
      creator_no_votes: 0,
      outcome: Passed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

test execute_proposal_succeeds_by_governor_within_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  // ExecuteProposal now applies the cto_state/community_wallet_hash
  // mutation that used to happen directly in AnchorVoteResult — the mock
  // proposal is SilenceLockTrigger/Passed, so a real execution flips
  // cto_state to CTOTriggered and sets community_wallet_hash from the
  // proposal's allocation_recipient_hash.
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches execution_window's real unit — 1000 + 10 days,
  // well within the 30-day window, and well past the 24h challenge window.
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// Challenge window (24h) has NOT yet elapsed since anchoring — even
// though the proposal legitimately passed, ExecuteProposal must reject so
// the governor still has their real window to void a fraudulent anchor.
test execute_proposal_rejects_before_challenge_window_elapsed() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // Only 1 hour after anchoring — well inside the 24h challenge window.
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test execute_proposal_fails_after_window_expired() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches execution_window's real unit — 1000 + 31 days, past the 30-day window
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// ExecuteProposal is now permissionless by design (see the
// redeemer's own comment) — a stranger's signature is no longer the
// rejection reason here. This test now proves a DIFFERENT, still-real
// protection: even a stranger racing to execute the instant a proposal is
// anchored is blocked by the challenge window, same as anyone else.
test execute_proposal_rejects_within_challenge_window_even_for_stranger() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let executed_proposal = ProposalAnchor { ..proposal, execution_status: Executed }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      cto_state: CTOTriggered,
      community_wallet_hash: #"ff",
      active_proposal: Some(executed_proposal),
      last_executed_proposal: Some(executed_proposal),
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let current_timestamp = 1000 + 864_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      // no signature at all — permissionless, but still inside the window
      extra_signatories: [],
    }

  !cto_governance.spend(
    Some(datum),
    ExecuteProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test expire_proposal_succeeds_after_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches execution_window's real unit
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// Identical to expire_proposal_succeeds_after_window except the
// declared validity range is far wider than max_validity_range_width —
// before this fix, ANY caller (this redeemer is permissionless) could
// mark a proposal Expired immediately after anchoring by declaring a wide
// range and claiming a far-future current_timestamp.
test expire_proposal_rejects_wide_validity_range() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let current_timestamp = 1000 + 2_678_400_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(0, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test expire_proposal_fails_before_window() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let expired_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: Some(expired_proposal) }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // ms-scale, matches execution_window's real unit
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
    }

  !cto_governance.spend(
    Some(datum),
    ExpireProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

// QueryState previously authorized ANY spend unconditionally
// (`QueryState -> True`, zero checks). Proves the fix — a transaction
// spending this UTXO with redeemer=QueryState, discarding the real datum
// entirely (no continuing output, no evidence, no signer), must now be
// rejected.
test query_state_rejects_unauthenticated_spend_attempt() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.from_lovelace(2_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !cto_governance.spend(Some(datum), QueryState, own_ref, self)
}

// ============================================================================
// Bonded challenge window — VoidPendingProposal / ReclaimRelayerBond
// ============================================================================

fn mock_datum_with_bond(
  active_proposal: Option<ProposalAnchor>,
  pending_relayer_bond: Int,
) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    ..mock_datum(active_proposal),
    pending_relayer_bond: pending_relayer_bond,
    pending_relayer_key_hash: #"33",
  }
}

test void_pending_proposal_succeeds_and_slashes_bond() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  // treasury_bps=60, ops_bps=40 of the 25 ADA bond
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  // 1 hour after anchoring — well inside the 24h challenge window
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test void_pending_proposal_rejects_for_non_governor() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let current_timestamp = 1000 + 3_600_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      // not the governor
      extra_signatories: [#"99"],
    }

  !cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test void_pending_proposal_rejects_after_challenge_window_elapsed() {
  let proposal = mock_proposal(Passed, PendingExecution, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let voided_proposal = ProposalAnchor { ..proposal, execution_status: Expired }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(voided_proposal),
      pending_relayer_bond: 0,
      pending_relayer_key_hash: #"",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let treasury_output =
    Output {
      address: from_verification_key(#"55"),
      value: assets.from_lovelace(15_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let ops_output =
    Output {
      address: from_verification_key(#"66"),
      value: assets.from_lovelace(10_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  // 10 days after anchoring — past the 24h challenge window
  let current_timestamp = 1000 + 864_000_000
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output, treasury_output, ops_output],
      validity_range: interval.between(current_timestamp - 100, current_timestamp + 100),
      extra_signatories: [#"22"],
    }

  !cto_governance.spend(
    Some(datum),
    VoidPendingProposal { current_timestamp: current_timestamp },
    own_ref,
    self,
  )
}

test reclaim_relayer_bond_succeeds_after_execution() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    CtoGovernanceDatum { ..datum, pending_relayer_bond: 0, pending_relayer_key_hash: #"" }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let relayer_output =
    Output {
      address: from_verification_key(#"33"),
      value: assets.from_lovelace(25_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output, relayer_output],
    }

  cto_governance.spend(Some(datum), ReclaimRelayerBond, own_ref, self)
}

test reclaim_relayer_bond_rejects_when_nothing_pending() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(2_000_000)),
      datum: InlineDatum(datum),
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [continuing_output] }

  !cto_governance.spend(Some(datum), ReclaimRelayerBond, own_ref, self)
}

// Closes the ClearProposal/ReclaimRelayerBond fund-stranding race —
// the governor must not be able to wipe active_proposal (which
// ReclaimRelayerBond needs to read) while a relayer bond is still
// unsettled.
test clear_proposal_rejects_with_pending_relayer_bond() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: None }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !cto_governance.spend(Some(datum), ClearProposal, own_ref, self)
}

test clear_proposal_succeeds_once_bond_settled() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum(Some(proposal))
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum = CtoGovernanceDatum { ..datum, active_proposal: None }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  cto_governance.spend(Some(datum), ClearProposal, own_ref, self)
}

// An anchor claiming a ballot that nobody attended. The relayer bond is really
// paid, the continuing datum is exactly right, and the proposal type carries no
// requirement of its own — so nothing but the distinct-voter floor stands
// between this and the launch's single proposal slot.
test anchor_vote_result_rejects_unattended_ballot_claiming_failure() {
  let datum = mock_datum(None)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_cto_nft_value(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let proposal =
    ProposalAnchor {
      proposal_type: FundAllocation,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 0,
      no_votes: 0,
      voter_count: 0,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Failed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      execution_status: PendingExecution,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
    }
  let new_datum =
    CtoGovernanceDatum {
      ..datum,
      active_proposal: Some(proposal),
      proposal_count: 1,
      pending_relayer_bond: 25_000_000,
      pending_relayer_key_hash: #"33",
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.from_asset(mock_cto_nft_policy(), mock_cto_nft_name(#"01"), 1),
        assets.from_lovelace(25_000_000),
      ),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output],
      validity_range: interval.between(eligible_start + 400, eligible_start + 600),
    }
  let redeemer =
    AnchorVoteResult {
      proposal_type: FundAllocation,
      description_hash: #"aa",
      proof_bundle_hash: #"bb",
      yes_votes: 0,
      no_votes: 0,
      voter_count: 0,
      creator_yes_votes: 0,
      creator_no_votes: 0,
      outcome: Failed,
      start_timestamp: eligible_start,
      end_timestamp: eligible_start + 500,
      anchor_timestamp: eligible_start + 500,
      target_dex_credential: None,
      allocation_amount: 0,
      allocation_recipient_hash: #"ff",
      relayer_credential_hash: #"33",
      relayer_bond: 25_000_000,
    }

  !cto_governance.spend(Some(datum), redeemer, own_ref, self)
}

/// The relayer's bond, returned to the kind of address a wallet issues.
///
/// `from_verification_key` builds an ENTERPRISE address; real wallets hand out
/// BASE ones, carrying a staking part as well. Matching the whole address
/// asked for a destination almost nobody has — and this contract pays a
/// relayer's bond, a treasury share and an ops share through the same helper.
/// Identical to the passing reclaim above except the relayer delegates stake.
test reclaim_relayer_bond_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let proposal = mock_proposal(Passed, Executed, 1000)
  let datum = mock_datum_with_bond(Some(proposal), 25_000_000)
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_cto_nft_value(), assets.from_lovelace(27_000_000)),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  let new_datum =
    CtoGovernanceDatum { ..datum, pending_relayer_bond: 0, pending_relayer_key_hash: #"" }
  let continuing_output =
    Output {
      address: own_address,
      value: cto_out_value(2_000_000),
      datum: InlineDatum(new_datum),
      reference_script: None,
    }
  let relayer_output =
    Output {
      address: from_verification_key(#"33") |> with_delegation_key(#"aa"),
      value: assets.from_lovelace(25_000_000),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [mock_lp_ref_input(mock_grad_ts)],
      outputs: [continuing_output, relayer_output],
    }

  cto_governance.spend(Some(datum), ReclaimRelayerBond, own_ref, self)
}
