// Tests for the creator dashboard widget's client-side vesting arithmetic.
//
// This is what a real creator reads before deciding whether to claim, and it
// has to agree with vesting.ak's ClaimVested formula exactly — the contract
// is the thing that ultimately accepts or refuses the amount. The two agree
// only if both are in milliseconds: `vest_start_timestamp` is stored from a
// value bound to a transaction's validity range, and the validator measures
// the schedule as vest_days * 86_400_000.
//
// A seconds-scale "now" here does not read as a slightly early date. It is
// smaller than the stored start by about the epoch, so elapsed goes negative
// and the widget reports nothing claimable no matter how much has vested —
// a silent, total misreport rather than a visible error.

import { describe, expect, it } from 'vitest';
import { computeVestedToDate, type VestingScheduleFields } from '../widget/tier-a-dashboard-widget-entry.js';

/** A real launch shape: 50M tokens over 180 days, started at a real instant. */
const VEST_START_MS = 1_775_000_000_000;
const DAY_MS = 86_400_000;

function datum(overrides: Partial<VestingScheduleFields> = {}): VestingScheduleFields {
  return {
    vesting_state: 'Vesting',
    vest_start_timestamp: BigInt(VEST_START_MS),
    vest_days: 180n,
    token_allocation: 50_000_000n,
    ...overrides,
  };
}

describe('computeVestedToDate', () => {
  it('vests nothing at the very start', () => {
    expect(computeVestedToDate(datum(), BigInt(VEST_START_MS))).toBe(0n);
  });

  it('vests exactly half the allocation at half the schedule', () => {
    const halfway = BigInt(VEST_START_MS + 90 * DAY_MS);
    expect(computeVestedToDate(datum(), halfway)).toBe(25_000_000n);
  });

  it('vests one day of the schedule after one day', () => {
    // 50,000,000 / 180 = 277,777.7…, floored — the whitepaper's own
    // 277,778/day figure is the rounded presentation of this.
    const oneDay = BigInt(VEST_START_MS + DAY_MS);
    expect(computeVestedToDate(datum(), oneDay)).toBe(277_777n);
  });

  it('caps at the full allocation past the end of the schedule', () => {
    const wellPast = BigInt(VEST_START_MS + 5000 * DAY_MS);
    expect(computeVestedToDate(datum(), wellPast)).toBe(50_000_000n);
  });

  it('reports nothing vested when handed a seconds-scale now', () => {
    // The defect this arithmetic carried. The same instant as the halfway
    // case above, in the wrong unit: not "a bit less", but zero.
    const halfwaySeconds = BigInt(Math.floor((VEST_START_MS + 90 * DAY_MS) / 1000));
    expect(computeVestedToDate(datum(), halfwaySeconds)).toBe(0n);
    // Stated as the contrast, so the test says what the units are FOR.
    expect(computeVestedToDate(datum(), BigInt(VEST_START_MS + 90 * DAY_MS))).toBe(25_000_000n);
  });

  it('vests nothing before the schedule has started', () => {
    expect(computeVestedToDate(datum(), BigInt(VEST_START_MS - DAY_MS))).toBe(0n);
  });

  it('vests nothing while the state is still NotStarted', () => {
    const halfway = BigInt(VEST_START_MS + 90 * DAY_MS);
    expect(computeVestedToDate(datum({ vesting_state: 'NotStarted' }), halfway)).toBe(0n);
  });

  it('still reports the vested total once FullyClaimed', () => {
    // FullyClaimed means the creator took everything, not that the schedule
    // stopped — the panel subtracts claimed_tokens separately, so zeroing
    // here would show a negative-turned-zero claimable for the wrong reason.
    const halfway = BigInt(VEST_START_MS + 90 * DAY_MS);
    expect(computeVestedToDate(datum({ vesting_state: 'FullyClaimed' }), halfway)).toBe(25_000_000n);
  });

  it('does not divide by zero when vest_days is zero', () => {
    expect(computeVestedToDate(datum({ vest_days: 0n }), BigInt(VEST_START_MS + DAY_MS))).toBe(0n);
  });
});
