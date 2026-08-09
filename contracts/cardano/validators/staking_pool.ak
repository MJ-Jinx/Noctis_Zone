// ============================================================================
// Noctis Protocol — Staking Rewards Pool (2026-07-14)
// ============================================================================
// Optional per-launch feature, Tier A + B. A creator may allocate a fixed
// 25% of total supply into this pool at launch (contracts/cardano/
// validators/bonding_curve.ak and bonding_curve_tier_b.ak's `Graduate`
// redeemer seeds it, alongside LP, once graduated — see those files'
// `staking_seeding_output_ok` check).
//
// Two datum shapes share this one validator address, wrapped in the
// `StakingDatum` enum below:
//   - Pool(StakingPoolDatum): ONE per launch. Holds the depleting reward
//     token balance as real UTXO value (no separate on-chain balance
//     field — the value IS the balance, same discipline as
//     bonding_curve.ak's curve_token_balance_decreased). Tracks
//     who has claimed against the current reward_root as a fixed-size
//     bitmap (noctis/bitmap), one bit per staker in that root,
//     mirroring bonding_curve.ak's own per_address_purchases pattern —
//     an already-accepted tradeoff in this codebase for "many identities,
//     one shared ledger" tracking, not a new contention risk introduced
//     here.
//   - Position(StakingPositionDatum): one per staker per stake action.
//     Holds a staker's real staked tokens as UTXO value. Deliberately NOT
//     consolidated across multiple stakes by the same wallet — each stake
//     action creates its own fresh position UTXO (permissionless output
//     creation, no validator invocation needed for staking itself, same
//     as any deposit), avoiding both single-UTXO contention for the
//     frequent stake/unstake action AND any need to merge/reset bonding
//     periods across a wallet's multiple positions.
//
// Reward accounting is NOT computed on-chain. Compact has no in-circuit
// division and no reward-per-share pattern exists anywhere in this
// codebase (confirmed before designing this) — rather than invent new
// on-chain division workarounds, this reuses the exact trust model
// already shipped for cto_governance.compact's balance-snapshot tree and
// eligibility_gate.compact's DarkVeil allowlist tree: the governor
// computes each staker's cumulative accrued reward off-chain (from real,
// publicly observable stake/unstake events — independently
// re-derivable by anyone, not a hidden computation) and periodically
// publishes a Merkle root via `PublishRewardRoot`. A claim is a ZK-style
// proof of membership for the caller's own `(staker_vkh,
// cumulative_amount)` leaf — verified on-chain, no division anywhere.
// The bonding period (7 days before a new position earns anything) is
// enforced entirely by that same off-chain formula, using each
// position's real on-chain `stake_timestamp` — no separate on-chain
// check exists for it here.
//
// The on-chain contract's only real invariant is that cumulative claims
// never exceed the pool's real token balance — this is what makes a
// pool top-up need no rate-recalculation logic anywhere: there is no
// stored duration, end-timestamp, or emission-rate field on-chain at
// all. The "3-5 year runway" is an off-chain governor commitment,
// auditable via the published root sequence over time.
// ============================================================================

use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/primitive/bytearray
use cardano/address.{Address, from_verification_key, with_delegation_key}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Input, InlineDatum, Output, OutputReference, Transaction}
use noctis/bitmap
use noctis/settlement
use noctis/thread_nft

// ============================================================================
// TYPES
// ============================================================================

/// One step of a Merkle inclusion proof — same `(sibling, direction)` shape
/// already used by bonding_curve_tier_b.ak's DarkVeil allocation proofs.
pub type MerkleProofStep {
  sibling: ByteArray,
  goes_left: Bool,
}

/// One per launch. Its own UTXO value holds the real, depleting reward
/// token balance.
pub type StakingPoolDatum {
  launch_id: ByteArray,
  governor_pub_key_hash: VerificationKeyHash,
  creator_pub_key_hash: VerificationKeyHash,
  token_policy_id: PolicyId,
  token_asset_name: AssetName,
  // Governor-published Merkle root over (staker_vkh, cumulative_amount)
  // leaves — see file header. Updated only via PublishRewardRoot.
  reward_root: ByteArray,
  // Who has already claimed against `reward_root`, one bit each, sized when
  // that root was published and cleared with it. See noctis/bitmap: a
  // list-of-claimants grows forever and is compared by structural equality on
  // every spend, so a pool meant to run three to five years would eventually
  // become too expensive to spend at all — worst exactly when it has the most
  // stakers. The bitmap costs the same however many have claimed.
  //
  // A staker could already only claim once per root: the old check required
  // the cumulative amount to EXCEED what they had drawn, so a second claim
  // against an unchanged root paid nothing. The bit records the same fact in
  // a fixed number of bytes.
  claimed_bits: ByteArray,
  // 2026-08-03 audit: policy id of this launch's thread NFTs. The pool's
  // own UTXO must carry (thread_nft_policy, role_staking_pool ++
  // launch_id[..31]) on both the spent input and the continuing output —
  // see noctis/thread_nft. Position UTXOs deliberately carry no such
  // token: they are created per stake action, permissionlessly, and are
  // not singleton state.
  thread_nft_policy: PolicyId,
}

