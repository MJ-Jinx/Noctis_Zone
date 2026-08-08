// cap-accumulator-from-history.test.ts
//
// This rebuilds off-chain state that a validator will check a Merkle proof
// against, so "close enough" does not exist: a total that is wrong by one
// produces a proof that fails with nothing to point at.
//
// The tests that matter are therefore about AGREEING WITH THE VALIDATOR —
// which actions move a total, in which direction, and in what order — rather
// than about the fold's mechanics.

import { Constr } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { capAccumulatorFromHistory, deltasOf, rebuildCapAccumulator } from '../cap-accumulator-from-history.js';
import { bytesToHex, CapAccumulator, hexToBytes } from '../cap-accumulator-tree.js';
import type { TradeEvent } from '../tier-a-trade-history-reader.js';

const ALICE = 'aa'.repeat(28);
const BOB = 'bb'.repeat(28);

function event(action: string, fields: Record<string, string>, raw?: Constr<unknown>): TradeEvent {
  return {
    txHash: 'ff'.repeat(32),
    blockTime: 0,
    contract: 'bonding_curve',
    action,
    isCreatorAction: false,
    isCreatorTrade: false,
    fields,
    ...(raw ? { raw } : {}),
  };
}

/** Aiken encodes Bool as a constructor: index 1 is True. */
const TRUE = new Constr(1, []);
const FALSE = new Constr(0, []);

/** A `BatchOrder`: owner, order_ref, is_buy, amount, min_received, before, proof. */
function batchOrder(owner: string, isBuy: boolean, amount: bigint): Constr<unknown> {
  return new Constr(0, [owner, new Constr(0, ['ab'.repeat(32), 0n]), isBuy ? TRUE : FALSE, amount, 0n, 0n, []]);
}

function batch(...orders: Constr<unknown>[]): TradeEvent {
  return event('BatchTrades', {}, new Constr(12, [orders]));
}

describe('which actions move a wallet’s total', () => {
  it('a buy adds to the buyer', () => {
    expect(deltasOf(event('BuyTokens', { buyer_key_hash: ALICE, token_amount: '500' }))).toEqual([
      { keyHashHex: ALICE, delta: 500n },
    ]);
  });

  it('a sell subtracts from the seller', () => {
    expect(deltasOf(event('SellTokens', { seller_key_hash: ALICE, token_amount: '200' }))).toEqual([
      { keyHashHex: ALICE, delta: -200n },
    ]);
  });

  it('a DarkVeil claim adds, because it draws on the same allowance a buy does', () => {
    expect(deltasOf(event('ClaimDarkVeilTokens', { buyer_key_hash: BOB, token_amount: '100' }))).toEqual([
      { keyHashHex: BOB, delta: 100n },
    ]);
  });

  // The one that is easy to get wrong by being helpful. A buyback returns
  // tokens to a cancelled curve and the validator leaves cap_root alone;
  // "correcting" for it here would put every later rebuild out of step.
  it('a buyback moves nothing, because the curve does not move it either', () => {
    expect(deltasOf(event('ClaimBuyback', { buyer_key_hash: ALICE, token_amount: '300' }))).toEqual([]);
  });

  it('a fee claim moves nothing', () => {
    expect(deltasOf(event('ClaimCreatorFees', { amount: '1000' }))).toEqual([]);
  });
});

describe('a batch', () => {
  // A batch's orders live in a LIST inside the redeemer. The display view of
  // the fields stringifies that whole list, so a fold reading `fields` sees one
  // opaque blob and silently credits nobody — which is why `raw` exists.
  it('moves every owner it names, not just the first', () => {
    expect(deltasOf(batch(batchOrder(ALICE, true, 100n), batchOrder(BOB, true, 250n)))).toEqual([
      { keyHashHex: ALICE, delta: 100n },
      { keyHashHex: BOB, delta: 250n },
    ]);
  });

  it('reads a sell inside a batch as a subtraction', () => {
    expect(deltasOf(batch(batchOrder(ALICE, false, 40n)))).toEqual([{ keyHashHex: ALICE, delta: -40n }]);
  });

  it('credits one owner twice when they hold two orders in the batch', () => {
    const acc = capAccumulatorFromHistory([batch(batchOrder(ALICE, true, 100n), batchOrder(ALICE, true, 100n))]);
    expect(acc.totalOf(hexToBytes(ALICE))).toBe(200n);
  });

  it('contributes nothing without the raw redeemer, rather than guessing', () => {
    expect(deltasOf(event('BatchTrades', { orders: '[object]' }))).toEqual([]);
  });
});

describe('the running total', () => {
  it('matches an accumulator built by applying the same trades directly', () => {
    const fromHistory = capAccumulatorFromHistory([
      event('BuyTokens', { buyer_key_hash: ALICE, token_amount: '500' }),
      event('BuyTokens', { buyer_key_hash: BOB, token_amount: '300' }),
      event('SellTokens', { seller_key_hash: ALICE, token_amount: '200' }),
      batch(batchOrder(BOB, true, 50n)),
    ]);

    const direct = new CapAccumulator();
    direct.apply(hexToBytes(ALICE), 500n);
    direct.apply(hexToBytes(BOB), 300n);
    direct.apply(hexToBytes(ALICE), -200n);
    direct.apply(hexToBytes(BOB), 50n);

    expect(bytesToHex(fromHistory.root)).toBe(bytesToHex(direct.root));
    expect(fromHistory.totalOf(hexToBytes(ALICE))).toBe(300n);
  });

  // A sell floors at zero rather than going negative, so the same events in a
  // different order genuinely give a different answer. Order is not a detail.
  it('floors a sell at zero, exactly as the validator does', () => {
    const acc = capAccumulatorFromHistory([
      event('BuyTokens', { buyer_key_hash: ALICE, token_amount: '100' }),
      event('SellTokens', { seller_key_hash: ALICE, token_amount: '400' }),
    ]);
    expect(acc.totalOf(hexToBytes(ALICE))).toBe(0n);
  });
});

describe('rebuilding against the curve’s own root', () => {
  const history = [event('BuyTokens', { buyer_key_hash: ALICE, token_amount: '500' })];
  const source = { getCurveTradeHistory: async () => history };

  it('returns the accumulator when it derives the root the datum carries', async () => {
    const expected = new CapAccumulator();
    expected.apply(hexToBytes(ALICE), 500n);
    const acc = await rebuildCapAccumulator(source, bytesToHex(expected.root));
    expect(acc.totalOf(hexToBytes(ALICE))).toBe(500n);
  });

  // The check is the whole safety of this module: a rebuild is a claim about
  // history, and only the datum can say whether the claim is right.
  it('refuses a rebuild the curve disagrees with, naming both roots', async () => {
    const wrong = bytesToHex(new CapAccumulator().root);
    await expect(rebuildCapAccumulator(source, wrong)).rejects.toThrow(new RegExp(wrong));
  });
});
