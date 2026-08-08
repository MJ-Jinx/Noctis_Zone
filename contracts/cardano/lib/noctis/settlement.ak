// ============================================================================
// Noctis Protocol — settlement tagging
// ============================================================================
// A payout check written as "some output pays R at least N" is a question
// about the whole transaction, not about the spend being validated. Two
// obligations that happen to owe the same wallet the same amount therefore
// read the same answer from the same output — one payment settles both, and
// the difference is free.
//
// Scoping by address or by amount cannot help, because address and amount are
// exactly what the two obligations have in common. Restricting how many of a
// contract's OWN UTXOs a transaction may spend cannot help either, because the
// two obligations may belong to different contracts, and no contract can see
// another's inputs.
//
// What distinguishes them is which input each settles. So a settlement output
// NAMES its input, carrying that input's `OutputReference` as its datum. An
// `OutputReference` is unique across the chain by construction: no two spends
// can ask for the same tag, and one output cannot answer two.
//
// The cost is one inline datum per settlement output, and that a transaction
// settling two obligations must build two outputs. Both are ordinary.

use cardano/address.{from_verification_key}
use cardano/assets
use cardano/transaction.{InlineDatum, NoDatum, Output, OutputReference}

/// True when `output` is tagged as settling `own_ref`.
///
/// Callers keep their own value and recipient checks — this adds the one
/// thing those cannot express, which is *whose* obligation the output
/// discharges.
pub fn settles(output: Output, own_ref: OutputReference) -> Bool {
  output.datum == InlineDatum(own_ref)
}

// ============================================================================
// TESTS
// ============================================================================

fn tagged(own_ref: OutputReference) -> Output {
  Output {
    address: from_verification_key(#"00"),
    value: assets.from_lovelace(1),
    datum: InlineDatum(own_ref),
    reference_script: None,
  }
}

test settles_accepts_its_own_reference() {
  let own_ref = OutputReference { transaction_id: #"aa", output_index: 0 }
  settles(tagged(own_ref), own_ref)
}

test settles_rejects_a_different_output_index() {
  let a = OutputReference { transaction_id: #"aa", output_index: 0 }
  let b = OutputReference { transaction_id: #"aa", output_index: 1 }
  !settles(tagged(a), b)
}

test settles_rejects_a_different_transaction() {
  let a = OutputReference { transaction_id: #"aa", output_index: 0 }
  let b = OutputReference { transaction_id: #"bb", output_index: 0 }
  !settles(tagged(a), b)
}

test settles_rejects_an_untagged_output() {
  let own_ref = OutputReference { transaction_id: #"aa", output_index: 0 }
  let untagged =
    Output {
      address: from_verification_key(#"00"),
      value: assets.from_lovelace(1),
      datum: NoDatum,
      reference_script: None,
    }
  !settles(untagged, own_ref)
}