/// One per stake action. Its own UTXO value holds the staker's real
/// staked tokens.
pub type StakingPositionDatum {
  launch_id: ByteArray,
  staker_vkh: VerificationKeyHash,
  staked_amount: Int,
  // Posix seconds this position was created — read by the governor's
  // off-chain snapshot formula to apply the 7-day bonding period. Not
  // independently re-verified on-chain here (same trust boundary as the
  // rest of the off-chain reward computation).
  stake_timestamp: Int,
}

pub type StakingDatum {
  Pool(StakingPoolDatum)
  Position(StakingPositionDatum)
}

/// Redeemer actions. Staking itself (first stake, or an additional stake
/// by the same wallet) needs no redeemer at all — creating a new Position
/// output at this validator's address is permissionless, same as any
/// deposit; only spending an existing UTXO here needs validator approval.
pub type StakingPoolRedeemer {
  /// Full withdrawal of one position — staker-signed. No partial unstake;
  /// an additional stake or a partial exit is just a second position
  /// created/unstaked separately.
  Unstake
  /// Permissionless — same "the proof is the authorization" idiom as
  /// bonding_curve.ak's Graduate/ExpireCurve. A real Merkle proof of
  /// membership for (staker_vkh, claimed_cumulative_amount), plus a hard
  /// check that payout can only reach staker_vkh's own address, is the
  /// full authorization; nobody benefits from submitting someone else's
  /// claim since the funds can't be redirected.
  ClaimRewards {
    staker_vkh: VerificationKeyHash,
    /// What this leaf pays, not a running total. The governor derives it from
    /// the same public events it already derives accrual from, and a claim
    /// nobody made simply reappears in the next root.
    payout_amount: Int,
    /// This staker's bit in `claimed_bits`, hashed into their leaf so a proof
    /// pins them to one bit and cannot be aimed at somebody else's.
    leaf_index: Int,
    merkle_proof: List<MerkleProofStep>,
  }
  /// Creator-only. Adds `amount` of the reward token to the pool's own
  /// value. No rate recalculation anywhere — see file header.
  TopUpPool { amount: Int }
  /// Governor-only. Updates reward_root; the pool's own token value and
  /// its nullifier is replaced with a cleared one of the publisher's
  /// chosen size — this redeemer can publish a new
  /// snapshot but can never move funds.
  PublishRewardRoot { new_root: ByteArray, claimed_bits: ByteArray }
  /// Read-only query, no state change.
  QueryState
}

// ============================================================================
// HELPERS
// ============================================================================

/// Leaf hash for a reward claim: `blake2b_256(staker_vkh ||
/// cumulative_amount_16be)`. No salt — unlike bonding_curve_tier_b.ak's
/// DarkVeil allocation leaf, reward amounts carry no privacy requirement
/// here, so there's nothing a salt would need to protect against
/// brute-forcing.
pub fn hash_reward_leaf(
  staker_vkh: VerificationKeyHash,
  payout_amount: Int,
  leaf_index: Int,
) -> ByteArray {
  blake2b_256(
    bytearray.concat(
      bytearray.concat(
        staker_vkh,
        bytearray.from_int_big_endian(payout_amount, 16),
      ),
      bytearray.from_int_big_endian(leaf_index, 4),
    ),
  )
}

fn hash_reward_node(left: ByteArray, right: ByteArray) -> ByteArray {
  blake2b_256(bytearray.concat(left, right))
}

fn verify_reward_merkle_proof(
  root: ByteArray,
  leaf: ByteArray,
  proof: List<MerkleProofStep>,
) -> Bool {
  let computed =
    list.foldl(
      proof,
      leaf,
      fn(step, acc) {
        if step.goes_left {
          hash_reward_node(step.sibling, acc)
        } else {
          hash_reward_node(acc, step.sibling)
        }
      },
    )
  computed == root
}

/// Find this validator's own continuing output (same address as the input
/// being spent) and decode its inline datum — same pattern as
/// bonding_curve.ak's own_continuing_datum, generalized over the wrapping
/// StakingDatum enum.
fn own_continuing_datum(self: Transaction, own_ref: OutputReference) -> StakingDatum {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  expect Some(own_output) =
    list.find(self.outputs, fn(output) { output.address == own_address })
  expect InlineDatum(raw_datum) = own_output.datum
  expect new_datum: StakingDatum = raw_datum
  new_datum
}

