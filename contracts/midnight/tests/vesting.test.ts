import { describe, expect, it } from 'vitest';
import { Contract, ledger, VestingState, type Witnesses } from '../compiled/vesting/contract/index.js';
import { deployForTest, fakeBytes32, nextContext, nextContextAtTime } from './helpers.js';

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
};

const TOKEN_ALLOCATION = 90_000_000n;
const VEST_DAYS = 90n;
const VEST_SECONDS = VEST_DAYS * 86_400n; // 7,776,000

// Phase 3 security fix (2026-07-12): startVesting/claimVested now bind their
// timestamp arguments to real chain time (blockTimeGte/blockTimeLte), so
// tests must pin the simulator's block time via nextContextAtTime instead
// of passing arbitrary small values like 0/1 — those would now fail the
// "timestamp too far in the past" check on startVesting, or (for
// claimVested) simply never have been reachable relative to a realistic
// vestStartTimestamp. NOW is an arbitrary but realistic epoch-seconds
// anchor, fixed here so every test in this file agrees on it.
const NOW = 1_780_000_000;

function deploy() {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    fakeBytes32(9),
    TOKEN_ALLOCATION,
    VEST_DAYS,
  );
  return { contract, init, contractAddress, ctx };
}

function deployAndStart(startAt: number = NOW) {
  const d = deploy();
  const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, startAt);
  const r = d.contract.circuits.startVesting(pinnedCtx, BigInt(startAt));
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx, startAt };
}

/** Calls claimVested with the simulator's block time pinned to `atTime`. */
function claimVestedAt(
  contract: Contract<PrivateState>,
  contractAddress: ReturnType<typeof deploy>['contractAddress'],
  ctx: ReturnType<typeof deploy>['ctx'],
  claimAmount: bigint,
  atTime: number,
) {
  const pinnedCtx = nextContextAtTime(contractAddress, ctx, atTime);
  return contract.circuits.claimVested(pinnedCtx, claimAmount, BigInt(atTime));
}

describe('vesting.compact — creator TOKEN vesting, separate from fee escrow (split regression)', () => {
  it('starts NotStarted and rejects claims before startVesting', () => {
    const { contract, ctx } = deploy();
    expect(ledger(ctx.currentQueryContext.state).vestingState).toBe(VestingState.NotStarted);
    expect(() => contract.circuits.claimVested(ctx, 1n, 1n)).toThrow('Vesting not active');
  });

  it('rejects claiming zero tokens before vesting has run at all (elapsed=0)', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    expect(() => claimVestedAt(contract, contractAddress, ctx, 1n, NOW)).toThrow(
      "Claimed amount doesn't match vested-to-date amount",
    );
  });

  it('allows claiming the exact vested amount at 25% elapsed', () => {
    // IMPORTANT: unlike a naive floating-point vesting calc, Compact's
    // Field type only supports EXACT equality (see bonding_curve's
    // "IMPORTANT FINDING" tests) — claimAmount * vestSeconds must exactly
    // equal tokenAllocation * elapsedSeconds. These numbers are chosen so
    // that resolves cleanly (90M * 1,944,000 / 7,776,000 = 22.5M exactly).
    const { contract, contractAddress, ctx } = deployAndStart();
    const quarterElapsed = VEST_SECONDS / 4n; // 1,944,000
    const expectedVested = TOKEN_ALLOCATION / 4n; // 22,500,000

    const result = claimVestedAt(contract, contractAddress, ctx, expectedVested, NOW + Number(quarterElapsed));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(expectedVested);
    expect(state.vestingState).toBe(VestingState.Vesting);
  });

  it('rejects claiming more than what is vested-to-date', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const quarterElapsed = VEST_SECONDS / 4n;
    const tooMuch = TOKEN_ALLOCATION / 4n + 1n; // 1 more than vested

    expect(() => claimVestedAt(contract, contractAddress, ctx, tooMuch, NOW + Number(quarterElapsed))).toThrow(
      "Claimed amount doesn't match vested-to-date amount",
    );
  });

  it('rejects a currentTimestamp claimed to be in the future relative to real chain time', () => {
    // Phase 3 fix regression: the block time is pinned to NOW (25% elapsed),
    // but the circuit is called claiming currentTimestamp is a full vesting
    // period ahead of that — must be rejected regardless of how the
    // cross-multiplication math would otherwise resolve.
    const { contract, contractAddress, ctx } = deployAndStart();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, NOW + Number(VEST_SECONDS / 4n));
    expect(() =>
      contract.circuits.claimVested(pinnedCtx, TOKEN_ALLOCATION, BigInt(NOW + Number(VEST_SECONDS))),
    ).toThrow('currentTimestamp cannot be in the future');
  });

  it('accumulates claims correctly across multiple calls as vesting progresses', () => {
    const { contract, contractAddress, ctx } = deployAndStart();

    const r1 = claimVestedAt(contract, contractAddress, ctx, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n));
    const ctx2 = nextContext(contractAddress, r1.context);

    // Second claim brings CUMULATIVE claimed to 45M (half), at the 50%
    // elapsed checkpoint — the circuit checks the running total against
    // vested-to-date, not the incremental claim amount in isolation.
    const r2 = claimVestedAt(contract, contractAddress, ctx2, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 2n));
    const state = ledger(r2.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(TOKEN_ALLOCATION / 2n);
  });

  it('fully claims at 100% elapsed and transitions to FullyClaimed', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const result = claimVestedAt(contract, contractAddress, ctx, TOKEN_ALLOCATION, NOW + Number(VEST_SECONDS));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.claimedTokens).toBe(TOKEN_ALLOCATION);
    expect(state.vestingState).toBe(VestingState.FullyClaimed);
  });

  it('rejects a claim from anyone but the creator', () => {
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
    });
    const { contractAddress, ctx } = deployAndStart();
    expect(() =>
      claimVestedAt(attacker, contractAddress, ctx, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n)),
    ).toThrow('Only creator can claim');
  });
});

