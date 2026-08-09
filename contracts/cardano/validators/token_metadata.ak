// ============================================================================
// Noctis Protocol — Cardano L1 Token Metadata Contract (Aiken)
// CIP-68 reference NFT — mutable on-chain token metadata, Tier A
// ============================================================================
// This validator guards the CIP-68 reference NFT's UTXO: the datum it holds
// IS the launch token's metadata, and spending that UTXO is how the metadata
// is revised. Discovery is the standard's own: the reference NFT and the
// launch token share one policy id and one base name behind CIP-67 labels
// 100 and 333, so a wallet holding the token resolves this UTXO by name.
// Both are minted together in the launch's single genesis transaction — see
// launch_token_policy.ak.
//
// WHY MINTING ONCE COSTS NOTHING HERE
// The launch token's policy is a one-shot: it mints exactly once and can
// never mint again. That is no constraint on metadata, because CIP-68
// revises metadata by SPENDING this UTXO and recreating it with a new datum,
// never by minting. So the token's supply can be structurally fixed forever
// while its name, logo and description stay updatable for the life of the
// launch — by the creator, and by the community once CTO has passed.
//
// Authorization mirrors bonding_curve.ak's TriggerCTO/DissolveCTO pattern
// for the CTO-triggered half (same governance event — same
// cto_governance_credential + thread_nft_policy values as the launch's own
// bonding_curve.ak datum — one passed CTO vote flips both fee authority and
// metadata authority together, not two independent mechanisms).
//
// Security-audit fix (this session, aiken-dex-security-audit pass): the
// FIRST version of this file trusted a self-declared `creator_pub_key_hash`
// field on this contract's OWN datum for pre-CTO authorization — but
// nothing prevents anyone from locking an entirely independent, freshly
// self-minted UTXO at this same shared script address with a FORGED datum
// (any launch_id, any creator_pub_key_hash they like, any metadata_ipfs_cid)
// — sending value+datum to a script address never runs that script's
// validator, only spending FROM it does. The fix: pre-CTO signer authority
// is now ALWAYS re-derived LIVE from the real, unforgeable
// bonding_curve.ak UTXO for that launch_id (read as a reference input,
// matched by address + launch_id) — never trusted as a self-declared field
// on this contract's own datum. A forged UTXO can still be created (nothing
// stops locking a first output with junk content), but it can never be
// legitimately UPDATED by anyone except whoever really holds that launch's
// real creator key, and the same live check is applied at mint time too, so
// off-chain readers/indexers should treat "was the mint tx itself signed by
// the live bonding_curve creator key" as the canonical genuineness filter.
// Tier B (bonding_curve_tier_b.ak) needs the identical treatment before
// Tier B launches can safely use this feature — not yet done, since Tier B
// itself doesn't have real sell support wired yet at time of writing (see
// the Tier B test plan's own Phase 1).
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use bonding_curve.{BondingCurveDatum}
use cardano/address.{Address, Credential, from_verification_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use cto_governance.{
  CtoGovernanceDatum, DissolveCTOProposal, Executed, Passed, ProposalAnchor,
  ProposalType, SilenceLockTrigger,
}
use noctis/cap_accumulator
use noctis/cip68
use noctis/thread_nft

// ============================================================================
// TYPES
// ============================================================================

/// Everything CIP-68 leaves to the issuer. The standard reserves the third
/// datum field for "custom user defined plutus data", which is exactly what
/// this launch's governance and identity state is — it rides alongside the
/// metadata rather than inside it, so a wallet reading the standard's map
/// never has to know about any of it.
pub type NoctisMetadataExtra {
  launch_id: ByteArray,
  // Fixed at genesis — this launch's own bonding_curve.ak credential (same
  // "no constructor params, one fixed address shared across every launch,
  // launch_id disambiguates" pattern already used for
  // cto_governance_credential). Paired with token_policy_id/
  // token_asset_name below: live_curve_creator only trusts a reference
  // input at this credential once it also holds a real, substantial
  // quantity of this launch's own genuine token — see live_curve_creator's
  // own doc comment for the full reasoning.
  bonding_curve_credential: Credential,
  // This launch's own native token identity, exactly as it appears in
  // bonding_curve.ak's own datum. `token_asset_name` is the CIP-67 label-333
  // name the curve actually holds; the reference NFT guarding THIS UTXO is
  // the label-100 name over the same base, derived by own_reference_nft.
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // Meaningless until cto_triggered. Unlike the creator identity above,
  // this IS safe to store directly on this datum: it's only ever written by
  // TriggerCTO, which independently re-verifies real anchored vote evidence
  // (cto_vote_verified) every time, so a forged UTXO can set its own
  // community_pub_key_hash via TriggerCTO too, but only by citing a REAL
  // passed vote for the SAME launch_id — which correctly requires no
  // additional protection here.
  community_pub_key_hash: VerificationKeyHash,
  cto_triggered: Bool,
  cto_governance_credential: Credential,
  thread_nft_policy: PolicyId,
  // Monotonic count of metadata revisions. Distinct from `version` on the
  // datum below, which is CIP-68's own standard version and never moves.
  metadata_revision: Int,
  last_updated_ts: Int,
}

/// CIP-68's reference-NFT datum, exactly as the standard defines it:
/// constructor 0 over `[metadata, version, extra]`.
///
/// `metadata` is the standard's own map. The 333 fungible-token sub-standard
/// requires `name` and `description`, and allows `ticker`, `url`, `decimals`
/// and `logo`. It is held here as opaque data because this validator's job is
/// authority over WHO may revise the metadata, never over what it says — the
/// reader is a wallet, not this script.
pub type TokenMetadataDatum {
  metadata: Pairs<ByteArray, Data>,
  version: Int,
  extra: NoctisMetadataExtra,
}

pub type TokenMetadataRedeemer {
  UpdateMetadata { new_metadata: Pairs<ByteArray, Data>, current_timestamp: Int }
  TriggerCTO { community_pub_key_hash: VerificationKeyHash }
  DissolveCTO
}

// ============================================================================
// HELPERS
// ============================================================================

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum. Identical idiom to every other
/// validator in this codebase (bonding_curve.ak, lp_escrow.ak,
/// cto_governance.ak, vesting.ak, staking_pool.ak, zk_anchor.ak).
fn own_continuing_datum(
  self: Transaction,
  own_ref: OutputReference,
) -> TokenMetadataDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: TokenMetadataDatum = raw_datum
  new_datum
}