/// Fix (2026-07-19, full-suite security audit): CRITICAL finding —
/// combining an Unstake (spending a Position) and a ClaimRewards (spending
/// the Pool) in the SAME transaction let a single output satisfy BOTH
/// checks at once, since Unstake's exact-match payment check and
/// ClaimRewards' >= threshold check both independently search
/// self.outputs by address alone, with no exclusivity between them.
/// Concretely: staking a real 500-token position plus a real pending
/// 100-token reward claim, a single 500-token output to the staker
/// satisfies Unstake's exact-match requirement AND (being >= 100)
/// ClaimRewards' threshold — letting the real 100-token reward be diverted
/// to a third party in the same transaction while the staker's own signed
/// Unstake half looks, from their perspective, like an ordinary unstake.
/// Requiring at most one input (and one output) at this shared address per
/// transaction closes this by construction — a staker can still unstake
/// multiple positions or claim rewards, just not combined with a DIFFERENT
/// staking_pool.ak UTXO in the same transaction. Same fix pattern already
/// applied to bonding_curve.ak/lp_escrow.ak/vesting.ak for the identical
/// shared-unparameterized-address root cause.
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

/// State authentication (2026-08-03 audit) — the pool's own thread NFT must
/// be present on the UTXO being spent AND on the continuing output. See
/// noctis/thread_nft, and bonding_curve.ak's thread_nft_intact, for the full
/// reasoning: this validator is unparameterized, so every launch's pool
/// shares one address and a pool UTXO's legitimacy would otherwise rest on a
/// datum anyone can author.
fn pool_thread_nft_intact(
  self: Transaction,
  own_ref: OutputReference,
  pool: StakingPoolDatum,
) -> Bool {
  expect Some(own_input) =
    list.find(self.inputs, fn(input) { input.output_reference == own_ref })
  let own_address = own_input.output.address
  let name =
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, pool.launch_id)
  when list.find(self.outputs, fn(output) { output.address == own_address }) is {
    None -> False
    Some(own_output) -> and {
        assets.quantity_of(own_input.output.value, pool.thread_nft_policy, name) == 1,
        assets.quantity_of(own_output.value, pool.thread_nft_policy, name) == 1,
      }
  }
}

// ============================================================================
// MAIN VALIDATOR
// ============================================================================