describe('vesting.compact — startVesting anchor forgery (Phase 3 fix)', () => {
  // Real chain time pinned to NOW. Before the fix, a governor claiming
  // vesting started at epoch 0 would let the creator immediately claim the
  // full allocation via a since-real-time-massively-exceeds-vestSeconds
  // elapsed calculation — the far-in-the-past case below is that exploit.
  it.each([
    {
      label: 'far in the past (would inflate elapsed time)',
      timestamp: 0n,
      expectedError: 'startTimestamp too far in the past',
    },
    {
      label: 'in the future',
      timestamp: BigInt(NOW + Number(VEST_SECONDS)),
      expectedError: 'startTimestamp cannot be in the future',
    },
    {
      label: 'just outside the 1-hour tolerance window',
      timestamp: BigInt(NOW - 3601),
      expectedError: 'startTimestamp too far in the past',
    },
  ])('rejects a startTimestamp $label', ({ timestamp, expectedError }) => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    expect(() => d.contract.circuits.startVesting(pinnedCtx, timestamp)).toThrow(expectedError);
  });

  it.each([
    { label: 'exactly at real chain time', timestamp: BigInt(NOW) },
    // timestamp + 3600 >= NOW, i.e. timestamp >= NOW - 3600 — well within bounds
    { label: 'within the 1-hour tolerance window', timestamp: BigInt(NOW - 1800) },
  ])('accepts a startTimestamp $label', ({ timestamp }) => {
    const d = deploy();
    const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, NOW);
    const result = d.contract.circuits.startVesting(pinnedCtx, timestamp);
    expect(ledger(result.context.currentQueryContext.state).vestStartTimestamp).toBe(timestamp);
  });
});

