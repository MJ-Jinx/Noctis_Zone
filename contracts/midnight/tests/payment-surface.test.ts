// Which circuits actually move money — read out of the compiled contract.
//
// WHY THIS EXISTS
// Every payment in these contracts is a `receiveUnshielded` or
// `sendUnshielded` call, and none of them was verified by anything. The local
// simulator does not model cross-transaction coin matching, which several
// tests say plainly — but the consequence was broader than "we cannot check
// the amounts": nothing checked the calls were there at all. Each of the nine
// `receiveUnshielded` calls in this codebase was deleted in turn and all 379
// tests still passed, every time. A contract that had quietly stopped taking
// payment was indistinguishable from one that took it.
//
// This closes that within the simulator's limits. The compiled contract keeps
// each circuit as its own method and each payment as a `this._receiveUnshielded_0(...)`
// call inside it, so the compiled output can be asked which circuits move
// money. That is a fact about what will run, not about a fixture.
//
// Payouts are covered too, and for the same reason in reverse: a dropped
// `sendUnshielded` leaves funds that can never leave the contract, which is
// the shape of every fund-lock this codebase has had.
//
// What this does NOT do: check an amount, a recipient, or that a real coin
// changed hands — those need a devnet. It checks the thing whose absence was
// previously invisible.
//
// When a circuit legitimately gains or loses a payment, update the table in
// the same commit. The point is that it becomes a decision rather than a
// silent drift, the same convention as the Cardano script-size budget.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CONTRACTS = [
  'bonding_curve',
  'cto_governance',
  'creator_escrow',
  'eligibility_gate',
  'lp_escrow',
  'staking_pool',
  'treasury',
  'vesting',
] as const;

/** Measured from the compiled output. Anything absent takes no payment in. */
const RECEIVES: Record<string, string[]> = {
  bonding_curve: ['buyTokens', 'registerForDarkVeil', 'revealBuyCommit'],
  cto_governance: ['bondedSilenceChallenge', 'createProposal'],
  creator_escrow: ['depositFees'],
  eligibility_gate: ['registerForDarkVeil'],
  lp_escrow: [],
  staking_pool: ['claimRewards'],
  treasury: ['depositFees'],
  vesting: [],
};

/** Measured the same way. Anything absent pays nothing out. */
const SENDS: Record<string, string[]> = {
  bonding_curve: [
    'claimBondRefund',
    'claimCurveRefund',
    'claimDisputedBond',
    'claimRatioBondRefund',
    'graduateLp',
    'withdrawFees',
  ],
  cto_governance: ['claimBreakGlassBondRefund', 'claimProposalBond', 'sweepForfeitedProposalBond'],
  creator_escrow: ['claimByCommunity', 'claimFees', 'claimRemainingEscrowByCommunity'],
  eligibility_gate: ['claimBondRefund', 'claimDisputedBond', 'claimRatioBondRefund', 'sweepForfeitedBond'],
  lp_escrow: [],
  staking_pool: ['claimRewards'],
  treasury: ['withdrawFees'],
  vesting: [],
};

function compiled(contract: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'compiled', contract, 'contract', 'index.js'), 'utf8');
}

/**
 * The circuits in `contract` whose compiled body calls `op`.
 *
 * Compiled methods sit at a fixed indent, so the next one bounds this one's
 * body. EVERY method has to delimit, not just the circuits: the compiler
 * emits helpers (`_equal_0`, `_left_0`, `_nativeToken_0`) between them, and
 * skipping those makes a slice run past its own circuit and attribute a call
 * to whichever circuit preceded it. That is not a hypothetical — the first
 * version of this file did exactly that, and reported payments in
 * `checkSilenceLock` and `getProposalCount`, which take none.
 */
function circuitsCalling(contract: string, op: 'receiveUnshielded' | 'sendUnshielded'): string[] {
  const src = compiled(contract);
  const method = /\n {2}_([A-Za-z0-9]+)_\d+\(/g;
  const starts: Array<{ name: string; at: number }> = [];
  let m = method.exec(src);
  while (m !== null) {
    starts.push({ name: m[1] as string, at: m.index });
    m = method.exec(src);
  }

  const found = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    if (!start || start.name === op) continue; // the helper's own definition
    const end = starts[i + 1]?.at ?? src.length;
    if (src.slice(start.at, end).includes(`this._${op}_0(`)) found.add(start.name);
  }
  return [...found].sort();
}

describe('payment surface — which circuits move money', () => {
  for (const contract of CONTRACTS) {
    const expected = (RECEIVES[contract] ?? []).slice().sort();
    it(`${contract} takes payment IN in exactly: ${expected.join(', ') || '(none)'}`, () => {
      expect(circuitsCalling(contract, 'receiveUnshielded')).toEqual(expected);
    });
  }

  for (const contract of CONTRACTS) {
    const expected = (SENDS[contract] ?? []).slice().sort();
    it(`${contract} pays OUT in exactly: ${expected.join(', ') || '(none)'}`, () => {
      expect(circuitsCalling(contract, 'sendUnshielded')).toEqual(expected);
    });
  }

  it('the reader tells a paying circuit from a non-paying one', () => {
    // Every assertion above would also be satisfied by a reader that always
    // returned nothing — which is precisely the failure this file exists to
    // stop being invisible, so it gets its own check.
    expect(circuitsCalling('treasury', 'receiveUnshielded')).toContain('depositFees');
    expect(circuitsCalling('treasury', 'receiveUnshielded')).not.toContain('getAdaBalance');
    expect(circuitsCalling('treasury', 'sendUnshielded')).toEqual(['withdrawFees']);
  });

  it('accounts for every payment-in call in the codebase, not just some', () => {
    // Nine. If a tenth appears in a circuit nobody added to the table, the
    // per-contract assertions catch it — this catches the reverse mistake of
    // the reader silently finding fewer than exist.
    const total = CONTRACTS.reduce((n, c) => n + circuitsCalling(c, 'receiveUnshielded').length, 0);
    expect(total).toBe(9);
  });
});