validator staking_pool {
  spend(
    datum_opt: Option<StakingDatum>,
    redeemer: StakingPoolRedeemer,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    and {
      single_own_utxo(self, own_input.output.address),
      // State authentication (2026-08-03 audit) — see pool_thread_nft_intact.
      // Gated on Pool rather than applied unconditionally: a Position is
      // created per stake action and is not singleton state, so requiring a
      // thread NFT on one would make staking impossible.
      when datum is {
        Pool(pool) -> pool_thread_nft_intact(self, own_ref, pool)
        Position(_) -> True
      },
      when (datum, redeemer) is {
      (Pool(pool), ClaimRewards { staker_vkh, payout_amount, leaf_index, merkle_proof }) -> {
        // Bound first and branched on, not merely ordered inside `and`: a
        // `let` is evaluated before the block that would have guarded it, and
        // both the leaf hash and set_bit abort on an index outside the map.
        let in_range = bitmap.index_in_range(pool.claimed_bits, leaf_index)
        let leaf =
          if in_range {
            hash_reward_leaf(staker_vkh, payout_amount, leaf_index)
          } else {
            #""
          }
        let next_bits =
          if in_range {
            bitmap.set_bit(pool.claimed_bits, leaf_index)
          } else {
            pool.claimed_bits
          }
        let payout = payout_amount

        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let pool_decreased_by_payout =
          assets.quantity_of(own_input.output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          ) + payout

        // Fix (2026-07-22): compare only the payment
        // credential, not the full address. `from_verification_key`
        // constructs a bare ENTERPRISE address (no stake credential) — the
        // same construction found in bonding_curve.ak and
        // bonding_curve_tier_b.ak, which silently required a payout
        // destination no real Cardano wallet uses by default. This file
        // wasn't in scope for either of those fix passes and had the
        // identical bug, undiscovered until now. See those entries in
        // internal tracking for the full reasoning — same fix here.
        let staker_credential = from_verification_key(staker_vkh).payment_credential
        let staker_paid =
          list.any(
            self.outputs,
            fn(output) {
              and {
                // The reward output NAMES this pool input. See
                // noctis/settlement: paying the staker enough is not on its
                // own evidence that THIS pool paid it, and a staker owed by
                // another contract too would otherwise be paid once and
                // credited twice.
                settlement.settles(output, own_ref),
                output.address.payment_credential == staker_credential,
                assets.quantity_of(
                  output.value,
                  pool.token_policy_id,
                  pool.token_asset_name,
                ) >= payout,
              }
            },
          )

        // ...and the staker is genuinely better off by it. The check above
        // asks whether an output at their credential holds the payout, which
        // their own CHANGE also does. This claim is permissionless, so the
        // transaction is built for the staker rather than by them; netting
        // their own inputs out is what stops a builder handing back tokens
        // the staker already had and sending the pool's payment elsewhere.
        // See noctis/settlement's net_asset_gain.
        let staker_gained =
          settlement.net_asset_gain(
            self,
            staker_credential,
            pool.token_policy_id,
            pool.token_asset_name,
          ) >= payout

        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          Pool(StakingPoolDatum { ..pool, claimed_bits: next_bits })

        and {
          payout_amount > 0,
          in_range,
          // One claim per staker per root. The bit is inside the leaf hash,
          // so a valid proof pins this claimer to this one bit.
          !bytearray.test_bit(pool.claimed_bits, leaf_index),
          verify_reward_merkle_proof(pool.reward_root, leaf, merkle_proof),
          pool_decreased_by_payout,
          staker_paid,
          staker_gained,
          new_datum == expected_datum,
          // ClaimRewards is permissionless — the pool's own
          // continuing output can't be padded with junk assets. See
          // bonding_curve.ak's output_value_clean for the full rationale
          // (found by comparing against MeshJS's open-source escrow.ak).
          // 3, not 2, since the thread NFT was added: lovelace + the
          // reward token + the pool thread NFT.
          list.length(assets.flatten(own_output.value)) <= 3,
        }
      }

      (Pool(pool), TopUpPool { amount }) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let pool_increased_by_amount =
          assets.quantity_of(own_output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_input.output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          ) + amount

        let new_datum = own_continuing_datum(self, own_ref)

        and {
          list.has(self.extra_signatories, pool.creator_pub_key_hash),
          amount > 0,
          pool_increased_by_amount,
          new_datum == Pool(pool),
          // Same cap as ClaimRewards — even a legitimate top-up
          // shouldn't be able to leave junk assets in the long-lived pool.
          // 3, not 2, since the thread NFT was added: lovelace + the
          // reward token + the pool thread NFT.
          list.length(assets.flatten(own_output.value)) <= 3,
        }
      }

      (Pool(pool), PublishRewardRoot { new_root, claimed_bits }) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })
        let own_address = own_input.output.address
        expect Some(own_output) =
          list.find(self.outputs, fn(output) { output.address == own_address })

        let value_unchanged =
          assets.quantity_of(own_output.value, pool.token_policy_id, pool.token_asset_name) == assets.quantity_of(
            own_input.output.value,
            pool.token_policy_id,
            pool.token_asset_name,
          )

        let new_datum = own_continuing_datum(self, own_ref)
        let expected_datum =
          Pool(
            StakingPoolDatum {
              ..pool,
              reward_root: new_root,
              claimed_bits: claimed_bits,
            },
          )

        and {
          list.has(self.extra_signatories, pool.governor_pub_key_hash),
          value_unchanged,
          // A new root is a new roster, so it brings its own nullifier, sized
          // for it. Publishing one is the only way to clear the map.
          bytearray.length(claimed_bits) > 0,
          // Every bit clear. Otherwise whoever publishes the root could burn
          // a staker's claim before they made it, by handing out a map with
          // their bit already set.
          claimed_bits == bitmap.cleared(bytearray.length(claimed_bits)),
          new_datum == expected_datum,
        }
      }

      (Position(pos), Unstake) -> {
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == own_ref })

        // No claim of "no continuing output at this address" is needed or
        // wanted here — other position UTXOs at this same script address
        // may legitimately be spent/created in the same transaction (e.g.
        // a different staker unstaking concurrently). This position's own
        // safety only depends on ITS specific value reaching the staker,
        // checked below — not on the address's total output count.
        // Fix (2026-07-22) — same payment-credential-only
        // comparison as ClaimRewards above; see that branch's comment.
        let staker_credential = from_verification_key(pos.staker_vkh).payment_credential
        // Position UTXOs carry a launch-token policy the pool datum
        // doesn't record locally — verify by comparing the full
        // non-lovelace value (in practice exactly the one launch token)
        // rather than needing a policy id here.
        let staker_paid =
          list.any(
            self.outputs,
            fn(output) {
              and {
                // Names THIS position. Two positions holding the same assets
                // — or a payout owed by another contract entirely — are
                // otherwise indistinguishable to this check.
                settlement.settles(output, own_ref),
                output.address.payment_credential == staker_credential,
                assets.without_lovelace(output.value) == assets.without_lovelace(
                  own_input.output.value,
                ),
              }
            },
          )

        and {
          list.has(self.extra_signatories, pos.staker_vkh),
          pos.staked_amount > 0,
          staker_paid,
        }
      }

      // CRITICAL fix (2026-07-19, full-suite security audit) — same
      // fix as bonding_curve.ak: was an unconditional `True` (zero checks),
      // an unconditional authorization over the pool's reward tokens or any
      // staker's locked position. See that file's own comment on this exact
      // line for the full explanation.
      (_, QueryState) -> False

      _ -> False
      },
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