/// Closes the same double-satisfaction risk bonding_curve.ak's own fix
/// closes — at most one of this validator's own UTXOs may be spent/created
/// per transaction.
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

/// Security-audit fix: the real, unforgeable creator identity for
/// `datum.launch_id`, read LIVE from the genuine bonding_curve.ak reference
/// input every time — never trusted as a value stored on this contract's
/// own (attacker-writable, at first-lock time) datum. Genuineness comes
/// from the same place it does for bonding_curve.ak itself: the referenced
/// UTXO's address is the real curve script's credential, and only the real
/// curve — funded by the platform's own time-locked, unforgeable minting
/// policy — is economically meaningful to hold real curve state; a forged
/// reference input at that address with a fabricated launch_id would not
/// correspond to any real launch's own curve, so the launch_id match below
/// is what actually pins this to the SPECIFIC launch being claimed.
// Derived from CLAUDE.md's fixed platform constants: TOTAL_SUPPLY
// (1,000,000,000) and WALLET_CAP_PCT (5). Set comfortably above the most
// any single non-curve wallet can ever legitimately hold (5% =
// 50,000,000) and comfortably below what the real bonding curve itself
// always holds even at every optional allocation's simultaneous maximum
// (CLAUDE.md's own supply-math note: the curve retains at least 30% =
// 300,000,000 in every case).
const min_curve_token_holding = 100_000_000

fn live_curve_creator(
  self: Transaction,
  datum: TokenMetadataDatum,
) -> VerificationKeyHash {
  expect Some(curve_ref_input) =
    list.find(
      self.reference_inputs,
      fn(input) {
        input.output.address.payment_credential == datum.extra.bonding_curve_credential
      },
    )
  expect InlineDatum(curve_raw_datum) = curve_ref_input.output.datum
  expect curve_datum: BondingCurveDatum = curve_raw_datum
  expect curve_datum.launch_id == datum.extra.launch_id
  expect
    assets.quantity_of(
      curve_ref_input.output.value,
      datum.extra.token_policy_id,
      datum.extra.token_asset_name,
    ) >= min_curve_token_holding
  curve_datum.creator_pub_key_hash
}

