// Proves this package's off-chain hash helpers produce byte-identical
// output to the real compiled Compact circuits, by driving the actual
// contracts (not reimplementations) through @midnight-ntwrk/compact-runtime
// and cross-checking against circuits that accept externally-supplied
// derived keys. This is the same verification method used by
// contracts/midnight/tests/ — see that package's tests for prerequisites
// (this test imports its ../../contracts/midnight compiled fixtures and
// its shared test helpers directly, no duplication).
import { describe, expect, it } from 'vitest';
import {
  Contract as CtoGovernanceContract,
  type Witnesses as CtoGovernanceWitnesses,
  ledger as ctoGovernanceLedger,
  ProposalType,
} from '../../../contracts/midnight/compiled/cto_governance/contract/index.js';
import {
  Contract as EligibilityGateContract,
  type Witnesses as EligibilityGateWitnesses,
  ledger as eligibilityGateLedger,
  LaunchPhase,
} from '../../../contracts/midnight/compiled/eligibility_gate/contract/index.js';
import {
  deployForTest,
  fakeBytes32,
  nextContext,
  nextContextAtTime,
} from '../../../contracts/midnight/tests/helpers.js';
import * as ctoGovernance from '../src/cto-governance.js';
import * as eligibilityGate from '../src/eligibility-gate.js';

type PrivateState = undefined;

describe('eligibility-gate.ts — parity with the compiled circuit', () => {
  it('deriveUserPublicKey matches the key registerForDarkVeil derives and locks the bond under', () => {
    const sk = fakeBytes32(3);
    const myKey = eligibilityGate.deriveUserPublicKey(sk);
    // Design requirement: the leaf is no longer a free witness —
    // it must be hashAllowlistLeaf(myKey), matching what verifyAllowlist
    // now derives in-circuit from the caller's own identity.
    const leaf = eligibilityGate.hashAllowlistLeaf(myKey);
    const tree = eligibilityGate.buildAllowlistTree([leaf]);
    // Phase 2 security-audit fix (2026-07-11): darkveil.compact merged
    // into eligibility_gate.compact — getBuyNonce is now part of this
    // contract's own witness set. Fix (2026-07-30):
    // getRegistrantMerkleProof is a required witness (verifyRegistrant,
    // called from submitBuyCommit) but is never invoked by
    // registerForDarkVeil, the only circuit this test exercises — an
    // empty proof is safe here since it's never read. Fix
    // (2026-07-30): getRegistrationNonce was removed as a dead witness.
    const witnesses: EligibilityGateWitnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: sk }],
      getMerkleProof: (_ctx) => [undefined, tree.getProof(0)],
      getRegistrantMerkleProof: (_ctx) => [undefined, []],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBuyNonce: (_ctx) => [undefined, fakeBytes32(7)],
    };
    const contract = new EligibilityGateContract<PrivateState>(witnesses);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      fakeBytes32(9), // launchId
      tree.root, // allowlistRoot
      1_000_000_000n, // totalSupply
      5n, // maxWalletPercent
      1000n, // bondAmount
      50_000_000n, // walletCap
      500n, // dvAllocation — not exercised by this test
      90n, // dvPrice
      1n, // allowlistSize
      1_000_000n, // registrationCloseTime
      1n, // minDvParticipants — permissive, this test doesn't exercise the floor
      fakeBytes32(88), // creatorPubKey — distinct from myKey so this registrant isn't rejected as the creator
      fakeBytes32(60), // platformAddr — one wallet, no treasury/ops split
    );
    const rPhase = contract.circuits.advancePhase(ctx, LaunchPhase.DarkVeil);
    const ctx1 = nextContext(contractAddress, rPhase.context);
    // dvState must be Registration before registerForDarkVeil is callable.
    const rStart = contract.circuits.startRegistration(ctx1);
    const ctx2 = nextContext(contractAddress, rStart.context);
    const rRegister = contract.circuits.registerForDarkVeil(ctx2, fakeBytes32(7));

    // The contract's own `caller.bytes` (its internal deriveUserPublicKey(sk))
    // is the key it locked the bond under — read it back via the ledger and
    // compare against this package's independently computed key.
    const state = eligibilityGateLedger(rRegister.context.currentQueryContext.state);
    expect(state.lockedBonds.member(myKey)).toBe(true);
    expect(state.lockedBonds.lookup(myKey)).toBe(1000n);
  });
});