/// State authentication (2026-08-03 audit) — the thread NFT this launch's
/// state UTXO must carry, matching the mock datum's launch_id (#"01") and
/// thread_nft_policy (#"c0ffee"). Derived through thread_asset_name rather
/// than hard-coded so a scheme change cannot leave these silently passing.
fn mock_pool_nft() -> assets.Value {
  assets.from_asset(
    #"c0ffee",
    thread_nft.thread_asset_name(thread_nft.role_staking_pool, #"01"),
    1,
  )
}


fn mock_pool_datum() -> StakingPoolDatum {
  StakingPoolDatum {
    launch_id: #"01",
    governor_pub_key_hash: #"22",
    creator_pub_key_hash: #"11",
    token_policy_id: #"33",
    token_asset_name: "tok",
    reward_root: #"",
    // Two bytes, so a fixture can address bits either side of a byte
    // boundary without needing its own map.
    claimed_bits: #"0000",
    thread_nft_policy: #"c0ffee",
  }
}

fn mock_position_datum() -> StakingPositionDatum {
  StakingPositionDatum {
    launch_id: #"01",
    staker_vkh: #"dd",
    staked_amount: 500,
    stake_timestamp: 1000,
  }
}

test hash_reward_leaf_is_deterministic() {
  hash_reward_leaf(#"dd", 100, 0) == hash_reward_leaf(#"dd", 100, 0)
}

test hash_reward_leaf_differs_by_amount() {
  hash_reward_leaf(#"dd", 100, 0) != hash_reward_leaf(#"dd", 101, 0)
}

test verify_reward_merkle_proof_accepts_single_leaf_tree() {
  let leaf = hash_reward_leaf(#"dd", 100, 0)
  verify_reward_merkle_proof(leaf, leaf, [])
}

test verify_reward_merkle_proof_accepts_real_proof_in_two_leaf_tree() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let proof1 = [MerkleProofStep { sibling: leaf0, goes_left: True }]
  and {
    verify_reward_merkle_proof(root, leaf0, proof0),
    verify_reward_merkle_proof(root, leaf1, proof1),
  }
}

test verify_reward_merkle_proof_rejects_tampered_sibling() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]
  !verify_reward_merkle_proof(root, leaf0, tampered_proof)
}

test claim_rewards_succeeds_with_valid_proof_and_real_payout() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900))),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test claim_rewards_rejects_padded_pool_output() {
  // Identical to claim_rewards_succeeds_with_valid_proof_and_real_payout,
  // except the pool's own continuing output carries one extra, unrelated
  // junk asset. ClaimRewards is permissionless, so ANYONE could otherwise
  // pad this long-lived pool UTXO this way before the fix.
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900))),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test claim_rewards_fails_with_tampered_proof() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let tampered_proof = [MerkleProofStep { sibling: #"ff", goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: tampered_proof },
    own_ref,
    self,
  )
}

/// A second claim on a bit that is already spent.
///
/// Built through run_claim so everything else about the transaction is exactly
/// what the happy path needs — the pool's thread NFT, a real decrease in its
/// balance, a real payout to the staker. The ONLY thing wrong is that the bit
/// was already set, so nothing else can be what refuses it.
///
/// It did not always read that way. The fixture this replaces carried no
/// thread NFT, left the pool balance untouched and paid nobody, so it was
/// refused three times over before the double-claim check was ever reached —
/// and the check it was named for could have been deleted without the test
/// noticing.
test claim_rewards_rejects_a_second_claim_on_the_same_bit() {
  let leaf = hash_reward_leaf(#"dd", 100, 0)
  let pool =
    StakingPoolDatum { ..mock_pool_datum(), reward_root: leaf, claimed_bits: #"8000" }
  !run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: [] },
    #"8000",
    100,
  )
}

// Regression test: proves ClaimRewards now accepts a
// payout to the staker's real BASE address (payment + stake credential),
// not just the narrow bare-enterprise-address shape from_verification_key
// alone produces. Before this fix, this exact test would have failed.
test claim_rewards_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_base_address = from_verification_key(#"dd") |> with_delegation_key(#"aa")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool =
    Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900))),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: staker_base_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }

  staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof0 },
    own_ref,
    self,
  )
}

test top_up_pool_succeeds_with_creator_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500))),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test top_up_pool_rejects_padded_output() {
  // Identical to top_up_pool_succeeds_with_creator_signature, except
  // the pool's own continuing output carries one extra, unrelated junk
  // asset — even a legitimate creator top-up shouldn't be able to leave
  // junk in the long-lived pool.
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500))),
        // Junk asset from an unrelated policy — the padding attack.
        assets.from_asset(#"deadbeef", "spam", 1),
      ),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"11"],
    }

  !staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test top_up_pool_fails_without_creator_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_500)),
      datum: InlineDatum(Pool(pool)),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
    }

  !staking_pool.spend(Some(Pool(pool)), TopUpPool { amount: 500 }, own_ref, self)
}

