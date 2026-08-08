// ============================================================================
// Noctis Protocol — Cardano L1 N-Hop Challenge Contract (Aiken)
// Tier B only (CLAUDE.md, 2026-07-12)
// ============================================================================
// Implements CLAUDE.md's N-Hop Challenge Window (constants NHOP_CHALLENGE_BOND,
// NHOP_MAX_HOPS, NHOP_LOOKBACK_DAYS, NHOP_WINDOW_HRS, NHOP_DEFENCE_HRS).
// No fuller spec than those 5 constants + one sentence exists anywhere in
// this repo or HISTORY_ARCHIVE.md — the mechanism below was designed this
// session from that alone, with Jinx confirming each real design fork.
//
// Purpose: lets anyone challenge a Tier B DarkVeil claimant as a Sybil —
// specifically, a wallet within NHOP_MAX_HOPS (5) Cardano transaction hops
// of the creator's own wallet within a NHOP_LOOKBACK_DAYS (180) window,
// evidence of the "slot dilution" griefing vector described elsewhere (the
// creator's own associates registering as ghost DarkVeil participants to
// shrink `base_slot` for legitimate buyers).
//
// Why this is Tier B only: Tier C is already fully build-blocked,
// independent of this feature. Tier B already has a full
// Cardano contract suite (bonding_curve_tier_b.ak) to sit alongside.
//
// Why this lives on Cardano, not Midnight: the reporter bond
// (NHOP_CHALLENGE_BOND, 25 ADA) is ADA-denominated, and DarkVeil
// registration itself lives on Midnight — same cross-chain mismatch
// already solved by moving Tier B's public curve to Cardano entirely.
// ADA isn't representable as a Midnight-native token; this validator
// avoids that problem by existing on the same chain the bond is paid in.
//
// Why this triggers on CLAIM, not REGISTRATION (contradicts the constant's
// literal name, NHOP_WINDOW_HRS = "Challenge submission window after
// registration"): a registrant's real Cardano wallet is never publicly
// linked to their DarkVeil participation until they call
// `ClaimDarkVeilTokens` on `bonding_curve_tier_b.ak` — before that,
// not even the governor can prove on-chain which real wallet a given
// Midnight registration identity belongs to. Triggering the window at
// registration (as literally named) would require deanonymizing every
// registrant just to make them challengeable, defeating DarkVeil's whole
// privacy design. Jinx confirmed (2026-07-12): reinterpret the window as
// "72h after the wallet's real address becomes public via claim," not
// literally after registration. A registrant who never claims was never
// exposed, and is correctly never challengeable — consistent with
// internal tracking's existing description of this mechanism as "post-fact detection,"
// not real-time prevention (the claimed tokens can't be clawed back once
// delivered — this mechanism is about accountability + a bounty, not
// stopping the dilution before it happens).
//
// Why no reference input to bonding_curve_tier_b.ak's own UTXO: an earlier
// draft of this design tried to cross-verify the challenged wallet's real
// claim timestamp on-chain via a reference input to the curve's datum.
// Dropped: the governor already has to adjudicate the actual N-hop
// evidence off-chain (this validator has no way to independently verify a
// Cardano transaction graph inside a script either — same category of
// off-chain-attested fact as `hasClaimableBalance` or
// `lastCreatorActivity`), so requiring the SAME governor to also honestly
// judge "was this submitted within the real window" off-chain adds no new
// trust assumption, and keeps this validator's on-chain surface narrow:
// hold the bond, enforce the defense-window minimum wait, pay out
// correctly based on the governor's Upheld/Rejected call.
//
// What's NOT verified on-chain (by design, same reasoning as above):
//   - Whether the N-hop path evidence is real (governor-adjudicated
//     off-chain against real Blockfrost data before resolving)
//   - Whether the challenge was submitted within the real post-claim
//     window (same off-chain judgment)
//   - `evidence_hash` is an audit-trail commitment only (hash of the
//     off-chain tx-hash-sequence evidence the challenger is relying on),
//     not independently checked here
//
// What IS verified on-chain: governor-only resolution, no double-
// resolution (a resolved challenge's UTXO is fully spent — there is no
// continuing datum, so "already resolved" isn't a state to check, it's
// simply gone), the 24h defense window has genuinely elapsed (real chain
// time via validity_range, not a caller-supplied claim), and the payout
// itself: Upheld returns the challenger's bond in full; Rejected forfeits
// it, split 60/40 treasury/ops (same ratio as the forfeited-NIGHT-bond
// split, for consistency, not because CLAUDE.md specifies it for this
// mechanism — genuinely undecided beyond "some split," flagged here).
//
// Submission has no validator logic at all — depositing ADA + a datum at
// this script address needs no signature or check (Cardano doesn't gate
// deposits to a script, only spends from one). A malformed/underfunded
// challenge (e.g. a datum claiming a bond bigger than what's actually
// locked) simply can't resolve Upheld — Cardano's own balance-conservation
// rules block a payout exceeding what the input actually holds, so no
// extra on-chain check is needed to guard against it.
//
// Compiler: Aiken v1.1.23, Plutus v3 (matches every other validator in
// this directory).
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/address.{Address, from_verification_key}
use cardano/assets
use cardano/transaction.{InlineDatum, Output, OutputReference, Transaction}
use noctis/settlement

