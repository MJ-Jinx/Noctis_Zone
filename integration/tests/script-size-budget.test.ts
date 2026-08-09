// script-size-budget.test.ts — compiled validator sizes, measured.
//
// Cardano caps a transaction at 16,384 bytes, and a validator spent with
// Lucid Evolution is EMBEDDED in the witness set rather than referenced: the
// library always calls `PlutusScriptWitness.new_script`, so `readFrom` cannot
// make a spend use a published reference script. A validator's compiled size
// is therefore charged in full against that cap, once per validator a
// transaction spends.
//
// That budget had no test. Sizes have grown steadily — thread NFTs, the cap
// accumulator, value conservation, settlement tags — and each change was
// individually small enough not to prompt a measurement. This records the
// current figures so the next change has to acknowledge its cost, and fails
// loudly if one crosses the cap on its own.
//
// These are recorded values, not targets. When a change moves one, update the
// number in the same commit — the point is that it becomes a visible decision
// rather than a silent drift.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PUBLISHABLE_SCRIPT_BYTES, MAX_TX_BYTES } from '../reference-script.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string }>;
}

const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);

/** Compiled size in bytes, keyed by validator module. */
const sizes = new Map<string, number>();
for (const v of blueprint.validators) {
  const module = v.title.split('.')[0];
  if (module) sizes.set(module, v.compiledCode.length / 2);
}

/**
 * Measured 2026-08-08. Update in the same commit that moves one.
 *
 * Last moved by ordering both curve datums so the fields a redeemer REWRITES
 * are declared before the fields only read: Tier A −1,258, Tier B −2,253, and
 * token_metadata +27 because it reads Tier A's datum and its fields moved
 * back. A record update walks the field list to reach what it replaces, so
 * cost scales with the updated field's index — measured at ~10.5 bytes of
 * script per index position per update site, against ~0.15 for a read, which
 * is why paying 27 bytes of reads to save 3,511 of updates is the right trade.
 * No behaviour changed; the datum encoding is positional, so
 * integration/tier-a-schemas.ts moved with it.
 *
 * Before that, refusing a graduation output that carries a staking
 * credential: Tier A +43, Tier B +44. `Graduate` is permissionless, so without
 * it whoever submits one chooses where the locked LP delegates for a year.
 *
 * Before that, binding an order's payout to the owner's OWN address rather
 * than their payment credential alone: `curve_order` +73, to carry the staking
 * part of that address and match on the whole of it. That buys two things — a
 * fill an ordinary wallet can actually spend, and a payout a batcher cannot
 * redirect to a staking credential of its own.
 *
 * Before that, the batch fixes: both curves and the order validator grew so
 * that a batched fill names the order it settles, and so that a batch verifies
 * the curve's own value moved by what it claims. Tier A +169, Tier B +174,
 * curve_order +196 — paid knowingly, and partly bought back by routing the
 * batch's value check through the two helpers a single trade already uses.
 * Most recently, cto_governance +761: AnchorVoteResult now reads the launch's
 * LP escrow UTXO as a reference input to learn when it graduated, so it
 * carries the escrow datum's decoder. That is what the size buys — a ballot
 * that cannot claim a window opening before the launch was eligible to hold
 * one. Well inside the 16,384 B cap; recorded here so the growth is a
 * decision rather than a surprise.
 */
const RECORDED: Record<string, number> = {
  bonding_curve: 10_904,
  bonding_curve_tier_b: 13_709,
  cto_governance: 7_370,
  cto_sybil_challenge: 1_294,
  curve_order: 1_775,
  launch_token_policy: 419,
  lp_escrow: 7_201,
  nhop_challenge: 1_274,
  staking_pool: 3_860,
  token_metadata: 4_458,
  vesting: 5_737,
  zk_anchor: 2_634,
};

describe('compiled validator sizes', () => {
  it('has a recorded size for every validator in the blueprint', () => {
    expect([...sizes.keys()].sort()).toEqual(Object.keys(RECORDED).sort());
  });

  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} is ${recorded} bytes`, () => {
      expect(sizes.get(module)).toBe(recorded);
    });
  }

  // A validator larger than the whole transaction cap cannot be spent at all
  // by a library that embeds it, whatever else the transaction contains.
  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} fits inside one transaction on its own`, () => {
      expect(recorded).toBeLessThan(MAX_TX_BYTES);
    });
  }

  // The harder ceiling, and now the binding one. Referencing a script lifts
  // the SPENDING budget, but the script has to be PUBLISHED first — by an
  // ordinary transaction bound by the same cap, serialising the script whole
  // into one output. That cannot be split. Tier B has been over this line
  // before and is the closest to it now, so it gets a test rather than a note.
  for (const [module, recorded] of Object.entries(RECORDED)) {
    it(`${module} is small enough to publish as a reference script`, () => {
      expect(recorded).toBeLessThanOrEqual(MAX_PUBLISHABLE_SCRIPT_BYTES);
    });
  }
});