test publish_reward_root_succeeds_with_governor_signature() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, reward_root: #"aabb" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  staking_pool.spend(Some(Pool(pool)), PublishRewardRoot { new_root: #"aabb", claimed_bits: #"0000" }, own_ref, self)
}

/// State authentication (2026-08-03 audit): a pool UTXO that does not carry
/// the launch's thread NFT cannot be spent, however well-formed its datum.
/// Identical to publish_reward_root_succeeds_with_governor_signature above
/// except for the missing token.
test pool_spend_rejects_utxo_without_thread_nft() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let value =
    assets.merge(
      assets.from_lovelace(2_000_000),
      assets.from_asset(#"33", "tok", 1_000),
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: value,
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, reward_root: #"aabb" })
  let continuing_output =
    Output {
      address: own_address,
      value: value,
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    PublishRewardRoot { new_root: #"aabb", claimed_bits: #"0000" },
    own_ref,
    self,
  )
}

/// The other half of the same property, and the reason the check is gated on
/// Pool rather than applied to the whole validator: a Position carries no
/// thread NFT by design — it is created per stake action, permissionlessly —
/// so requiring one would make every unstake fail. This asserts the
/// requirement did NOT leak onto positions.
test position_spend_unaffected_by_thread_nft_requirement() {
  let position =
    StakingPositionDatum {
      launch_id: #"01",
      staker_vkh: #"dd",
      staked_amount: 500,
      stake_timestamp: 1000,
    }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        // No thread NFT anywhere — exactly as a real position looks.
        value: assets.from_asset(#"33", "tok", 500),
        datum: InlineDatum(Position(position)),
        reference_script: None,
      },
    }
  let staker_output =
    Output {
      address: staker_address,
      value: assets.from_asset(#"33", "tok", 500),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [staker_output],
      extra_signatories: [#"dd"],
    }

  staking_pool.spend(Some(Position(position)), Unstake, own_ref, self)
}

test publish_reward_root_fails_if_value_changes() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  // Attempted drain disguised as a root update: value decreased.
  let new_pool = Pool(StakingPoolDatum { ..pool, reward_root: #"aabb" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1)),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }

  !staking_pool.spend(Some(Pool(pool)), PublishRewardRoot { new_root: #"aabb", claimed_bits: #"0000" }, own_ref, self)
}

test unstake_succeeds_with_staker_signature_and_real_payout() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
      extra_signatories: [#"dd"],
    }

  staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

// Regression test: proves Unstake now accepts a payout to
// the staker's real BASE address, not just a bare enterprise address.
test unstake_succeeds_paying_a_real_base_address_not_just_enterprise() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_base_address = from_verification_key(#"dd") |> with_delegation_key(#"aa")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_base_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
      extra_signatories: [#"dd"],
    }

  staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

test unstake_fails_without_staker_signature() {
  let pos = mock_position_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let payout_output =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [payout_output],
    }

  !staking_pool.spend(Some(Position(pos)), Unstake, own_ref, self)
}

// QueryState previously authorized ANY spend unconditionally
// (`(_, QueryState) -> True`, zero checks) — a complete, unauthenticated
// drain of the pool's reward tokens. Proves the fix.
test query_state_rejects_unauthenticated_pool_drain_attempt() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let attacker_address = from_verification_key(#"ee")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 10_000),
        ),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let drain_output =
    Output {
      address: attacker_address,
      value: assets.merge(
        assets.from_lovelace(2_000_000),
        assets.from_asset(#"33", "tok", 10_000),
      ),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction { ..transaction.placeholder, inputs: [own_input], outputs: [drain_output] }

  !staking_pool.spend(Some(Pool(pool)), QueryState, own_ref, self)
}

// Regression test: the value-conservation case verified against the full
// security audit — combining Unstake (Position, 500 tok, staker-signed)
// and ClaimRewards (Pool, 100 tok pending, permissionless) in ONE
// transaction, with a single 500-tok output to the staker attempting to
// satisfy BOTH checks at once (Unstake's exact-match AND ClaimRewards'
// >=100 threshold), while the real 100-tok reward is diverted to a third
// party. Proves this is now rejected — two inputs at the shared
// staking_pool.ak address in one transaction violates single_own_utxo.
test claim_rewards_rejects_combined_with_unstake_same_tx() {
  let pos = mock_position_datum()
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]
  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ee")

  let position_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let position_input =
    Input {
      output_reference: position_ref,
      output: Output {
        // A delegation key here makes this Position's full Address differ
        // from the Pool's while the script is identical — the two must still
        // count as one another's company.
        address: own_address |> with_delegation_key(#"de1e"),
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
        datum: InlineDatum(Position(pos)),
        reference_script: None,
      },
    }
  let pool_ref = OutputReference { transaction_id: #"00", output_index: 1 }
  let pool_input =
    Input {
      output_reference: pool_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let pool_continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900))),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  // Only the staker's own 500-tok unstake payout — no separate output for
  // the 100-tok reward at all. The real reward goes to the attacker.
  let combined_payout =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 500)),
      // Tagged as settling the pool, so the settlement check ACCEPTS this
      // output and cannot be what rejects the transaction. What rejects it
      // is single_own_utxo, which is the check this test is named for.
      datum: InlineDatum(pool_ref),
      reference_script: None,
    }
  let diverted_reward =
    Output {
      address: attacker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [position_input, pool_input],
      outputs: [pool_continuing_output, combined_payout, diverted_reward],
      extra_signatories: [#"dd"],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof0 },
    pool_ref,
    self,
  )
}

// ---------------------------------------------------------------------------
// The nullifier. One claim per staker per root, in a fixed number of bytes
// however many stakers there are.
// ---------------------------------------------------------------------------

/// A pool whose root is a two-leaf tree: `#"dd"` at index 0 for 100, `#"ee"`
/// at index 1 for 50. Returns the pool plus `#"dd"`'s proof.
fn claim_fixture() -> (StakingPoolDatum, List<MerkleProofStep>) {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  (
    StakingPoolDatum { ..mock_pool_datum(), reward_root: root },
    [MerkleProofStep { sibling: leaf1, goes_left: False }],
  )
}

/// A whole claim transaction, with everything the happy path needs, so that a
/// rejection can only come from the redeemer fields under test.
fn run_claim(
  pool: StakingPoolDatum,
  redeemer: StakingPoolRedeemer,
  next_bits: ByteArray,
  payout: Int,
) -> Bool {
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(
          mock_pool_nft(),
          assets.merge(
            assets.from_lovelace(2_000_000),
            assets.from_asset(#"33", "tok", 1_000),
          ),
        ),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(
        mock_pool_nft(),
        assets.merge(
          assets.from_lovelace(2_000_000),
          assets.from_asset(#"33", "tok", 1_000 - payout),
        ),
      ),
      datum: InlineDatum(Pool(StakingPoolDatum { ..pool, claimed_bits: next_bits })),
      reference_script: None,
    }
  let payout_output =
    Output {
      address: from_verification_key(#"dd"),
      value: assets.from_asset(#"33", "tok", payout),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output, payout_output],
    }
  staking_pool.spend(Some(Pool(pool)), redeemer, own_ref, self)
}

/// The control for every rejection below: this exact shape is accepted.
test claim_rewards_accepts_the_shape_the_rejections_vary() {
  let (pool, proof) = claim_fixture()
  run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof },
    #"8000",
    100,
  )
}

test claim_rewards_rejects_an_index_past_the_end_of_the_map() {
  let (pool, proof) = claim_fixture()
  // mock_pool_datum's map is two bytes, so bit 16 does not exist.
  !run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 16, merkle_proof: proof },
    #"8000",
    100,
  )
}

test claim_rewards_rejects_a_negative_index() {
  let (pool, proof) = claim_fixture()
  !run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: -1, merkle_proof: proof },
    #"8000",
    100,
  )
}

/// The index is inside the leaf hash, so a proof issued for one bit does not
/// verify when presented against another. Without that, a staker could spend
/// somebody else's bit and leave their own free to claim again.
test claim_rewards_rejects_a_proof_aimed_at_another_bit() {
  let (pool, proof) = claim_fixture()
  !run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 1, merkle_proof: proof },
    #"4000",
    100,
  )
}

