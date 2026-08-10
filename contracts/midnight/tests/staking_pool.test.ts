import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRewardTree,
  buildStakeSnapshotTree,
  deriveCreatorKey,
  deriveUserPublicKey,
  type MerkleProofEntry,
} from '../../../packages/zk-proofs/src/staking-pool.js';
import { Contract, type Ledger, ledger, type Witnesses } from '../compiled/staking_pool/contract/index.js';
import { deployForTest, fakeBytes32, type LedgerSink, nextContext, nextContextAtTime, trackLedger } from './helpers.js';

type PrivateState = undefined;

const EMPTY_PROOF: MerkleProofEntry[] = [];

const GOVERNOR_FILL = 2;
const CREATOR_FILL = 3;
// creatorKey is a raw pass-through in the constructor (disclose(creatorPubKey_))
// — the deployer computes deriveCreatorKey(realSecret) off-chain and supplies
// the resulting public key directly, same convention as
// cto_governance.compact's creatorPubKey_ constructor argument.
// The launch every contract in this file is deployed with. Identity is scoped
// per launch, so a key derived under any other value matches nothing on-chain.
const LAUNCH_ID = fakeBytes32(9);

const CREATOR_PUBKEY = deriveCreatorKey(fakeBytes32(CREATOR_FILL));

function makeWitnesses(
  userFill: number,
  opts: {
    governorFill?: number;
    creatorFill?: number;
    stakeLeafAmount?: bigint;
    stakeProof?: MerkleProofEntry[];
    rewardLeafAmount?: bigint;
    rewardProof?: MerkleProofEntry[];
  } = {},
): Witnesses<PrivateState> {
  return {
    getUserSecret: (_ctx) => [undefined, { bytes: fakeBytes32(userFill) }],
    getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(opts.governorFill ?? GOVERNOR_FILL) }],
    getCreatorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(opts.creatorFill ?? CREATOR_FILL) }],
    getStakeLeafAmount: (_ctx) => [undefined, opts.stakeLeafAmount ?? 0n],
    getStakeProof: (_ctx) => [undefined, opts.stakeProof ?? EMPTY_PROOF],
    getRewardLeafAmount: (_ctx) => [undefined, opts.rewardLeafAmount ?? 0n],
    getRewardProof: (_ctx) => [undefined, opts.rewardProof ?? EMPTY_PROOF],
  };
}

// One platform wallet, replacing the treasury/ops pair.
const PLATFORM_ADDR = fakeBytes32(50);
const INITIAL_CLAIM_FEE = 5_000_000n; // arbitrary NIGHT atomic-unit stand-in for "$1"
// Fix (2026-07-30): maxPoolBudget = totalSupply * STAKING_ALLOC_PCT / 100,
// computed off-chain. 1B-supply launch at 25% = 250,000,000 — comfortably
// above every topUpPool amount used anywhere in this file.
const MAX_POOL_BUDGET = 250_000_000n;

// CLAUDE.md: STAKING_DURATION_MIN_DAYS 1095 to STAKING_DURATION_MAX_DAYS
// 1825, creator-selected. Three years here.
const RUNWAY_SECONDS = 1095n * 86_400n; // 94,608,000
// A realistic epoch-seconds anchor the whole file agrees on, matching the
// convention in vesting.test.ts — the runway clock binds to real chain time.
const NOW = 1_780_000_000;

function deploy() {
  const witnesses = makeWitnesses(99); // caller identity irrelevant for constructor
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(
    contract,
    undefined,
    LAUNCH_ID,
    CREATOR_PUBKEY,
    PLATFORM_ADDR,
    INITIAL_CLAIM_FEE,
    MAX_POOL_BUDGET,
    RUNWAY_SECONDS,
  );
  return { contract, init, contractAddress, ctx };
}