// ============================================================================
// TYPES
// ============================================================================

pub type NHopChallengeDatum {
  launch_id: ByteArray,
  governor_pub_key_hash: VerificationKeyHash,
  // The wallet being accused of being within NHOP_MAX_HOPS of the
  // creator — only meaningful post-claim, see file header.
  challenged_wallet: VerificationKeyHash,
  challenger_key_hash: VerificationKeyHash,
  // Must equal the real lovelace locked in this UTXO — enforced
  // implicitly by Cardano's balance-conservation rules at resolution,
  // not re-checked explicitly here (see file header).
  bond_amount: Int,
  // Posix MILLISECONDS the challenge was submitted — the defense window
  // (NHOP_DEFENCE_HRS) counts from here. Milliseconds, not seconds — matches
  // every other timestamp in this codebase (`interval.contains` against a
  // real tx validity range requires ms on-chain, confirmed elsewhere) and this
  // file's own `current_timestamp` redeemer field, which it's compared
  // against directly. This field's doc comment previously said "Posix
  // seconds" while `nhop_defence_seconds` (now `nhop_defence_ms`) was named
  // and valued as seconds too — a real, unfixed instance of the same
  // ms-vs-seconds bug class found and fixed elsewhere, caught here
  // 2026-07-22 before any off-chain submitter existed to populate this field
  // with the wrong unit (this file had already been flagged as an open
  // instance of the same bug, unfixed at the time since no submitter
  // existed yet to verify the real convention against). Left unfixed, a
  // real ms-scale `current_timestamp` would always vastly exceed a
  // seconds-scale `submitted_at + nhop_defence_seconds` threshold, making
  // the 24-hour defense window resolvable immediately upon submission.
  submitted_at: Int,
  // Audit-trail commitment to the off-chain hop-path evidence (a hash of
  // the challenger's claimed tx-hash sequence). Not independently
  // verified on-chain — see file header.
  evidence_hash: ByteArray,
  treasury_pub_key_hash: VerificationKeyHash,
  ops_pub_key_hash: VerificationKeyHash,
}

pub type NHopChallengeRedeemer {
  /// Governor-only. `current_timestamp` is verified against the tx's real
  /// validity range (Cardano scripts can't read wall-clock time directly),
  /// same idiom as every other timestamp check in this codebase.
  ResolveChallenge { upheld: Bool, current_timestamp: Int }
}

// ============================================================================
// CONSTANTS
// ============================================================================

/// 24 hours in MILLISECONDS (NHOP_DEFENCE_HRS) — minimum wait after
/// submission before the governor can resolve, giving the registrant time
/// to reach the governor with a rebuttal off-chain. Fixed 2026-07-22 — was
/// `nhop_defence_seconds = 86_400` (seconds), the same ms-vs-seconds bug
/// class found in other files' timestamp constants; see
/// `submitted_at`'s doc comment above for the full explanation.
const nhop_defence_ms = 86_400_000

/// Forfeited-bond split on a Rejected challenge — same 60/40 treasury/ops
/// ratio as the forfeited-NIGHT-bond split, chosen for consistency, not
/// because CLAUDE.md specifies a ratio for this mechanism specifically.
const treasury_bps = 60

const ops_bps = 40

const bps_denominator = 100

// ============================================================================
// HELPERS
// ============================================================================

