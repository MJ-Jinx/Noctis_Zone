import { describe, expect, it } from 'vitest';
import { Contract, LpState, ledger, type Witnesses } from '../compiled/lp_escrow/contract/index.js';
import { deployForTest, fakeBytes32, nextContext, nextContextAtTime } from './helpers.js';

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
  getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
};

const LOCK_DURATION = 31_536_000n; // 365 days, the minimum

// Phase 3 security fix (2026-07-12): sealLock now binds its timestamp
// argument to real chain time (blockTimeGte/blockTimeLte), and
// migrateLp/isLockExpired no longer take a caller-supplied timestamp at
// all — they read real chain time directly via blockTimeGte. Tests must pin
// the simulator's block time via nextContextAtTime instead of passing
// arbitrary small values like 1000 — those would now fail sealLock's
// "timestamp too far in the past" check. NOW is an arbitrary but realistic
// epoch-seconds anchor, fixed here so every test in this file agrees on it.
const NOW = 1_780_000_000;

function deploy(lockDuration: bigint = LOCK_DURATION) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(contract, undefined, fakeBytes32(9), lockDuration);
  return { contract, init, contractAddress, ctx };
}

function deployAndSeal(sealAt: number = NOW) {
  const d = deploy();
  const pinnedCtx = nextContextAtTime(d.contractAddress, d.ctx, sealAt);
  const r = d.contract.circuits.sealLock(pinnedCtx, BigInt(sealAt));
  const ctx = nextContext(d.contractAddress, r.context);
  return { ...d, ctx, sealAt };
}

describe('lp_escrow.compact — no withdraw() invariant (structural)', () => {
  it('has no withdraw circuit at all — not disabled, not present', () => {
    const { contract } = deploy();
    const circuitNames = Object.keys(contract.circuits);
    const hasAnyWithdrawLikeCircuit = circuitNames.some((name) => /withdraw/i.test(name));
    expect(hasAnyWithdrawLikeCircuit).toBe(false);
    // The only ways LP tokens leave this contract's control are sealLock
    // (locks them further) and migrateLp (moves them to another
    // whitelisted DEX escrow) — never back to a wallet.
    expect(circuitNames.sort()).toEqual(
      [
        'sealLock',
        'triggerCTO',
        'dissolveCTO',
        'addDexToWhitelist',
        'removeDexFromWhitelist',
        'migrateLp',
        'cancelLaunch',
        'isLockExpired',
        'getLpState',
        'getCtoStatus',
        'getCommunityWallet',
      ].sort(),
    );
  });
});

describe('lp_escrow.compact — lock lifecycle', () => {
  it('rejects a lock duration under 365 days at construction', () => {
    expect(() => deploy(31_535_999n)).toThrow('Lock must be at least 365 days');
  });

  it('seals the lock exactly once', () => {
    const { contract, contractAddress, ctx } = deploy();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, NOW);
    const r1 = contract.circuits.sealLock(pinnedCtx, BigInt(NOW));
    const state = ledger(r1.context.currentQueryContext.state);
    expect(state.lockTimestamp).toBe(BigInt(NOW));

    const ctx2 = nextContextAtTime(contractAddress, r1.context, NOW);
    expect(() => contract.circuits.sealLock(ctx2, BigInt(NOW + 1000))).toThrow('Lock already sealed');
  });

  it('reports lock not expired before 365 days have passed', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, sealAt + Number(LOCK_DURATION) - 1);
    const result = contract.circuits.isLockExpired(pinnedCtx);
    expect(result.result).toBe(false);
  });

  it('reports lock expired at exactly 365 days', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, sealAt + Number(LOCK_DURATION));
    const result = contract.circuits.isLockExpired(pinnedCtx);
    expect(result.result).toBe(true);
  });

  it('rejects migration before lock expiry, even to a whitelisted DEX', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const rAdd = contract.circuits.addDexToWhitelist(ctx, fakeBytes32(50));
    const ctx2 = nextContextAtTime(contractAddress, rAdd.context, sealAt + Number(LOCK_DURATION) - 1);

    expect(() => contract.circuits.migrateLp(ctx2, fakeBytes32(50))).toThrow('Lock not expired');
  });

  it('Fix (2026-07-21, High): rejects migration on a NEVER-SEALED lock, even at a far-future block time', () => {
    // Before the fix, lockTimestamp's constructor default of 0 made
    // expiry = 0 + lockDuration evaluate to a real past date, so
    // blockTimeGte(expiry) trivially passed and a governor could migrate
    // (or an off-chain consumer could be told the lock had expired) before
    // sealLock was ever called — completely bypassing the 365-day lock.
    const { contract, contractAddress, ctx } = deploy(); // sealLock never called
    const farFuture = NOW + Number(LOCK_DURATION) * 10;
    const rAdd = contract.circuits.addDexToWhitelist(ctx, fakeBytes32(50));
    const ctx2 = nextContextAtTime(contractAddress, rAdd.context, farFuture);
    expect(() => contract.circuits.migrateLp(ctx2, fakeBytes32(50))).toThrow(/not sealed/i);
  });

  it('Fix (2026-07-21, Medium): isLockExpired reports false on a NEVER-SEALED lock, even at a far-future block time', () => {
    const { contract, contractAddress, ctx } = deploy();
    const farFuture = NOW + Number(LOCK_DURATION) * 10;
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, farFuture);
    const result = contract.circuits.isLockExpired(pinnedCtx);
    expect(result.result).toBe(false);
  });

  it('rejects migration to a non-whitelisted DEX after expiry', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, sealAt + Number(LOCK_DURATION));
    expect(() => contract.circuits.migrateLp(pinnedCtx, fakeBytes32(50))).toThrow('DEX not in whitelist');
  });

  it('allows migration to a whitelisted DEX after expiry', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const rAdd = contract.circuits.addDexToWhitelist(ctx, fakeBytes32(50));
    const ctx2 = nextContextAtTime(contractAddress, rAdd.context, sealAt + Number(LOCK_DURATION));

    const result = contract.circuits.migrateLp(ctx2, fakeBytes32(50));
    expect(result.context).toBeDefined(); // does not throw
  });

  it('adding the same DEX twice is a harmless no-op (dexWhitelist is a Set)', () => {
    const { contract, contractAddress, ctx } = deployAndSeal();
    const r1 = contract.circuits.addDexToWhitelist(ctx, fakeBytes32(50));
    const ctx2 = nextContext(contractAddress, r1.context);
    // Set.insert() on an existing member doesn't throw — same idempotent
    // semantics as the nullifier sets in eligibility_gate/darkveil.
    const r2 = contract.circuits.addDexToWhitelist(ctx2, fakeBytes32(50));
    expect(r2.context).toBeDefined();
  });

  it('removeDexFromWhitelist takes a whitelisted DEX back out', () => {
    const { contract, contractAddress, ctx, sealAt } = deployAndSeal();
    const rAdd = contract.circuits.addDexToWhitelist(ctx, fakeBytes32(50));
    const ctx2 = nextContext(contractAddress, rAdd.context);
    const rRemove = contract.circuits.removeDexFromWhitelist(ctx2, fakeBytes32(50));
    const ctx3 = nextContextAtTime(contractAddress, rRemove.context, sealAt + Number(LOCK_DURATION));

    expect(() => contract.circuits.migrateLp(ctx3, fakeBytes32(50))).toThrow('DEX not in whitelist');
  });
});

