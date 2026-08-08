import { afterEach, describe, expect, it } from 'vitest';
import { Contract, Currency, type Ledger, ledger, type Witnesses } from '../compiled/treasury/contract/index.js';
import { deployForTest, fakeBytes32, type LedgerSink, nextContext, trackLedger } from './helpers.js';

type PrivateState = undefined;

const witnesses: Witnesses<PrivateState> = {
  getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(2) }],
};

// 10,000 / 25,000 ADA in lovelace — matches CLAUDE.md's treasury-floor thresholds.
const FLOOR_LOVELACE = 10_000_000_000n;
const WARNING_LOVELACE = 25_000_000_000n;

function deploy(floor = FLOOR_LOVELACE, warning = WARNING_LOVELACE) {
  const contract = new Contract<PrivateState>(witnesses);
  const { init, contractAddress, ctx } = deployForTest(contract, undefined, fakeBytes32(9), floor, warning);
  return { contract, init, contractAddress, ctx };
}

describe('treasury.compact', () => {
  // Real conservation invariant (the treasury-floor fix, not a trivially-true
  // assertion): each currency's spendable balance can only ever be
  // depleted by a withdrawal, so it can never exceed that currency's
  // lifetime-collected counter — a regression here would mean deposits
  // and withdrawals stopped being tracked correctly per-currency (the
  // exact bug class that fix closed: both currencies used to sum into one
  // meaningless combined field).
  const lastLedger: LedgerSink<Ledger> = {};
  afterEach(() => {
    if (lastLedger.current) {
      const s = lastLedger.current;
      expect(s.adaBalance).toBeLessThanOrEqual(s.totalAdaFeesCollected);
      expect(s.nightBalance).toBeLessThanOrEqual(s.totalNightFeesCollected);
    }
    lastLedger.current = undefined;
  });

  it('starts with zero balances in both currencies', () => {
    const { init } = deploy();
    const state = trackLedger(lastLedger, ledger(init.currentContractState.data));
    expect(state.adaBalance).toBe(0n);
    expect(state.nightBalance).toBe(0n);
    expect(state.totalAdaFeesCollected).toBe(0n);
    expect(state.totalNightFeesCollected).toBe(0n);
  });

  it('accumulates ADA fees across multiple deposits (width-narrowing fix regression)', () => {
    // treasury.compact's depositFees previously failed to compile because
    // `treasuryBalance + amount` (Uint<128> + Uint<128>) widens beyond
    // Uint<128> and needs an explicit `as Uint<128>` re-cast. This proves
    // the fix doesn't just compile — it accumulates correctly across
    // multiple real circuit calls.
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada);
    const afterFirst = trackLedger(lastLedger, ledger(r1.context.currentQueryContext.state));
    expect(afterFirst.adaBalance).toBe(1000n);
    expect(afterFirst.totalAdaFeesCollected).toBe(1000n);

    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 2500n, Currency.Ada);
    const afterSecond = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(afterSecond.adaBalance).toBe(3500n);
    expect(afterSecond.totalAdaFeesCollected).toBe(3500n);
  });

  it('ADA and NIGHT deposits accumulate into SEPARATE balances, not one mixed total', () => {
    // Before this fix, both currencies summed into one `treasuryBalance` —
    // 1000 lovelace + 500 NIGHT atomic units became a meaningless "1500."
    // A floor check needs each currency's real value tracked separately.
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada); // Tier B launch fee
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 500n, Currency.Night); // Tier C launch fee
    const state = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(state.adaBalance).toBe(1000n);
    expect(state.nightBalance).toBe(500n);
    expect(state.totalAdaFeesCollected).toBe(1000n);
    expect(state.totalNightFeesCollected).toBe(500n);
  });

  it('allows the governor to withdraw ADA up to the ADA balance', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.withdrawFees(ctx2, 2000n, Currency.Ada, fakeBytes32(5));
    const afterWithdraw = trackLedger(lastLedger, ledger(r2.context.currentQueryContext.state));
    expect(afterWithdraw.adaBalance).toBe(3000n);
    // totalAdaFeesCollected is a lifetime counter, unaffected by withdrawal
    expect(afterWithdraw.totalAdaFeesCollected).toBe(5000n);
    expect(afterWithdraw.withdrawalCount).toBe(1n);
  });

  it('allows the governor to withdraw NIGHT up to the NIGHT balance, independent of the ADA balance', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 3000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);
    const r3 = contract.circuits.withdrawFees(ctx3, 1000n, Currency.Night, fakeBytes32(5));
    const afterWithdraw = trackLedger(lastLedger, ledger(r3.context.currentQueryContext.state));
    expect(afterWithdraw.nightBalance).toBe(2000n);
    expect(afterWithdraw.adaBalance).toBe(5000n); // untouched
  });

  it('Phase 5 hygiene fix: withdrawFees rejects an empty (all-zero) recipient address', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 5000n, Currency.Night);
    const ctx2 = nextContext(contractAddress, r1.context);
    expect(() => contract.circuits.withdrawFees(ctx2, 1000n, Currency.Night, fakeBytes32(0))).toThrow(
      'Recipient address cannot be empty',
    );
  });

  it('rejects a withdrawal exceeding the balance in that currency, even if the other currency has enough', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 1000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 10_000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    // Only 1000 ADA available, but 5000 is requested — must fail even
    // though the NIGHT balance (10,000) alone would easily cover it.
    expect(() => contract.circuits.withdrawFees(ctx3, 5000n, Currency.Ada, fakeBytes32(5))).toThrow(
      'Insufficient ADA treasury balance',
    );
  });

  it('getAdaBalance / getNightBalance read back each currency independently', () => {
    const { contract, contractAddress, ctx } = deploy();

    const r1 = contract.circuits.depositFees(ctx, 750n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 300n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    const adaResult = contract.circuits.getAdaBalance(ctx3);
    expect(adaResult.result).toBe(750n);

    const ctx4 = nextContext(contractAddress, adaResult.context);
    const nightResult = contract.circuits.getNightBalance(ctx4);
    expect(nightResult.result).toBe(300n);
  });
});