describe('cto-governance.ts — parity with the compiled circuit', () => {
  it('deriveUserPublicKey + computeVoteNullifier match what castVote derives and hasVoted checks', () => {
    const sk = fakeBytes32(11);
    const myVoterKey = ctoGovernance.deriveUserPublicKey(sk);
    const voteWeight = 1000n;

    // Design requirement: castVote now requires a real
    // Merkle-proven balance instead of a caller-supplied voteWeight — build
    // a one-leaf snapshot tree for this voter's real derived identity.
    // heldSinceTimestamp 0n (anti-whale-takeover fix, 2026-07-28) is well
    // before this test's proposal.startTimestamp (SILENCE_THRESHOLD, 90
    // days), clearing minHoldingPeriod (30 days) with margin.
    const heldSince = 0n;
    const tree = ctoGovernance.buildBalanceSnapshotTree([
      { voterKey: myVoterKey, balance: voteWeight, heldSinceTimestamp: heldSince },
    ]);

    const witnesses: CtoGovernanceWitnesses<PrivateState> = {
      getUserSecret: (_ctx) => [undefined, { bytes: sk }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
      getBalanceLeafAmount: (_ctx) => [undefined, voteWeight],
      getBalanceLeafHeldSince: (_ctx) => [undefined, heldSince],
      getBalanceProof: (_ctx) => [undefined, tree.getProof(0)],
    };
    const contract = new CtoGovernanceContract<PrivateState>(witnesses);
    const launchId = fakeBytes32(9);
    const { contractAddress, ctx } = deployForTest(
      contract,
      undefined,
      launchId,
      1_000_000_000n, // totalSupply
      0n, // graduationTimestamp
      20_000_000n, // maxVoterCap (2% of totalSupply, precomputed off-chain — unified across all voters since the anti-whale-takeover fix)
      1n, // minVoterCount — permissive, this test isn't exercising that safeguard
      fakeBytes32(88), // creatorPubKey — distinct from myVoterKey
      true, // hasClaimableBalance
      1_000_000n, // breakGlassBondMin
      fakeBytes32(200), // platformAddr — one wallet, no treasury/ops split
    );

    const SILENCE_THRESHOLD = 7_776_000n;
    // Fix (2026-07-21): every currentTimestamp-taking circuit now
    // binds it to real chain time — pin the simulator's block time to match
    // each call's claimed currentTimestamp, same pattern
    // contracts/midnight/tests/cto_governance.test.ts already established.
    // Published right before proposal creation — stale-snapshot fix
    // (2026-07-19) rejects a snapshot published long before the proposal
    // that relies on it (max 30 days old).
    const pinnedSnapshotCtx = nextContextAtTime(contractAddress, ctx, Number(SILENCE_THRESHOLD));
    const rSnapshot = contract.circuits.updateBalanceSnapshot(pinnedSnapshotCtx, tree.root, SILENCE_THRESHOLD);
    const ctxSnapshot = nextContext(contractAddress, rSnapshot.context);
    const pinnedCreateCtx = nextContextAtTime(contractAddress, ctxSnapshot, Number(SILENCE_THRESHOLD));
    const rCreate = contract.circuits.createProposal(
      pinnedCreateCtx,
      ProposalType.SilenceLockTrigger,
      fakeBytes32(40),
      SILENCE_THRESHOLD,
      fakeBytes32(0),
      0n,
      fakeBytes32(0),
      fakeBytes32(90), // proposedCommunityWallet — must be non-empty even though SilenceLockTrigger doesn't use its value
      1_000_000n, // bondAmount — filing takes a real bond, at the breakGlassBondMin floor deployed above
    );
    const proposalId = rCreate.result as Uint8Array;
    const ctx2 = nextContext(contractAddress, rCreate.context);
    const voteTime = SILENCE_THRESHOLD + 1n;
    const pinnedVoteCtx = nextContextAtTime(contractAddress, ctx2, Number(voteTime));
    const rVote = contract.circuits.castVote(pinnedVoteCtx, proposalId, true, voteTime);
    const ctx3 = nextContext(contractAddress, rVote.context);

    // hasCallerVoted recomputes the nullifier from the caller's own secret and
    // checks Set membership. True here means the contract agrees this voter
    // voted.
    const rHasVoted = contract.circuits.hasCallerVoted(ctx3, proposalId);
    expect(rHasVoted.result).toBe(true);

    // The real parity check: the value this package computes must be the exact
    // 32 bytes castVote wrote into the ledger. Asserting only the type and
    // length of it — as this did — would still pass if the two constructions
    // had drifted completely apart.
    const myNullifier = ctoGovernance.computeVoteNullifier({ voterSecret: sk, launchId, proposalId });
    expect(ctoGovernanceLedger(ctx3.currentQueryContext.state).voteNullifiers.member(myNullifier)).toBe(true);

    // And a nullifier built from the PUBLIC key — what anyone watching could
    // precompute — must not be what got written.
    expect(
      ctoGovernanceLedger(ctx3.currentQueryContext.state).voteNullifiers.member(
        ctoGovernance.computeVoteNullifier({ voterSecret: myVoterKey, launchId, proposalId }),
      ),
    ).toBe(false);
  });
});