describe('vesting.compact — CTO freeze', () => {
  it('triggerCTO freezes further claims', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(218), fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);

    const state = ledger(ctx2.currentQueryContext.state);
    expect(state.vestingState).toBe(VestingState.CTOFrozen);
    expect(state.ctoTriggered).toBe(true);

    expect(() =>
      claimVestedAt(contract, contractAddress, ctx2, TOKEN_ALLOCATION / 4n, NOW + Number(VEST_SECONDS / 4n)),
    ).toThrow('Vesting not active');
  });

  it('dissolveCTO resumes vesting from where it left off', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(219), fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    const rDissolve = contract.circuits.dissolveCTO(ctx2, fakeBytes32(226));
    const ctx3 = nextContext(contractAddress, rDissolve.context);

    expect(ledger(ctx3.currentQueryContext.state).vestingState).toBe(VestingState.Vesting);

    // Claiming works again post-dissolve
    const result = claimVestedAt(
      contract,
      contractAddress,
      ctx3,
      TOKEN_ALLOCATION / 4n,
      NOW + Number(VEST_SECONDS / 4n),
    );
    expect(ledger(result.context.currentQueryContext.state).claimedTokens).toBe(TOKEN_ALLOCATION / 4n);
  });

  it('rejects triggering CTO twice', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const r1 = contract.circuits.triggerCTO(ctx, fakeBytes32(220), fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.triggerCTO(ctx2, fakeBytes32(221), fakeBytes32(4))).toThrow('CTO already triggered');
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deployAndStart();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(222), fakeBytes32(0))).toThrow(
      'Community wallet address cannot be empty',
    );
  });

  it('rejects triggerCTO on a NEVER-STARTED schedule', () => {
    // Before the fix: triggerCTO only forbade FullyClaimed, so it could be
    // entered from NotStarted too. dissolveCTO then unconditionally set
    // vestingState = Vesting without ever setting vestStartTimestamp (still
    // 0, the constructor default) — letting the creator call claimVested
    // with currentTimestamp = vestDays*86400 and claim 100% of the
    // allocation in one call, on day one. This must now be rejected at
    // triggerCTO itself.
    const { contract, ctx } = deploy(); // startVesting never called
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(223), fakeBytes32(4))).toThrow(/actively in progress/i);
  });

  it('Fix (2026-07-21, Medium): rejects triggerCTO on a Cancelled schedule (same root cause, second path)', () => {
    const { contract, contractAddress, ctx } = deployAndStart();
    const rCancel = contract.circuits.cancelLaunch(ctx);
    const ctxCancelled = nextContext(contractAddress, rCancel.context);
    expect(() => contract.circuits.triggerCTO(ctxCancelled, fakeBytes32(224), fakeBytes32(4))).toThrow(
      /actively in progress/i,
    );
  });

  it('fix (2026-07-30): rejects dissolveCTO after cancelLaunch was called while CTOFrozen (resurrection bug)', () => {
    // Before the fix: cancelLaunch is callable from CTOFrozen (deliberately
    // permissive, see its own comment) and moved vestingState to Cancelled
    // but never cleared ctoTriggered. dissolveCTO checked only
    // ctoTriggered (still true), so it would still succeed and set
    // vestingState back to Vesting -- resurrecting a schedule the governor
    // had force-cancelled, reactivating the creator's ability to claim.
    const { contract, contractAddress, ctx } = deployAndStart();
    const rTrigger = contract.circuits.triggerCTO(ctx, fakeBytes32(225), fakeBytes32(4));
    const ctx2 = nextContext(contractAddress, rTrigger.context);
    expect(ledger(ctx2.currentQueryContext.state).vestingState).toBe(VestingState.CTOFrozen);

    const rCancel = contract.circuits.cancelLaunch(ctx2);
    const ctx3 = nextContext(contractAddress, rCancel.context);
    const stateAfterCancel = ledger(ctx3.currentQueryContext.state);
    expect(stateAfterCancel.vestingState).toBe(VestingState.Cancelled);
    // Also confirms the paired fix: cancelLaunch now clears ctoTriggered.
    expect(stateAfterCancel.ctoTriggered).toBe(false);

    expect(() => contract.circuits.dissolveCTO(ctx3, fakeBytes32(227))).toThrow('CTO not triggered');
  });
});

describe('vesting.compact — cancelLaunch authorization (GitHub #68 fix, 2026-07-14)', () => {
  it('succeeds with governor signature and transitions to Cancelled', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.cancelLaunch(ctx);
    expect(ledger(result.context.currentQueryContext.state).vestingState).toBe(VestingState.Cancelled);
  });

  it('rejects a caller without the governor signature', () => {
    const attacker = new Contract<PrivateState>({
      getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(3) }],
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
    });
    const { ctx } = deploy();
    expect(() => attacker.circuits.cancelLaunch(ctx)).toThrow('Only governor can cancel launch');
  });

  it('rejects cancelling an already-cancelled launch', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.cancelLaunch(ctx);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.cancelLaunch(ctx2)).toThrow('Already cancelled');
  });
});