/// Verify some output pays at least `amount` lovelace to `key_hash`'s
/// wallet address — same real-value-movement pattern used throughout this
/// codebase's fee/refund payouts (e.g. bonding_curve_tier_b.ak's
/// `buyback_share_paid`).
fn paid_to(
  self: Transaction,
  own_ref: OutputReference,
  key_hash: VerificationKeyHash,
  amount: Int,
) -> Bool {
  let addr = from_verification_key(key_hash)
  list.any(
    self.outputs,
    fn(output: Output) {
      // The payout has to NAME the challenge it settles, by carrying that
      // challenge's own OutputReference as its datum.
      //
      // Without it this is an existential check over the whole transaction:
      // "somebody pays this wallet at least this much". Two settlements owing
      // the same wallet the same amount are then both satisfied by ONE output,
      // and they need not even be from the same contract, so no per-contract
      // restriction can see it. Scoping by address and amount cannot fix that,
      // because those are precisely what the two settlements have in common.
      //
      // An OutputReference is unique across the whole chain by construction,
      // so two settlements can never ask for the same tag, and one output can
      // never answer both.
      and {
        output.address == addr,
        assets.lovelace_of(output.value) >= amount,
        settlement.settles(output, own_ref),
      }
    },
  )
}

/// Fix (2026-07-20, Aiken security-review pass): this validator has
/// zero constructor parameters — every N-hop challenge across every Tier B
/// launch shares ONE fixed script address, distinguished only by launch_id
/// in the datum (same structural precondition as the double-satisfaction
/// gap fixed across bonding_curve.ak/lp_escrow.ak/vesting.ak/
/// staking_pool.ak/zk_anchor.ak/cto_governance.ak). `paid_to`'s existential
/// check (`list.any`, not scoped to a specific input) means resolving TWO
/// challenges in one transaction lets a SINGLE combined output satisfy
/// BOTH challenges' payout checks simultaneously — most concretely via
/// `treasury_pub_key_hash`/`ops_pub_key_hash`, which are the same real
/// platform addresses across every challenge, so two `Rejected`
/// resolutions in one tx could real-pay only one challenge's forfeited
/// bond while both validators independently accept. Requires the governor
/// to construct (or be tricked into signing) a batching transaction — not
/// a third-party drain — but closed structurally rather than left as a
/// "the off-chain tx-builder must remember never to batch" footgun, same
/// discipline as every other double-satisfaction fix this session.
fn single_own_utxo(self: Transaction, own_address: Address) -> Bool {
  // Compared by PAYMENT credential, never by the full Address — the staking
  // part is chosen freely by whoever builds the output, so two UTXOs at this
  // same script can differ there while being equally "ours".
  let own_payment = own_address.payment_credential
  list.length(
    list.filter(
      self.inputs,
      fn(input) { input.output.address.payment_credential == own_payment },
    ),
  ) <= 1
}

// ============================================================================
// VALIDATOR
// ============================================================================

validator nhop_challenge {
  spend(
    datum_opt: Option<NHopChallengeDatum>,
    redeemer: NHopChallengeRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    let ResolveChallenge { upheld, current_timestamp } = redeemer
    let base_checks =
      and {
        list.has(self.extra_signatories, datum.governor_pub_key_hash),
        interval.contains(self.validity_range, current_timestamp),
        current_timestamp >= datum.submitted_at + nhop_defence_ms,
        single_own_utxo(self, own_input.output.address),
        // Fix: the file's own header claims bond_amount "must
        // equal the real lovelace locked in this UTXO — enforced
        // implicitly by Cardano's balance-conservation rules" — false as
        // originally written; nothing tied datum.bond_amount to the real
        // input value, so an overfunded deposit (submission has no
        // validator logic at all, by design) let the governor route any
        // excess to an unaccounted destination while both payout checks
        // below still passed. Now actually enforced.
        assets.lovelace_of(own_input.output.value) == datum.bond_amount,
      }
    if upheld {
      and {
        base_checks,
        paid_to(self, own_ref, datum.challenger_key_hash, datum.bond_amount),
      }
    } else {
      let treasury_share = datum.bond_amount * treasury_bps / bps_denominator
      let ops_share = datum.bond_amount - treasury_share
      and {
        base_checks,
        paid_to(self, own_ref, datum.treasury_pub_key_hash, treasury_share),
        paid_to(self, own_ref, datum.ops_pub_key_hash, ops_share),
      }
    }
  }

  else(_) {
    fail
  }
}

// ============================================================================
// TESTS
// ============================================================================

fn mock_datum() -> NHopChallengeDatum {
  NHopChallengeDatum {
    launch_id: #"aa",
    governor_pub_key_hash: #"dd",
    challenged_wallet: #"ee",
    challenger_key_hash: #"ff",
    bond_amount: 25_000_000,
    submitted_at: 1_000_000,
    evidence_hash: #"11",
    treasury_pub_key_hash: #"22",
    ops_pub_key_hash: #"33",
  }
}