/// This launch's CIP-68 reference NFT — the label-100 name over the same base
/// as the label-333 token the curve holds, under the same policy id, as the
/// standard requires.
fn own_reference_nft(datum: TokenMetadataDatum) -> (PolicyId, AssetName) {
  (
    datum.extra.token_policy_id,
    cip68.reference_asset_name(cip68.base_name(datum.extra.token_asset_name)),
  )
}

/// The UTXO being spent must be the genuine reference NFT's, and must still
/// be carrying it afterwards.
///
/// This validator is unparameterized, so every launch's metadata lives at one
/// shared address and paying to a script address never runs its validator —
/// the reference NFT is what distinguishes the real UTXO from any other one
/// sitting there. It can only exist because launch_token_policy minted it in
/// the launch's own genesis transaction, and that policy can never mint
/// again, so exactly one of these exists per launch, forever. Requiring it on
/// the continuing output too means it cannot be stripped mid-life.
fn carries_own_reference_nft(
  datum: TokenMetadataDatum,
  own_input: Input,
  new_output: Output,
) -> Bool {
  let (policy, name) = own_reference_nft(datum)
  and {
    assets.quantity_of(own_input.output.value, policy, name) == 1,
    assets.quantity_of(new_output.value, policy, name) == 1,
  }
}

/// The continuing output at this validator's own address.
fn own_continuing_output(self: Transaction, own_address: Address) -> Output {
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  own_output
}

/// Tamper-proof "did CTO really pass" check — literal reuse of
/// bonding_curve.ak's cto_vote_verified (same reference-input +
/// governance-thread-NFT authentication; see that function's own doc
/// comment in bonding_curve.ak for the full reasoning on why address
/// matching alone is not sufficient).
fn cto_vote_verified(
  self: Transaction,
  datum: TokenMetadataDatum,
  proposal_type: ProposalType,
  expected_recipient: Option<VerificationKeyHash>,
) -> Bool {
  expect Some(cto_ref_input) =
    list.find(
      self.reference_inputs,
      fn(input) {
        input.output.address.payment_credential == datum.extra.cto_governance_credential
      },
    )
  expect InlineDatum(cto_raw_datum) = cto_ref_input.output.datum
  expect cto_datum: CtoGovernanceDatum = cto_raw_datum
  expect Some(executed) = cto_datum.last_executed_proposal

  let recipient_ok = when expected_recipient is {
    Some(recipient) -> executed.allocation_recipient_hash == recipient
    None -> True
  }

  and {
    // The role-tagged thread-NFT name, matching what cto_governance.ak
    // actually carries — one policy holds a distinct thread NFT for each of
    // a launch's state UTXOs, so the name is the role tag plus the launch
    // id, never the bare launch id. See noctis/thread_nft.
    assets.quantity_of(
      cto_ref_input.output.value,
      datum.extra.thread_nft_policy,
      thread_nft.thread_asset_name(
        thread_nft.role_cto_governance,
        datum.extra.launch_id,
      ),
    ) == 1,
    cto_datum.launch_id == datum.extra.launch_id,
    executed.proposal_type == proposal_type,
    executed.outcome == Passed,
    executed.execution_status == Executed,
    recipient_ok,
  }
}

/// The identity currently allowed to update metadata — the launch's real,
/// live-verified creator key, or (once CTO has been triggered) the
/// community wallet. `live_creator_key` must come from live_curve_creator,
/// never from a self-declared datum field.
fn active_metadata_signer(
  datum: TokenMetadataDatum,
  live_creator_key: VerificationKeyHash,
) -> VerificationKeyHash {
  if datum.extra.cto_triggered {
    datum.extra.community_pub_key_hash
  } else {
    live_creator_key
  }
}

// ============================================================================
// VALIDATOR
// ============================================================================