test claim_rewards_rejects_a_zero_payout() {
  let leaf = hash_reward_leaf(#"dd", 0, 0)
  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: leaf }
  !run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 0, leaf_index: 0, merkle_proof: [] },
    #"8000",
    0,
  )
}

/// Bit 8 is the high bit of the second byte — the boundary a byte-indexed map
/// is most likely to get wrong.
test claim_rewards_sets_a_bit_in_the_second_byte() {
  let leaf = hash_reward_leaf(#"dd", 100, 8)
  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: leaf }
  run_claim(
    pool,
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 8, merkle_proof: [] },
    #"0080",
    100,
  )
}

/// A new root is a new roster, and it must arrive with nobody's claim already
/// spent — otherwise whoever publishes it could burn a staker's entitlement
/// before that staker ever made a claim.
test publish_reward_root_rejects_a_pre_set_bit() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let value =
    assets.merge(
      mock_pool_nft(),
      assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: value,
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: value,
      datum: InlineDatum(
        Pool(StakingPoolDatum { ..pool, reward_root: #"aabb", claimed_bits: #"8000" }),
      ),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }
  !staking_pool.spend(
    Some(Pool(pool)),
    PublishRewardRoot { new_root: #"aabb", claimed_bits: #"8000" },
    own_ref,
    self,
  )
}

/// A root published with no map is a root nobody could claim against.
test publish_reward_root_rejects_an_empty_nullifier() {
  let pool = mock_pool_datum()
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let value =
    assets.merge(
      mock_pool_nft(),
      assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: value,
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: value,
      datum: InlineDatum(
        Pool(StakingPoolDatum { ..pool, reward_root: #"aabb", claimed_bits: #"" }),
      ),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }
  !staking_pool.spend(
    Some(Pool(pool)),
    PublishRewardRoot { new_root: #"aabb", claimed_bits: #"" },
    own_ref,
    self,
  )
}

/// Publishing a root is how the map is cleared, so a staker who has claimed
/// under one root can claim again under the next.
test publish_reward_root_clears_a_used_nullifier() {
  let pool = StakingPoolDatum { ..mock_pool_datum(), claimed_bits: #"8000" }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let value =
    assets.merge(
      mock_pool_nft(),
      assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000)),
    )
  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: value,
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  let continuing_output =
    Output {
      address: own_address,
      value: value,
      datum: InlineDatum(
        Pool(StakingPoolDatum { ..pool, reward_root: #"aabb", claimed_bits: #"0000" }),
      ),
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input],
      outputs: [continuing_output],
      extra_signatories: [#"22"],
    }
  staking_pool.spend(
    Some(Pool(pool)),
    PublishRewardRoot { new_root: #"aabb", claimed_bits: #"0000" },
    own_ref,
    self,
  )
}

/// The staker is paid nothing, and the reward leaves for someone else.
///
/// ClaimRewards is permissionless, so the claim transaction is built for the
/// staker rather than by them. A builder who can get the staker's signature —
/// the platform's own frontend, or anything that replaces it — can spend a
/// UTXO the staker already holds, hand those same tokens straight back as
/// change, and route the pool's actual payout elsewhere. The pool decreases
/// by the payout, an output at the staker's own credential carries at least
/// the payout, and the leaf is marked claimed, so the claim cannot be
/// repeated. Every balance in the transaction is honest; the staker is simply
/// not the one who ends up better off.
test claim_rewards_rejects_paying_the_staker_with_their_own_tokens() {
  let leaf0 = hash_reward_leaf(#"dd", 100, 0)
  let leaf1 = hash_reward_leaf(#"ee", 50, 1)
  let root = hash_reward_node(leaf0, leaf1)
  let proof0 = [MerkleProofStep { sibling: leaf1, goes_left: False }]

  let pool = StakingPoolDatum { ..mock_pool_datum(), reward_root: root }
  let own_ref = OutputReference { transaction_id: #"00", output_index: 0 }
  let own_address = from_verification_key(#"cc")
  let staker_address = from_verification_key(#"dd")
  let attacker_address = from_verification_key(#"ba")

  let own_input =
    Input {
      output_reference: own_ref,
      output: Output {
        address: own_address,
        value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 1_000))),
        datum: InlineDatum(Pool(pool)),
        reference_script: None,
      },
    }
  // The staker's own tokens, spent in the same transaction.
  let staker_input =
    Input {
      output_reference: OutputReference { transaction_id: #"77", output_index: 0 },
      output: Output {
        address: staker_address,
        value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 100)),
        datum: transaction.NoDatum,
        reference_script: None,
      },
    }
  let new_pool = Pool(StakingPoolDatum { ..pool, claimed_bits: #"8000" })
  let continuing_output =
    Output {
      address: own_address,
      value: assets.merge(mock_pool_nft(), assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 900))),
      datum: InlineDatum(new_pool),
      reference_script: None,
    }
  // Change: the staker's own 100 tokens, returned to the staker, tagged as
  // though the pool had settled them.
  let staker_change =
    Output {
      address: staker_address,
      value: assets.merge(assets.from_lovelace(2_000_000), assets.from_asset(#"33", "tok", 100)),
      datum: InlineDatum(own_ref),
      reference_script: None,
    }
  // The pool's real payout, going somewhere else entirely.
  let attacker_output =
    Output {
      address: attacker_address,
      value: assets.from_asset(#"33", "tok", 100),
      datum: transaction.NoDatum,
      reference_script: None,
    }
  let self =
    Transaction {
      ..transaction.placeholder,
      inputs: [own_input, staker_input],
      outputs: [continuing_output, staker_change, attacker_output],
    }

  !staking_pool.spend(
    Some(Pool(pool)),
    ClaimRewards { staker_vkh: #"dd", payout_amount: 100, leaf_index: 0, merkle_proof: proof0 },
    own_ref,
    self,
  )
}