fn mock_input(datum: NHopChallengeDatum) -> (OutputReference, transaction.Input) {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_verification_key(#"cc"),
        value: assets.from_lovelace(25_000_000),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  (own_ref, own_input)
}

test resolve_upheld_succeeds_after_defence_window() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_splits_bond_treasury_ops() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let treasury_payout =
    Output {
      address: from_verification_key(datum.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      // 60% of 25 ADA
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let ops_payout =
    Output {
      address: from_verification_key(datum.ops_pub_key_hash),
      value: assets.from_lovelace(10_000_000),
      // remaining 40%
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [treasury_payout, ops_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_without_governor_signature() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      // No extra_signatories at all — impostor attempt.
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejects_before_defence_window_elapses() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let too_early = datum.submitted_at + nhop_defence_ms - 1
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(too_early - 10, too_early + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: too_early },
    own_ref,
    self,
  )
}

test resolve_upheld_rejects_underpaid_challenger() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let short_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount - 1),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [short_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

test resolve_rejected_rejects_missing_ops_share() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let treasury_payout =
    Output {
      address: from_verification_key(datum.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      // Missing the ops payout entirely.
      outputs: [treasury_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// Fix (2026-07-20): two challenges resolved in one transaction,
// both Rejected, sharing the same treasury/ops addresses — a single
// combined output must not be able to satisfy both challenges' payout
// checks simultaneously.
test resolve_rejects_when_batched_with_a_second_challenge_input() {
  let datum_a = mock_datum()
  let datum_b = NHopChallengeDatum { ..mock_datum(), launch_id: #"bb" }
  let own_address = from_verification_key(#"cc")
  let own_ref_a = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_ref_b = OutputReference { transaction_id: #"00", output_index: 1 }
  let input_a =
    transaction.Input {
      output_reference: own_ref_a,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(25_000_000),
        datum: transaction.InlineDatum(datum_a),
        reference_script: None,
      },
    }
  let input_b =
    transaction.Input {
      output_reference: own_ref_b,
      output: Output {
        address: own_address,
        value: assets.from_lovelace(25_000_000),
        datum: transaction.InlineDatum(datum_b),
        reference_script: None,
      },
    }
  let resolve_time = datum_a.submitted_at + nhop_defence_ms
  // Only ONE real payout, sized for a single challenge's forfeiture —
  // both challenges' own paid_to checks would independently accept it.
  let treasury_payout =
    Output {
      address: from_verification_key(datum_a.treasury_pub_key_hash),
      value: assets.from_lovelace(15_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let ops_payout =
    Output {
      address: from_verification_key(datum_a.ops_pub_key_hash),
      value: assets.from_lovelace(10_000_000),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [input_a, input_b],
      outputs: [treasury_payout, ops_payout],
      extra_signatories: [datum_a.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum_a),
    ResolveChallenge { upheld: False, current_timestamp: resolve_time },
    own_ref_a,
    self,
  )
}

// Fix (2026-07-20): an overfunded challenge deposit (real locked
// value exceeds the datum's claimed bond_amount) must not let the excess
// go anywhere unaccounted — the full real input value must match the
// claimed bond_amount.
test resolve_rejects_when_real_value_exceeds_claimed_bond_amount() {
  let datum = mock_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_input =
    transaction.Input {
      output_reference: own_ref,
      output: Output {
        address: from_verification_key(#"cc"),
        // Real locked value (30 ADA) exceeds datum.bond_amount (25 ADA).
        value: assets.from_lovelace(30_000_000),
        datum: transaction.InlineDatum(datum),
        reference_script: None,
      },
    }
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      // Pays exactly the claimed bond_amount — the 5 ADA excess is
      // unaccounted for (could go anywhere, e.g. back to the governor).
      value: assets.from_lovelace(datum.bond_amount),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}

// One output cannot settle two challenges. This payout is real, goes to the
// right wallet and carries the right amount — it simply names a different
// challenge, which is what a single output shared between two settlements
// looks like from inside either one of them. Address and amount are precisely
// what the two have in common, so only the tag can tell them apart.
test resolve_rejects_a_payout_settling_a_different_challenge() {
  let datum = mock_datum()
  let (own_ref, own_input) = mock_input(datum)
  let resolve_time = datum.submitted_at + nhop_defence_ms
  let challenger_payout =
    Output {
      address: from_verification_key(datum.challenger_key_hash),
      value: assets.from_lovelace(datum.bond_amount),
      datum: InlineDatum(
        OutputReference { transaction_id: #"99", output_index: 7 },
      ),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [challenger_payout],
      extra_signatories: [datum.governor_pub_key_hash],
      validity_range: interval.between(resolve_time - 10, resolve_time + 10),
    }

  !nhop_challenge.spend(
    Some(datum),
    ResolveChallenge { upheld: True, current_timestamp: resolve_time },
    own_ref,
    self,
  )
}