validator token_metadata {
  spend(
    datum_opt: Option<TokenMetadataDatum>,
    redeemer: TokenMetadataRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    let new_output = own_continuing_output(self, own_input.output.address)

    and {
      single_own_utxo(self, own_input.output.address),
      // Every branch below recreates this UTXO, so the reference NFT is
      // required on both sides of all three of them.
      carries_own_reference_nft(datum, own_input, new_output),
      when redeemer is {
        UpdateMetadata { new_metadata, current_timestamp } -> {
          let new_datum = own_continuing_datum(self, own_ref)
          let live_creator_key = live_curve_creator(self, datum)
          and {
            list.has(
              self.extra_signatories,
              active_metadata_signer(datum, live_creator_key),
            ),
            // A launch always has metadata; emptying the map would leave the
            // token with nothing for a wallet to display. What the map SAYS
            // is the creator's business, so nothing further is imposed here.
            new_metadata != [],
            // Security-audit fix: current_timestamp was previously entirely
            // self-declared with no correspondence-to-reality check, unlike
            // bonding_curve.ak's ActivateCurve (see that file's own fix
            // note on why self-declared timestamps without a validity-range
            // check are a real gap class in this codebase).
            interval.contains(self.validity_range, current_timestamp),
            // `version` is CIP-68's standard version and is carried through
            // untouched by `..datum` — a revision changes what the metadata
            // says, never which standard it is written in.
            new_datum == TokenMetadataDatum {
              ..datum,
              metadata: new_metadata,
              extra: NoctisMetadataExtra {
                ..datum.extra,
                metadata_revision: datum.extra.metadata_revision + 1,
                last_updated_ts: current_timestamp,
              },
            },
          }
        }

        TriggerCTO { community_pub_key_hash } -> {
          let new_datum = own_continuing_datum(self, own_ref)
          and {
            cto_vote_verified(
              self,
              datum,
              SilenceLockTrigger,
              Some(community_pub_key_hash),
            ),
            !datum.extra.cto_triggered,
            community_pub_key_hash != #"",
            new_datum == TokenMetadataDatum {
              ..datum,
              extra: NoctisMetadataExtra {
                ..datum.extra,
                cto_triggered: True,
                community_pub_key_hash: community_pub_key_hash,
              },
            },
          }
        }

        DissolveCTO -> {
          let new_datum = own_continuing_datum(self, own_ref)
          and {
            cto_vote_verified(self, datum, DissolveCTOProposal, None),
            datum.extra.cto_triggered,
            new_datum == TokenMetadataDatum {
              ..datum,
              extra: NoctisMetadataExtra {
                ..datum.extra,
                cto_triggered: False,
                community_pub_key_hash: #"",
              },
            },
          }
        }
      },
    }
  }
}

// The reference NFT this validator guards is minted by the launch token's
// own policy, in the launch's genesis transaction — CIP-68 requires a token
// and its reference NFT to share one policy id, and that shared id is what
// makes the metadata discoverable from the token alone. See
// launch_token_policy.ak.

// ============================================================================
// TESTS
// ============================================================================

/// The ticker as a creator would type it. Both on-chain names derive from it:
/// the curve holds the label-333 token, this validator's UTXO holds the
/// label-100 reference NFT, and CIP-68 binds them by this shared base.
const mock_ticker: ByteArray = "tok"

const mock_token_policy: PolicyId = #"33"

fn mock_metadata() -> Pairs<ByteArray, Data> {
  let name: Data = "Mock Token"
  let ticker: Data = mock_ticker
  [Pair("name", name), Pair("ticker", ticker)]
}

fn mock_curve_datum(launch_id: ByteArray, creator_pub_key_hash: VerificationKeyHash) -> BondingCurveDatum {
  BondingCurveDatum {
    launch_id: launch_id,
    creator_pub_key_hash: creator_pub_key_hash,
    governor_pub_key_hash: #"22",
    base_price: 100,
    max_price: 1000,
    curve_supply: 1000,
    curve_state: bonding_curve.Active,
    phase_started_at: 0,
    tokens_sold: 0,
    total_raised: 0,
    creator_fees_accrued: 0,
    platform_fees_accrued: 0,
    wallet_cap: 500,
    token_policy_id: mock_token_policy,
    token_asset_name: cip68.fungible_asset_name(mock_ticker),
    lp_escrow_credential: from_verification_key(#"ff").payment_credential,
    lp_reserve_tokens: 150,
    lp_seeded: False,
    community_pub_key_hash: #"",
    cto_triggered: False,
    staking_enabled: False,
    staking_pool_credential: from_verification_key(#"aa").payment_credential,
    staking_reserve_tokens: 0,
    staking_seeded: False,
    cto_governance_credential: from_verification_key(#"dd").payment_credential,
    thread_nft_policy: #"c0ffee",
    // This fixture never trades, so the cap accumulator stays at genesis.
    cap_root: cap_accumulator.root_of([]),
  }
}

/// This launch's reference NFT, as a value — one unit, under the launch
/// token's own policy, at the label-100 name.
fn mock_reference_nft() -> assets.Value {
  assets.from_asset(
    mock_token_policy,
    cip68.reference_asset_name(mock_ticker),
    1,
  )
}

fn mock_curve_ref_input(curve_address: Address, curve_datum: BondingCurveDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"ab", output_index: 0 },
    output: Output {
      address: curve_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(
          curve_datum.token_policy_id,
          curve_datum.token_asset_name,
          min_curve_token_holding,
        ),
      ),
      datum: InlineDatum(curve_datum),
      reference_script: None,
    },
  }
}