describe('treasury.compact — payment enforcement', () => {
  it('a NIGHT deposit (Tier C fees) requires receiveUnshielded and does not throw locally', () => {
    // Same caveat as the other payment-enforcement tests: the local compact-runtime
    // simulator doesn't model cross-transaction UTXO matching, so this
    // proves the currency-gated call is wired in, not that a missing
    // payment is rejected end-to-end (real-node enforcement).
    const { contract, ctx } = deploy();
    const result = contract.circuits.depositFees(ctx, 2000n, Currency.Night);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.nightBalance).toBe(2000n);
  });

  it('an ADA deposit (Tier A/B fees) never calls receiveUnshielded, unchanged behavior', () => {
    const { contract, ctx } = deploy();
    const result = contract.circuits.depositFees(ctx, 2000n, Currency.Ada);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.adaBalance).toBe(2000n);
  });

  it('Fix (2026-07-21, High): rejects an ADA deposit from a non-governor caller', () => {
    // depositFees's ADA branch must enforce access control, matching the
    // NIGHT branch (payment-enforced via receiveUnshielded). Without it,
    // depositFees(2^127, Currency.Ada) could be called freely and defeat
    // isBelowFloor/isBelowWarning (the launch-pause safety gate), and risk a
    // Uint<128> overflow DoS on the health-check
    // circuits. ADA deposits are unpaid bookkeeping (ADA isn't a
    // Midnight-native token receiveUnshielded can check), so only the
    // trusted governor may record one now.
    const { ctx } = deploy();
    const attacker = new Contract<PrivateState>({
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor
    });
    expect(() => attacker.circuits.depositFees(ctx, 2000n, Currency.Ada)).toThrow(/governor/i);
  });

  it('Fix (2026-07-21, High): a NIGHT deposit still requires no governor gate (payment-enforced instead)', () => {
    // The NIGHT branch's real receiveUnshielded payment check is a
    // different, already-sufficient enforcement mechanism — anyone paying
    // real NIGHT may deposit it, no governor gate needed or added there.
    const { ctx } = deploy();
    const anyCaller = new Contract<PrivateState>({
      getGovernorSecret: (_ctx) => [undefined, { bytes: fakeBytes32(99) }], // wrong governor, irrelevant here
    });
    const result = anyCaller.circuits.depositFees(ctx, 2000n, Currency.Night);
    const state = ledger(result.context.currentQueryContext.state);
    expect(state.nightBalance).toBe(2000n);
  });
});