/** Publishes a stake-snapshot root containing exactly the given (fill, stakedAmount) pairs. */
function publishStakeSnapshot(d: ReturnType<typeof deploy>, entries: Array<{ fill: number; stakedAmount: bigint }>) {
  const keyed = entries.map((e) => ({
    fill: e.fill,
    stakerKey: deriveUserPublicKey(fakeBytes32(e.fill), LAUNCH_ID),
    stakedAmount: e.stakedAmount,
  }));
  const tree = buildStakeSnapshotTree(keyed.map(({ stakerKey, stakedAmount }) => ({ stakerKey, stakedAmount })));

  const r = d.contract.circuits.publishStakeSnapshot(d.ctx, tree.root);
  const ctx = nextContext(d.contractAddress, r.context);

  function stakeArgsFor(fill: number) {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishStakeSnapshot: fill ${fill} not in this snapshot`);
    return { stakeLeafAmount: keyed[idx].stakedAmount, stakeProof: tree.getProof(idx) };
  }

  return { ctx, stakeArgsFor, root: tree.root };
}

/** Publishes a reward root containing exactly the given (fill, cumulativeAmount) pairs. */
function publishRewardRoot(
  d: {
    contract: ReturnType<typeof deploy>['contract'];
    contractAddress: ReturnType<typeof deploy>['contractAddress'];
    ctx: ReturnType<typeof deploy>['ctx'];
  },
  entries: Array<{ fill: number; cumulativeAmount: bigint }>,
) {
  const keyed = entries.map((e) => ({
    fill: e.fill,
    stakerKey: deriveUserPublicKey(fakeBytes32(e.fill), LAUNCH_ID),
    cumulativeAmount: e.cumulativeAmount,
  }));
  const tree = buildRewardTree(keyed.map(({ stakerKey, cumulativeAmount }) => ({ stakerKey, cumulativeAmount })));

  const r = d.contract.circuits.publishRewardRoot(d.ctx, tree.root);
  const ctx = nextContext(d.contractAddress, r.context);

  function rewardArgsFor(fill: number) {
    const idx = keyed.findIndex((e) => e.fill === fill);
    if (idx === -1) throw new Error(`publishRewardRoot: fill ${fill} not in this snapshot`);
    return { rewardLeafAmount: keyed[idx].cumulativeAmount, rewardProof: tree.getProof(idx) };
  }

  return { ctx, rewardArgsFor, root: tree.root };
}

describe('staking_pool.compact — deploy', () => {
  it('starts with zero pool balance and empty roots', () => {
    const { ctx } = deploy();
    const state = ledger(ctx.currentQueryContext.state);
    expect(state.poolBalance).toBe(0n);
    expect(state.claimFeeNightAmount).toBe(INITIAL_CLAIM_FEE);
  });
});

describe('staking_pool.compact — topUpPool', () => {
  // Real conservation invariant (this fix, not a trivially-true
  // assertion): totalToppedUp is the lifetime mint-authorization counter,
  // and it must never exceed the tokenomics-fixed 25%-of-supply budget —
  // a regression here would mean topUpPool's ceiling check silently
  // stopped enforcing the one real safeguard against unlimited reward
  // minting. poolBalance can't exceed totalToppedUp either (it's only
  // ever funded BY top-ups).
  const lastLedger: LedgerSink<Ledger> = {};
  afterEach(() => {
    if (lastLedger.current) {
      const s = lastLedger.current;
      expect(s.totalToppedUp).toBeLessThanOrEqual(MAX_POOL_BUDGET);
      expect(s.poolBalance).toBeLessThanOrEqual(s.totalToppedUp);
    }
    lastLedger.current = undefined;
  });

  it('succeeds with creator signature and increases poolBalance', () => {
    const { contract, ctx } = deploy();
    const r = contract.circuits.topUpPool(ctx, 1_000_000n);
    expect(trackLedger(lastLedger, ledger(r.context.currentQueryContext.state)).poolBalance).toBe(1_000_000n);
  });

  it('accumulates across multiple top-ups', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.topUpPool(ctx, 1_000_000n);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.topUpPool(ctx2, 500_000n);
    expect(trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state)).poolBalance).toBe(1_500_000n);
  });

  it('fails without creator signature', () => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { creatorFill: 66 }));
    expect(() => attacker.circuits.topUpPool(ctx, 1_000_000n)).toThrow('Only creator can top up the pool');
  });

  it('fails with a zero amount', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.topUpPool(ctx, 0n)).toThrow('Top-up amount must be positive');
  });

  it('fix (2026-07-30): rejects a top-up that would exceed maxPoolBudget', () => {
    // Before the fix, topUpPool had no ceiling at all — creator + governor
    // together could mint unlimited real reward coins, with the
    // tokenomics' 25%-of-supply cap enforced nowhere on-chain.
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.topUpPool(ctx, MAX_POOL_BUDGET + 1n)).toThrow(/authorized budget/i);
  });

  it('fix (2026-07-30): allows a top-up exactly at maxPoolBudget, then rejects any further top-up', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.topUpPool(ctx, MAX_POOL_BUDGET);
    const state = trackLedger(lastLedger, ledger(r1.context.currentQueryContext.state));
    expect(state.poolBalance).toBe(MAX_POOL_BUDGET);
    expect(state.totalToppedUp).toBe(MAX_POOL_BUDGET);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.topUpPool(ctx2, 1n)).toThrow(/authorized budget/i);
  });
});

describe('staking_pool.compact — publishStakeSnapshot / publishRewardRoot / updateClaimFee', () => {
  it('publishStakeSnapshot succeeds with governor signature', () => {
    const d = deploy();
    const { ctx } = publishStakeSnapshot(d, [{ fill: 10, stakedAmount: 1_000n }]);
    expect(ledger(ctx.currentQueryContext.state).stakeSnapshotRoot).toBeDefined();
  });

  it('publishRewardRoot succeeds with governor signature', () => {
    const d = deploy();
    const { ctx } = publishRewardRoot(d, [{ fill: 10, cumulativeAmount: 500n }]);
    expect(ledger(ctx.currentQueryContext.state).rewardRoot).toBeDefined();
  });

  it('updateClaimFee succeeds with governor signature', () => {
    const { contract, ctx } = deploy();
    const r = contract.circuits.updateClaimFee(ctx, 6_000_000n);
    expect(ledger(r.context.currentQueryContext.state).claimFeeNightAmount).toBe(6_000_000n);
  });

  it.each([
    {
      label: 'publishStakeSnapshot',
      call: (c: Contract<PrivateState>, ctx: CircuitContext<PrivateState>) =>
        c.circuits.publishStakeSnapshot(ctx, fakeBytes32(7)),
      expectedError: 'Only governor can publish stake snapshot',
    },
    {
      label: 'publishRewardRoot',
      call: (c: Contract<PrivateState>, ctx: CircuitContext<PrivateState>) =>
        c.circuits.publishRewardRoot(ctx, fakeBytes32(7)),
      expectedError: 'Only governor can publish reward root',
    },
    {
      label: 'updateClaimFee',
      call: (c: Contract<PrivateState>, ctx: CircuitContext<PrivateState>) =>
        c.circuits.updateClaimFee(ctx, 6_000_000n),
      expectedError: 'Only governor can update claim fee',
    },
  ])('$label fails without governor signature', ({ call, expectedError }) => {
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { governorFill: 66 }));
    expect(() => call(attacker, ctx)).toThrow(expectedError);
  });

  it('updateClaimFee fails with a zero amount', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.updateClaimFee(ctx, 0n)).toThrow('Claim fee must be positive');
  });
});

describe('staking_pool.compact — proveStake', () => {
  it('returns the correct staked amount for a valid proof', () => {
    const d = deploy();
    const STAKER_FILL = 10;
    const { ctx, stakeArgsFor } = publishStakeSnapshot(d, [
      { fill: STAKER_FILL, stakedAmount: 4_200n },
      { fill: 11, stakedAmount: 800n },
    ]);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, stakeArgsFor(STAKER_FILL)));
    const r = staker.circuits.proveStake(ctx);
    expect(r.result).toBe(4_200n);
  });

  it('rejects a tampered stake proof', () => {
    const d = deploy();
    const STAKER_FILL = 10;
    const { ctx, stakeArgsFor } = publishStakeSnapshot(d, [
      { fill: STAKER_FILL, stakedAmount: 4_200n },
      { fill: 11, stakedAmount: 800n },
    ]);
    const args = stakeArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(
      makeWitnesses(STAKER_FILL, { ...args, stakeLeafAmount: args.stakeLeafAmount + 1n }),
    );
    expect(() => staker.circuits.proveStake(ctx)).toThrow('Invalid stake proof');
  });
});

describe('staking_pool.compact — claimRewards', () => {
  const STAKER_FILL = 10;
  const STAKER_ADDR = fakeBytes32(200); // real unshielded payout address, distinct from the derived identity

  // Claims in this block are made after the whole runway has elapsed, so
  // the emission ceiling is the full pool and each test exercises what it
  // is named for rather than the clock. The ceiling has its own block below.
  const claimAt = NOW + Number(RUNWAY_SECONDS);

  function setupWithPool(poolAmount: bigint, cumulativeAmount: bigint, startAt: number = NOW) {
    const d = deploy();
    const r1 = d.contract.circuits.topUpPool(d.ctx, poolAmount);
    const ctxAfterTopUp = nextContext(d.contractAddress, r1.context);
    const rStart = d.contract.circuits.startEmission(
      nextContextAtTime(d.contractAddress, ctxAfterTopUp, startAt),
      BigInt(startAt),
    );
    const ctxAfterStart = nextContext(d.contractAddress, rStart.context);
    const published = publishRewardRoot(
      { contract: d.contract, contractAddress: d.contractAddress, ctx: ctxAfterStart },
      [
        { fill: STAKER_FILL, cumulativeAmount },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    return {
      ...d,
      ctx: nextContextAtTime(d.contractAddress, published.ctx, claimAt),
      rewardArgsFor: published.rewardArgsFor,
      startAt,
    };
  }

  it('succeeds with a valid proof, real payout does not throw locally, and updates ledger', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    // Split of INITIAL_CLAIM_FEE (5_000_000n) at 60% treasury, floor: 3_000_000n
    const r = staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt));
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.poolBalance).toBe(7_000n); // 10_000 - 3_000
    expect(state.claimedRewards.lookup(deriveUserPublicKey(fakeBytes32(STAKER_FILL), LAUNCH_ID))).toBe(3_000n);
  });

  it('rejects a tampered reward proof', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(
      makeWitnesses(STAKER_FILL, { ...args, rewardLeafAmount: args.rewardLeafAmount + 1n }),
    );
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt))).toThrow('Invalid reward proof');
  });

  it('rejects a claim with nothing new to claim (cumulative == already claimed)', () => {
    const { contractAddress, ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    const r1 = staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt));
    const ctx2 = nextContext(contractAddress, r1.context);
    // Same proof, same cumulative amount — nothing new accrued since last claim.
    expect(() => staker.circuits.claimRewards(ctx2, STAKER_ADDR, BigInt(claimAt))).toThrow('Nothing new to claim');
  });

  it('pays only the delta on a second claim after a new reward root is published', () => {
    const { contract, contractAddress, ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args1 = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args1));
    const r1 = staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt));
    const ctx2 = nextContext(contractAddress, r1.context);

    // Governor publishes a fresh root: staker has now earned 5,000 cumulative.
    const { ctx: ctx3, rewardArgsFor: rewardArgsFor2 } = publishRewardRoot({ contract, contractAddress, ctx: ctx2 }, [
      { fill: STAKER_FILL, cumulativeAmount: 5_000n },
      { fill: 11, cumulativeAmount: 1n },
    ]);
    const args2 = rewardArgsFor2(STAKER_FILL);
    const staker2 = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args2));
    // The $1-equivalent claim fee is FLAT per claim, not proportional to the
    // reward amount — treasury share is still 60% of INITIAL_CLAIM_FEE.
    // Re-pin after the republish: the helper advances the context, which
    // resets block time, and a claim is bound to real chain time.
    const r2 = staker2.circuits.claimRewards(
      nextContextAtTime(contractAddress, ctx3, claimAt),
      STAKER_ADDR,
      BigInt(claimAt),
    );
    const state = ledger(r2.context.currentQueryContext.state);
    // Delta claimed this time: 5,000 - 3,000 = 2,000
    expect(state.claimedRewards.lookup(deriveUserPublicKey(fakeBytes32(STAKER_FILL), LAUNCH_ID))).toBe(5_000n);
    expect(state.poolBalance).toBe(5_000n); // 10_000 - 3_000 (1st) - 2_000 (2nd)
  });

  it('rejects a payout exceeding the remaining pool balance', () => {
    const { ctx, rewardArgsFor } = setupWithPool(1_000n, 3_000n); // pool has less than the claim
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt))).toThrow('Pool balance exhausted');
  });

  // Was 'rejects an incorrect treasury/ops fee split'. With one platform
  // wallet the claim fee is read from ledger state and paid whole, so the
  // caller supplies no share and there is nothing to get wrong.
  it('pays the whole claim fee to the platform, with no share supplied by the caller', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, STAKER_ADDR, BigInt(claimAt))).not.toThrow();
  });

  it('rejects an empty recipient address', () => {
    const { ctx, rewardArgsFor } = setupWithPool(10_000n, 3_000n);
    const args = rewardArgsFor(STAKER_FILL);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, args));
    expect(() => staker.circuits.claimRewards(ctx, fakeBytes32(0), BigInt(claimAt))).toThrow(
      'Recipient address cannot be empty',
    );
  });
});

describe('staking_pool.compact — the runway paces what any reward root can release', () => {
  const STAKER_FILL = 10;
  const STAKER_ADDR = fakeBytes32(200);
  const POOL = 10_000_000n;

  /** Funds a pool, starts the runway at NOW, and credits one staker a given amount. */
  function poolCrediting(cumulativeAmount: bigint) {
    const d = deploy();
    const rTop = d.contract.circuits.topUpPool(d.ctx, POOL);
    const ctxTop = nextContext(d.contractAddress, rTop.context);
    const rStart = d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, ctxTop, NOW), BigInt(NOW));
    const published = publishRewardRoot(
      {
        contract: d.contract,
        contractAddress: d.contractAddress,
        ctx: nextContext(d.contractAddress, rStart.context),
      },
      [
        { fill: STAKER_FILL, cumulativeAmount },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    return { ...d, ctx: published.ctx, rewardArgsFor: published.rewardArgsFor };
  }

  function claimingAt(d: ReturnType<typeof poolCrediting>, at: number, fill: number = STAKER_FILL) {
    const staker = new Contract<PrivateState>(makeWitnesses(fill, d.rewardArgsFor(fill)));
    return () => staker.circuits.claimRewards(nextContextAtTime(d.contractAddress, d.ctx, at), STAKER_ADDR, BigInt(at));
  }

  it('refuses a root that credits the whole pool the moment emission starts', () => {
    // The shape the ceiling exists for: a root committing one key to the
    // entire balance. The proof is valid against a really published root and
    // the pool holds the funds — elapsed time is the only thing stopping it.
    const d = poolCrediting(POOL);
    expect(claimingAt(d, NOW + 60)).toThrow('Claim exceeds what the emission runway has released so far');
  });

  it('releases a tenth of the pool a tenth of the way through, and no more', () => {
    const tenthOfRunway = NOW + Number(RUNWAY_SECONDS / 10n);

    // A claim for a tenth passes at that point...
    const modest = poolCrediting(POOL / 10n);
    const r = claimingAt(modest, tenthOfRunway)();
    expect(ledger(r.context.currentQueryContext.state).poolBalance).toBe(POOL - POOL / 10n);

    // ...while one for the whole pool at the same instant does not, so the
    // ceiling tracks elapsed time rather than refusing unconditionally.
    const greedy = poolCrediting(POOL);
    expect(claimingAt(greedy, tenthOfRunway)).toThrow('Claim exceeds what the emission runway has released so far');
  });

  it('releases the whole pool once the runway has run', () => {
    const d = poolCrediting(POOL);
    const r = claimingAt(d, NOW + Number(RUNWAY_SECONDS))();
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.poolBalance).toBe(0n);
    expect(state.totalClaimed).toBe(POOL);
  });

  it('counts claims across DIFFERENT stakers against one ceiling', () => {
    // Per-staker `claimedRewards` cannot answer this: two keys each within
    // their own entitlement can still exceed what time has released between
    // them, which is how a crafted root would spread a drain rather than
    // concentrate it.
    const d = deploy();
    const rTop = d.contract.circuits.topUpPool(d.ctx, POOL);
    const rStart = d.contract.circuits.startEmission(
      nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, rTop.context), NOW),
      BigInt(NOW),
    );
    const half = POOL / 2n;
    const published = publishRewardRoot(
      {
        contract: d.contract,
        contractAddress: d.contractAddress,
        ctx: nextContext(d.contractAddress, rStart.context),
      },
      [
        { fill: STAKER_FILL, cumulativeAmount: half },
        { fill: 11, cumulativeAmount: half },
      ],
    );
    // Just past halfway, so exactly one of the two halves fits.
    const at = NOW + Number((RUNWAY_SECONDS * 6n) / 10n);
    const first = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, published.rewardArgsFor(STAKER_FILL)));
    const r1 = first.circuits.claimRewards(
      nextContextAtTime(d.contractAddress, published.ctx, at),
      STAKER_ADDR,
      BigInt(at),
    );
    expect(ledger(r1.context.currentQueryContext.state).totalClaimed).toBe(half);

    const second = new Contract<PrivateState>(makeWitnesses(11, published.rewardArgsFor(11)));
    expect(() =>
      second.circuits.claimRewards(
        nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, r1.context), at),
        fakeBytes32(201),
        BigInt(at),
      ),
    ).toThrow('Claim exceeds what the emission runway has released so far');
  });

  it('pays nothing until emission has been started', () => {
    const d = deploy();
    const rTop = d.contract.circuits.topUpPool(d.ctx, POOL);
    const published = publishRewardRoot(
      {
        contract: d.contract,
        contractAddress: d.contractAddress,
        ctx: nextContext(d.contractAddress, rTop.context),
      },
      [
        { fill: STAKER_FILL, cumulativeAmount: 1n },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, published.rewardArgsFor(STAKER_FILL)));
    expect(() =>
      staker.circuits.claimRewards(nextContextAtTime(d.contractAddress, published.ctx, NOW), STAKER_ADDR, BigInt(NOW)),
    ).toThrow('Emission has not started');
  });
});

describe('staking_pool.compact — startEmission', () => {
  function funded() {
    const d = deploy();
    const r = d.contract.circuits.topUpPool(d.ctx, 1_000_000n);
    return { ...d, ctx: nextContext(d.contractAddress, r.context) };
  }

  it('fixes the base at what is funded, and records the start', () => {
    const d = funded();
    const r = d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW));
    const state = ledger(r.context.currentQueryContext.state);
    expect(state.emissionStartTime).toBe(BigInt(NOW));
    expect(state.emissionBase).toBe(1_000_000n);
  });

  it('does not raise the base on a later top-up, so a pool pays for longer rather than faster', () => {
    const d = funded();
    const rStart = d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW));
    const rTop = d.contract.circuits.topUpPool(nextContext(d.contractAddress, rStart.context), 9_000_000n);
    const state = ledger(rTop.context.currentQueryContext.state);
    expect(state.poolBalance).toBe(10_000_000n);
    expect(state.emissionBase).toBe(1_000_000n);
  });

  it('rejects a non-governor caller', () => {
    const d = funded();
    // The governor secret is what this gates on, so that is what has to
    // differ — a different USER secret would still hold the real one.
    const attacker = new Contract<PrivateState>(makeWitnesses(1, { governorFill: 66 }));
    expect(() =>
      attacker.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW)),
    ).toThrow('Only governor can start emission');
  });

  it('rejects starting twice, which would move the clock forward', () => {
    const d = funded();
    const r = d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW));
    const later = NOW + 1000;
    expect(() =>
      d.contract.circuits.startEmission(
        nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, r.context), later),
        BigInt(later),
      ),
    ).toThrow('Emission has already started');
  });

  it('rejects starting an unfunded pool', () => {
    const d = deploy();
    expect(() =>
      d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW)),
    ).toThrow('Cannot start emission on an unfunded pool');
  });

  it('rejects a backdated start, which would unlock emission that has not elapsed', () => {
    const d = funded();
    expect(() =>
      d.contract.circuits.startEmission(nextContextAtTime(d.contractAddress, d.ctx, NOW), BigInt(NOW - 7200)),
    ).toThrow('currentTimestamp too far in the past');
  });
});

describe('staking_pool.compact — the runway a launch may deploy with', () => {
  function deployWithRunway(seconds: bigint) {
    const contract = new Contract<PrivateState>(makeWitnesses(99));
    return deployForTest(
      contract,
      undefined,
      LAUNCH_ID,
      CREATOR_PUBKEY,
      PLATFORM_ADDR,
      INITIAL_CLAIM_FEE,
      MAX_POOL_BUDGET,
      seconds,
    );
  }

  it('accepts the documented three-to-five-year band at both ends', () => {
    expect(() => deployWithRunway(1095n * 86_400n)).not.toThrow();
    expect(() => deployWithRunway(1825n * 86_400n)).not.toThrow();
  });

  it('refuses a runway shorter than three years', () => {
    expect(() => deployWithRunway(1095n * 86_400n - 1n)).toThrow('Emission runway is below the 3-year minimum');
  });

  it('refuses a runway longer than five years', () => {
    expect(() => deployWithRunway(1825n * 86_400n + 1n)).toThrow('Emission runway is above the 5-year maximum');
  });
});

describe('staking_pool.compact — the ceiling stops rising when the runway ends', () => {
  const STAKER_FILL = 10;
  const STAKER_ADDR = fakeBytes32(200);

  it('does not release a post-start top-up just because more time has passed', () => {
    // The runway is capped at its own length, so once it has run the
    // ceiling is the base and stays there. Without that cap the ceiling
    // would keep climbing, and simply waiting long enough would release a
    // top-up the base never covered — which is the opposite of a top-up
    // extending the runway.
    const d = deploy();
    const rFirst = d.contract.circuits.topUpPool(d.ctx, 1_000_000n);
    const rStart = d.contract.circuits.startEmission(
      nextContextAtTime(d.contractAddress, nextContext(d.contractAddress, rFirst.context), NOW),
      BigInt(NOW),
    );
    // Funded again AFTER the clock started: the pool holds ten times the
    // base, and the base is unchanged.
    const rSecond = d.contract.circuits.topUpPool(nextContext(d.contractAddress, rStart.context), 9_000_000n);
    const afterTopUp = ledger(rSecond.context.currentQueryContext.state);
    expect(afterTopUp.poolBalance).toBe(10_000_000n);
    expect(afterTopUp.emissionBase).toBe(1_000_000n);

    const published = publishRewardRoot(
      {
        contract: d.contract,
        contractAddress: d.contractAddress,
        ctx: nextContext(d.contractAddress, rSecond.context),
      },
      [
        { fill: STAKER_FILL, cumulativeAmount: 10_000_000n },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );

    // Ten runways later. The pool has the funds and the proof is valid.
    const farFuture = NOW + Number(RUNWAY_SECONDS * 10n);
    const staker = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, published.rewardArgsFor(STAKER_FILL)));
    expect(() =>
      staker.circuits.claimRewards(
        nextContextAtTime(d.contractAddress, published.ctx, farFuture),
        STAKER_ADDR,
        BigInt(farFuture),
      ),
    ).toThrow('Claim exceeds what the emission runway has released so far');

    // And the base itself is claimable at that point, so the refusal above
    // is the ceiling being reached rather than everything being refused.
    const modest = publishRewardRoot(
      {
        contract: d.contract,
        contractAddress: d.contractAddress,
        ctx: nextContext(d.contractAddress, rSecond.context),
      },
      [
        { fill: STAKER_FILL, cumulativeAmount: 1_000_000n },
        { fill: 11, cumulativeAmount: 1n },
      ],
    );
    const patient = new Contract<PrivateState>(makeWitnesses(STAKER_FILL, modest.rewardArgsFor(STAKER_FILL)));
    const r = patient.circuits.claimRewards(
      nextContextAtTime(d.contractAddress, modest.ctx, farFuture),
      STAKER_ADDR,
      BigInt(farFuture),
    );
    expect(ledger(r.context.currentQueryContext.state).totalClaimed).toBe(1_000_000n);
  });
});