fn mock_datum(curve_credential: Credential) -> TokenMetadataDatum {
  TokenMetadataDatum {
    metadata: mock_metadata(),
    version: 1,
    extra: NoctisMetadataExtra {
      launch_id: #"01",
      bonding_curve_credential: curve_credential,
      token_policy_id: mock_token_policy,
      token_asset_name: cip68.fungible_asset_name(mock_ticker),
      community_pub_key_hash: #"",
      cto_triggered: False,
      cto_governance_credential: from_verification_key(#"dd").payment_credential,
      thread_nft_policy: #"c0ffee",
      metadata_revision: 1,
      last_updated_ts: 1000,
    },
  }
}

fn mock_own_input(datum: TokenMetadataDatum) -> (Input, OutputReference, Address) {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: mock_reference_nft(),
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }
  (own_input, own_ref, own_address)
}

fn mock_continuing_output(own_address: Address, datum: TokenMetadataDatum) -> Output {
  Output {
    address: own_address,
    value: mock_reference_nft(),
    datum: InlineDatum(datum),
    reference_script: None,
  }
}

fn mock_proposal_anchor(
  proposal_type: ProposalType,
  outcome: cto_governance.ProposalOutcome,
  execution_status: cto_governance.ExecutionStatus,
  allocation_recipient_hash: ByteArray,
) -> ProposalAnchor {
  ProposalAnchor {
    proposal_type: proposal_type,
    description_hash: #"aa",
    proof_bundle_hash: #"bb",
    yes_votes: 60_000,
    no_votes: 10_000,
    voter_count: 15,
    creator_yes_votes: 0,
    creator_no_votes: 0,
    outcome: outcome,
    start_timestamp: 0,
    end_timestamp: 1000,
    anchor_timestamp: 500,
    execution_status: execution_status,
    target_dex_credential: None,
    allocation_amount: 0,
    allocation_recipient_hash: allocation_recipient_hash,
    relayer_credential_hash: #"33",
  }
}

fn mock_cto_governance_datum(
  launch_id: ByteArray,
  last_executed_proposal: Option<ProposalAnchor>,
) -> CtoGovernanceDatum {
  CtoGovernanceDatum {
    launch_id: launch_id,
    cto_state: cto_governance.PreCTO,
    community_wallet_hash: #"",
    governor_credential_hash: #"22",
    total_supply: 1_000_000,
    quorum_bps: 500,
    creator_vote_cap_bps: 100,
    min_voter_count: 15,
    active_proposal: None,
    proposal_count: 1,
    last_executed_proposal: last_executed_proposal,
    pending_relayer_bond: 0,
    pending_relayer_key_hash: #"",
    treasury_pub_key_hash: #"55",
    ops_pub_key_hash: #"66",
    thread_nft_policy: #"c0ffee",
    ballot_duration: 500,
  }
}

