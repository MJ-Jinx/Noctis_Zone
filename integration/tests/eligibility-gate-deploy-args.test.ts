// Every refusal here mirrors an assertion eligibility_gate.compact's
// constructor makes, so the point of each test is that a bad deploy is stopped
// before it costs a transaction — with an error naming the field rather than
// the circuit.
//
// Each case is the valid input with ONE field changed, so the field under test
// is the only thing it can fail on.

import { describe, expect, it } from 'vitest';
import { MAX_BOND_AMOUNT, resolveEligibilityGateDeployArgs } from '../eligibility-gate-deploy-args.js';

const hex = (byte: number) => byte.toString(16).padStart(2, '0').repeat(32);

const VALID = {
  launchIdHex: hex(0x01),
  allowlistRootHex: hex(0x02),
  creatorPubKeyHex: hex(0x03),
  platformAddrHex: hex(0x04),
  allowlistAttestorKeysHex: [hex(0xa1), hex(0xa2), hex(0xa3)] as [string, string, string],
  allowlistThreshold: 2,
  totalSupply: '1000000000',
  maxWalletPercent: 5,
  bondAmount: '1000000',
  dvAllocation: '150000000',
  dvPrice: '3',
  allowlistSize: 20,
  registrationCloseTime: '1785000000',
  minDvParticipants: 15,
};

describe('resolveEligibilityGateDeployArgs', () => {
  it('resolves a valid input and derives walletCap rather than trusting it', () => {
    const args = resolveEligibilityGateDeployArgs(VALID);
    // 5% of 1,000,000,000.
    expect(args.walletCap).toBe(50_000_000n);
    expect(args.allowlistThreshold).toBe(2n);
    expect(args.launchId).toHaveLength(32);
    expect(args.allowlistAttestorKeys).toHaveLength(3);
  });

  it('accepts a supplied walletCap that agrees, and refuses one that does not', () => {
    expect(resolveEligibilityGateDeployArgs({ ...VALID, walletCap: '50000000' }).walletCap).toBe(50_000_000n);
    // The contract only checks this is positive — it cannot divide — so a
    // wrong value would otherwise cap every wallet for the life of the launch.
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, walletCap: '50000001' })).toThrow(
      /does not equal totalSupply \* maxWalletPercent \/ 100/,
    );
  });

  // ---- the three-distinct-attestor rule ---------------------------------

  it('refuses an all-zero attestor key', () => {
    expect(() =>
      resolveEligibilityGateDeployArgs({
        ...VALID,
        allowlistAttestorKeysHex: [hex(0x00), hex(0xa2), hex(0xa3)],
      }),
    ).toThrow(/allowlistAttestorKeysHex\[0\] cannot be all zero/);
  });

  it.each([
    [0, 1, [hex(0xa1), hex(0xa1), hex(0xa3)]],
    [0, 2, [hex(0xa1), hex(0xa2), hex(0xa1)]],
    [1, 2, [hex(0xa1), hex(0xa2), hex(0xa2)]],
  ] as const)('refuses attestors %i and %i being the same key', (i, j, keys) => {
    expect(() =>
      resolveEligibilityGateDeployArgs({ ...VALID, allowlistAttestorKeysHex: keys as [string, string, string] }),
    ).toThrow(new RegExp(`\\[${i}\\] and \\[${j}\\] are the same key`));
  });

  it('refuses anything other than exactly three attestor keys', () => {
    expect(() =>
      resolveEligibilityGateDeployArgs({
        ...VALID,
        allowlistAttestorKeysHex: [hex(0xa1), hex(0xa2)] as unknown as [string, string, string],
      }),
    ).toThrow(/exactly three keys/);
  });

  it.each([1, 4, 0])('refuses a threshold of %i', (t) => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, allowlistThreshold: t })).toThrow(
      /allowlistThreshold must be 2 or 3/,
    );
  });

  // ---- the numeric bounds ------------------------------------------------

  it('refuses a bondAmount above verifyRatioRefund’s ceiling, and accepts it at the ceiling', () => {
    expect(resolveEligibilityGateDeployArgs({ ...VALID, bondAmount: MAX_BOND_AMOUNT.toString() }).bondAmount).toBe(
      MAX_BOND_AMOUNT,
    );
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, bondAmount: (MAX_BOND_AMOUNT + 1n).toString() })).toThrow(
      /exceeds 17592186044415/,
    );
  });

  it('refuses a zero registrationCloseTime', () => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, registrationCloseTime: '0' })).toThrow(
      /registrationCloseTime must be greater than 0/,
    );
  });

  it('refuses a zero minDvParticipants', () => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, minDvParticipants: 0 })).toThrow(
      /minDvParticipants must be greater than 0/,
    );
  });

  it('refuses a dvAllocation larger than the whole supply', () => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, dvAllocation: '1000000001' })).toThrow(
      /exceeds totalSupply/,
    );
  });

  it.each([0, 101])('refuses a maxWalletPercent of %i', (p) => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, maxWalletPercent: p })).toThrow(
      /maxWalletPercent must be 1-100/,
    );
  });

  it('refuses a supply so small that the cap derives to zero', () => {
    // 1 * 5 / 100 == 0 under integer division. The contract would reject this
    // too, but only after the transaction had been built and paid for.
    //
    // dvAllocation moves with the supply here rather than staying at its
    // default: left at 150,000,000 it would exceed a supply of 1 and this
    // would pass on the WRONG error, testing dvAllocation while claiming to
    // test the cap.
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, totalSupply: '1', dvAllocation: '1' })).toThrow(
      /walletCap derives to 0/,
    );
  });

  it('refuses an all-zero platform address', () => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, platformAddrHex: hex(0x00) })).toThrow(
      /platformAddrHex cannot be all zero/,
    );
  });

  // ---- the coercions BigInt() would otherwise wave through ---------------

  it.each([
    ['false', false],
    ['an empty string', ''],
    ['an empty array', []],
    ['null', null],
  ] as const)('refuses %s where a number is expected, rather than coercing it to 0', (_label, value) => {
    // BigInt(false), BigInt('') and BigInt([]) are all 0n. Left to the
    // conversion, a missing supply would silently become zero.
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, totalSupply: value as unknown as string })).toThrow(
      /totalSupply/,
    );
  });

  it('refuses a negative number rather than passing it through', () => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, dvPrice: -1 })).toThrow(/must not be negative/);
  });

  it.each([
    ['too short', 'ab'],
    ['not hex', 'z'.repeat(64)],
    ['a number', 12345 as unknown as string],
  ] as const)('refuses a launch id that is %s', (_label, value) => {
    expect(() => resolveEligibilityGateDeployArgs({ ...VALID, launchIdHex: value as string })).toThrow(
      /launchIdHex: expected 64 hex characters/,
    );
  });
});