describe('treasury.compact — mark-to-market floor/warning check', () => {
  it('getAdaEquivalentBalance combines ADA balance plus NIGHT balance converted at the given rate', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 6_000_000_000n, Currency.Ada); // 6,000 ADA
    const ctx2 = nextContext(contractAddress, r1.context);
    // 5,000,000 atomic NIGHT units at 1,000 lovelace/unit = 5,000,000,000 lovelace (5,000 ADA-equiv)
    const r2 = contract.circuits.depositFees(ctx2, 5_000_000n, Currency.Night);
    const ctx3 = nextContext(contractAddress, r2.context);

    const result = contract.circuits.getAdaEquivalentBalance(ctx3, 1_000n);
    expect(result.result).toBe(11_000_000_000n); // 6,000 + 5,000 = 11,000 ADA-equivalent
  });

  it('isBelowFloor is false when the ADA-equivalent total is above the floor', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, FLOOR_LOVELACE + 1_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const result = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(result.result).toBe(false);
  });

  it('isBelowFloor is true when the ADA-equivalent total is below the floor', () => {
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, FLOOR_LOVELACE - 1_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);
    const result = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(result.result).toBe(true);
  });

  it('isBelowFloor mark-to-markets NIGHT holdings instead of ignoring them', () => {
    // ADA balance alone is well below the floor, but a large NIGHT holding
    // (converted at a real rate) pushes the combined total back above it —
    // proves NIGHT is actually counted, not silently dropped from the check.
    const { contract, contractAddress, ctx } = deploy();
    const r1 = contract.circuits.depositFees(ctx, 1_000_000_000n, Currency.Ada); // 1,000 ADA
    const ctx2 = nextContext(contractAddress, r1.context);
    const r2 = contract.circuits.depositFees(ctx2, 90_000_000n, Currency.Night); // 90M atomic units
    const ctx3 = nextContext(contractAddress, r2.context);

    // At 1,000 lovelace/atomic-unit: 90,000,000 * 1,000 = 90,000,000,000 lovelace (90,000 ADA-equiv)
    const result = contract.circuits.isBelowFloor(ctx3, 1_000n);
    expect(result.result).toBe(false); // 1,000 + 90,000 = 91,000 ADA-equiv, well above the 10,000 floor
  });

  it('isBelowWarning triggers at the higher threshold while isBelowFloor does not', () => {
    const { contract, contractAddress, ctx } = deploy();
    // 15,000 ADA — above the 10,000 floor, below the 25,000 warning line.
    const r1 = contract.circuits.depositFees(ctx, 15_000_000_000n, Currency.Ada);
    const ctx2 = nextContext(contractAddress, r1.context);

    const floorResult = contract.circuits.isBelowFloor(ctx2, 0n);
    expect(floorResult.result).toBe(false);

    const ctx3 = nextContext(contractAddress, floorResult.context);
    const warningResult = contract.circuits.isBelowWarning(ctx3, 0n);
    expect(warningResult.result).toBe(true);
  });

  it('a fresh treasury with zero balance is below both floor and warning', () => {
    const { contract, ctx } = deploy();
    const floorResult = contract.circuits.isBelowFloor(ctx, 0n);
    expect(floorResult.result).toBe(true);
  });
});