/// A reference input at the given address holding the given
/// CtoGovernanceDatum, carrying the genuine governance thread NFT — mirrors
/// bonding_curve.ak's own mock_cto_ref_input exactly.
fn mock_cto_ref_input(cto_address: Address, cto_datum: CtoGovernanceDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"cd", output_index: 0 },
    output: Output {
      address: cto_address,
      value: assets.from_asset(
        #"c0ffee",
        thread_nft.thread_asset_name(
          thread_nft.role_cto_governance,
          cto_datum.launch_id,
        ),
        1,
      ),
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

/// Same forgery shape as bonding_curve.ak's regression test — a UTXO at
/// cto_governance_credential with a fully forged "Passed / Executed" datum
/// but WITHOUT the real governance thread NFT in its value.
fn mock_forged_cto_ref_input(cto_address: Address, cto_datum: CtoGovernanceDatum) -> Input {
  Input {
    output_reference: OutputReference { transaction_id: #"ce", output_index: 0 },
    output: Output {
      address: cto_address,
      value: assets.zero,
      datum: InlineDatum(cto_datum),
      reference_script: None,
    },
  }
}

/// What an UpdateMetadata call writes — a different map from mock_metadata(),
/// so a test that claims the datum changed is actually changing something.
fn updated_metadata() -> Pairs<ByteArray, Data> {
  let name: Data = "Renamed Token"
  [Pair("name", name)]
}

const real_creator_key = #"11"

const curve_address_key = #"bc"

fn mock_curve_setup() -> (Credential, Address, Input) {
  let curve_address = from_verification_key(curve_address_key)
  let curve_credential = curve_address.payment_credential
  let curve_datum = mock_curve_datum(#"01", real_creator_key)
  let curve_ref_input = mock_curve_ref_input(curve_address, curve_datum)
  (curve_credential, curve_address, curve_ref_input)
}

test update_metadata_succeeds_by_real_creator_pre_cto() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra {
        ..datum.extra,
        metadata_revision: 2,
        last_updated_ts: 2000,
      },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
    }
  token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_fails_by_forged_creator_key_pre_cto() {
  // The exact same-style forgery this fix closes: a UTXO whose datum claims
  // launch_id #"01", but the caller signs with a key that is NOT the real
  // bonding_curve.ak creator for that launch (real key is real_creator_key,
  // #"11" — the attacker signs with their own #"99" instead). Even though
  // the transaction cites the real curve reference input (publicly
  // readable by anyone), the signer check must still fail.
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [#"99"],
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

// live_curve_creator's real quantity check: a reference input at the
// correct credential, with a self-declared datum claiming the correct
// launch_id and an attacker-chosen creator_pub_key_hash, but carrying
// none of the launch's own real token — must not be trusted, even though
// address + launch_id alone match.
test update_metadata_fails_by_forged_reference_input_with_no_real_tokens() fail {
  let curve_address = from_verification_key(curve_address_key)
  let curve_credential = curve_address.payment_credential
  let attacker_key = #"99"
  let forged_curve_datum = mock_curve_datum(#"01", attacker_key)
  let forged_curve_ref_input =
    Input {
      output_reference: OutputReference { transaction_id: #"ff", output_index: 0 },
      output: Output {
        address: curve_address,
        value: assets.from_lovelace(2_000_000),
        datum: InlineDatum(forged_curve_datum),
        reference_script: None,
      },
    }
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [forged_curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [attacker_key],
    }
  token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

// live_curve_creator's `expect Some(...)` traps (rather than returning a
// clean False) when no matching reference input exists — a trap rejects
// the transaction exactly the same as a clean False would, but the test
// itself must be marked `fail` to assert on that, per this codebase's own
// convention (bonding_curve.ak's trigger_cto_rejects_without_reference_input).
test update_metadata_fails_without_a_real_curve_reference_input() fail {
  // No bonding_curve reference input at all — even a valid-looking
  // creator signature must not be enough on its own.
  let (curve_credential, _curve_address, _curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
    }
  token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_fails_by_community_wallet_pre_cto() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [#"ee"],
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_fails_by_creator_post_cto() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_succeeds_by_community_wallet_post_cto() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [#"ee"],
    }
  token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_fails_when_continuing_datum_mutates_disallowed_field() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  // Attempts to also change bonding_curve_credential — not one of the 3
  // fields UpdateMetadata is allowed to touch.
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra {
        ..datum.extra,
        metadata_revision: 2,
        last_updated_ts: 2000,
        bonding_curve_credential: from_verification_key(#"ff").payment_credential,
      },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 2000 },
    own_ref,
    self,
  )
}

/// A token always has metadata a wallet can render; a revision that emptied
/// the map would leave it with nothing to show.
test update_metadata_fails_when_new_metadata_is_empty() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: [],
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 2000 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: [], current_timestamp: 2000 },
    own_ref,
    self,
  )
}

test update_metadata_fails_when_current_timestamp_outside_validity_range() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let datum = mock_datum(curve_credential)
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum =
    TokenMetadataDatum {
      ..datum,
      metadata: updated_metadata(),
      extra: NoctisMetadataExtra { ..datum.extra, metadata_revision: 2, last_updated_ts: 999_999 },
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
      extra_signatories: [real_creator_key],
      // Real declared validity range is 400-600, but the redeemer claims
      // current_timestamp = 999_999 — a fabricated timestamp with no
      // correspondence to the transaction's own real validity range.
      validity_range: interval.between(400, 600),
    }
  !token_metadata.spend(
    Some(datum),
    UpdateMetadata { new_metadata: updated_metadata(), current_timestamp: 999_999 },
    own_ref,
    self,
  )
}

test trigger_cto_succeeds_with_real_anchored_vote() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum = TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_governance_credential: cto_credential,
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum = TokenMetadataDatum {
      ..datum,
      extra: NoctisMetadataExtra {
        ..datum.extra,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let executed_proposal = mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum = mock_cto_governance_datum(datum.extra.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input, cto_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
    }
  token_metadata.spend(Some(datum), TriggerCTO { community_pub_key_hash: #"ee" }, own_ref, self)
}

test trigger_cto_fails_without_genuine_governance_thread_nft() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum = TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_governance_credential: cto_credential,
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum = TokenMetadataDatum {
      ..datum,
      extra: NoctisMetadataExtra {
        ..datum.extra,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let executed_proposal = mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ee")
  let cto_datum = mock_cto_governance_datum(datum.extra.launch_id, Some(executed_proposal))
  let forged_ref_input = mock_forged_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input, forged_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
    }
  !token_metadata.spend(Some(datum), TriggerCTO { community_pub_key_hash: #"ee" }, own_ref, self)
}

test trigger_cto_fails_when_already_triggered() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_governance_credential: cto_credential,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum = TokenMetadataDatum {
      ..datum,
      extra: NoctisMetadataExtra { ..datum.extra, community_pub_key_hash: #"ff" },
    }
  let executed_proposal = mock_proposal_anchor(SilenceLockTrigger, Passed, Executed, #"ff")
  let cto_datum = mock_cto_governance_datum(datum.extra.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input, cto_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
    }
  !token_metadata.spend(Some(datum), TriggerCTO { community_pub_key_hash: #"ff" }, own_ref, self)
}

test dissolve_cto_succeeds_and_resets_state() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum =
    TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_governance_credential: cto_credential,
        cto_triggered: True,
        community_pub_key_hash: #"ee",
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let new_datum = TokenMetadataDatum {
      ..datum,
      extra: NoctisMetadataExtra {
        ..datum.extra,
        cto_triggered: False,
        community_pub_key_hash: #"",
      },
    }
  let executed_proposal = mock_proposal_anchor(DissolveCTOProposal, Passed, Executed, #"")
  let cto_datum = mock_cto_governance_datum(datum.extra.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input, cto_ref_input],
      outputs: [mock_continuing_output(own_address, new_datum)],
    }
  token_metadata.spend(Some(datum), DissolveCTO, own_ref, self)
}

test dissolve_cto_fails_when_not_triggered() {
  let (curve_credential, _curve_address, curve_ref_input) = mock_curve_setup()
  let cto_address = from_verification_key(#"aa")
  let cto_credential = cto_address.payment_credential
  let datum = TokenMetadataDatum {
      ..mock_datum(curve_credential),
      extra: NoctisMetadataExtra {
        ..mock_datum(curve_credential).extra,
        cto_governance_credential: cto_credential,
      },
    }
  let (own_input, own_ref, own_address) = mock_own_input(datum)
  let executed_proposal = mock_proposal_anchor(DissolveCTOProposal, Passed, Executed, #"")
  let cto_datum = mock_cto_governance_datum(datum.extra.launch_id, Some(executed_proposal))
  let cto_ref_input = mock_cto_ref_input(cto_address, cto_datum)
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      reference_inputs: [curve_ref_input, cto_ref_input],
      outputs: [mock_continuing_output(own_address, datum)],
    }
  !token_metadata.spend(Some(datum), DissolveCTO, own_ref, self)
}
