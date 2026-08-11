// Which staking position an unstake closes.
//
// WHY THIS MATTERS
// Unstaking closes ONE position and returns its stake. Positions are not
// interchangeable: each carries its own `stake_timestamp`, the bonding period
// is measured from it, and closing the wrong one throws away seasoning the
// staker has already served.
//
// The two cases worth testing are the ambiguous ones, because both used to be
// resolved silently — a half-named reference fell back to output 0, and no
// reference at all took whichever position the chain query returned first.
// Neither is a choice a caller made, and the second depends on an ordering
// nothing promises: two of this codebase's own chain backends have already
// been found disagreeing about exactly that.

import { describe, expect, it } from 'vitest';
import { type StakingPosition, selectPositionToUnstake } from '../staking-submitter.js';

const TX_A = 'aa'.repeat(32);
const TX_B = 'bb'.repeat(32);

/** Only the fields the selector reads; the datum is carried through untouched. */
function position(txHash: string, outputIndex: number, stakedAmount = 100n): StakingPosition {
  return {
    utxo: { txHash, outputIndex, address: 'addr_test1_pool', assets: { lovelace: 2_000_000n } },
    datum: { staker_vkh: 'cc'.repeat(28), staked_amount: stakedAmount, stake_timestamp: 1_700_000_000_000n },
  } as unknown as StakingPosition;
}

describe('selectPositionToUnstake', () => {
  it('returns the position a full reference names', () => {
    const wanted = position(TX_A, 1);
    const got = selectPositionToUnstake([position(TX_A, 0), wanted, position(TX_B, 0)], {
      txHash: TX_A,
      outputIndex: 1,
    });
    expect(got).toBe(wanted);
  });

  it('distinguishes two outputs of the SAME transaction', () => {
    // The case a fallback to output 0 gets wrong while looking correct: both
    // positions match on the hash, and only the index separates them.
    const first = position(TX_A, 0, 10n);
    const second = position(TX_A, 1, 999n);
    expect(selectPositionToUnstake([first, second], { txHash: TX_A, outputIndex: 1 })).toBe(second);
    expect(selectPositionToUnstake([first, second], { txHash: TX_A, outputIndex: 0 })).toBe(first);
  });

  it('closes the only position when none is named', () => {
    // The convenience worth keeping: with one position there is nothing to
    // choose between, so an operator should not have to name it.
    const only = position(TX_A, 0);
    expect(selectPositionToUnstake([only])).toBe(only);
    expect(selectPositionToUnstake([only], {})).toBe(only);
  });

  it('refuses to pick for the caller when several positions exist', () => {
    // Previously took positions[0] — an arbitrary position, in an order
    // nothing guarantees.
    expect(() => selectPositionToUnstake([position(TX_A, 0), position(TX_B, 0)])).toThrow(
      /holds 2 staking positions, so which one to unstake has to be named/,
    );
  });

  it('names the positions it will not choose between', () => {
    // An error that forces a second command to discover the answer is a worse
    // error than one that carries it.
    expect(() => selectPositionToUnstake([position(TX_A, 0), position(TX_B, 3)])).toThrow(
      new RegExp(`${TX_A}#0, ${TX_B}#3`),
    );
  });

  it('refuses a transaction id with no output index instead of assuming output 0', () => {
    // The exact silent reading this replaced.
    expect(() => selectPositionToUnstake([position(TX_A, 0), position(TX_A, 1)], { txHash: TX_A })).toThrow(
      /BOTH positionTxHash and positionOutputIndex/,
    );
  });

  it('refuses an output index with no transaction id', () => {
    expect(() => selectPositionToUnstake([position(TX_A, 0), position(TX_A, 1)], { outputIndex: 1 })).toThrow(
      /BOTH positionTxHash and positionOutputIndex/,
    );
  });

  it('treats index 0 as a real index, not as an absent one', () => {
    // `0` is falsy, so a truthiness check here would read a legitimate index
    // as "not supplied" and fall through to the single-position convenience —
    // which would then close a position on a wallet holding several.
    expect(() => selectPositionToUnstake([position(TX_A, 0), position(TX_B, 0)], { outputIndex: 0 })).toThrow(
      /BOTH positionTxHash and positionOutputIndex/,
    );
    expect(selectPositionToUnstake([position(TX_A, 5), position(TX_B, 0)], { txHash: TX_B, outputIndex: 0 })).toEqual(
      position(TX_B, 0),
    );
  });

  it('reports a reference matching nothing, with what the wallet actually holds', () => {
    expect(() => selectPositionToUnstake([position(TX_A, 0)], { txHash: TX_B, outputIndex: 2 })).toThrow(
      new RegExp(`No staking position at ${TX_B}#2 .*It holds: ${TX_A}#0`),
    );
  });

  it('reports an empty wallet as an empty wallet, whatever was asked for', () => {
    expect(() => selectPositionToUnstake([])).toThrow(/No staking positions found/);
    expect(() => selectPositionToUnstake([], { txHash: TX_A, outputIndex: 0 })).toThrow(/No staking positions found/);
  });
});