describe('lp_escrow.compact — sealLock anchor forgery (Phase 3 fix)', () => {
  it.each([
    {
      label: 'far in the past (would shortcut the 365-day lock)',
      timestamp: 0n,
      expectedError: 'timestamp too far in the past',
    },
    {
      label: 'in the future',
      timestamp: BigInt(NOW + Number(LOCK_DURATION)),
      expectedError: 'timestamp cannot be in the future',
    },
    {
      label: 'just outside the 1-hour tolerance window',
      timestamp: BigInt(NOW - 3601),
      expectedError: 'timestamp too far in the past',
    },
  ])('rejects a timestamp $label', ({ timestamp, expectedError }) => {
    const { contract, contractAddress, ctx } = deploy();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, NOW);
    expect(() => contract.circuits.sealLock(pinnedCtx, timestamp)).toThrow(expectedError);
  });

  it.each([
    { label: 'exactly at real chain time', timestamp: BigInt(NOW) },
    { label: 'within the 1-hour tolerance window', timestamp: BigInt(NOW - 1800) },
  ])('accepts a timestamp $label', ({ timestamp }) => {
    const { contract, contractAddress, ctx } = deploy();
    const pinnedCtx = nextContextAtTime(contractAddress, ctx, NOW);
    const result = contract.circuits.sealLock(pinnedCtx, timestamp);
    expect(ledger(result.context.currentQueryContext.state).lockTimestamp).toBe(timestamp);
  });
});

describe('lp_escrow.compact — CTO support', () => {
  it('cancelLaunch succeeds with governor signature, transitions out of Locked', () => {
    const { contract, ctx } = deploy(); // lpState starts Locked, no seal needed
    const result = contract.circuits.cancelLaunch(ctx);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.lpState).toBe(LpState.Cancelled);
  });

  it('GitHub #68 fix (2026-07-14): cancelLaunch rejects a caller without the governor signature', () => {
    const attacker = new Contract<PrivateState>({
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(66) }],
      getCommunitySecret: (_ctx) => [undefined, { bytes: fakeBytes32(4) }],
    });
    const { ctx } = deploy();
    expect(() => attacker.circuits.cancelLaunch(ctx)).toThrow('Only governor can cancel launch');
  });

  it('triggerCTO succeeds with governor signature and sets ctoTriggered/communityWallet', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.triggerCTO(ctx, fakeBytes32(216), fakeBytes32(4));
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.ctoTriggered).toBe(true);
  });

  it('Phase 5 hygiene fix: triggerCTO rejects an empty (all-zero) community wallet address', () => {
    const { contract, ctx } = deploy();
    expect(() => contract.circuits.triggerCTO(ctx, fakeBytes32(217), fakeBytes32(0))).toThrow(
      'Community wallet address cannot be empty',
    );
  });
});
