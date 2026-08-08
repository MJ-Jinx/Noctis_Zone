// reference-script-reclaimer.test.ts
//
// This module exists to spend reference scripts, which destroys them. That is
// correct for a superseded one and catastrophic for a live one: every launch
// pointing at it breaks, silently, with the transaction succeeding and nothing
// to undo it with.
//
// So the tests worth having are all one question — can a live script be
// reclaimed, by any route? The live set is derived from the blueprint rather
// than supplied, so a caller cannot ask for one by mistake or otherwise.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyCborEncoding, type UTxO as MeshUTxO } from '@meshsdk/core';
import { describe, expect, it } from 'vitest';
import {
  currentScriptHashes,
  findReferenceScripts,
  reclaimable,
  reclaimableLovelace,
} from '../reference-script-reclaimer.js';

const blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
) as { validators: Array<{ title: string; compiledCode: string; hash: string }> };

const TIER_A = blueprint.validators.find((v) => v.title === 'bonding_curve.bonding_curve.spend');
const TIER_B = blueprint.validators.find((v) => v.title === 'bonding_curve_tier_b.bonding_curve_tier_b.spend');
if (!TIER_A || !TIER_B) throw new Error('blueprint is missing a curve');

const ADDRESS = 'addr_test1vqv30h5jmt0ml909e385tptgfvrqqu82k5mtjzgvwu0xfrcrkkaws';

function utxo(txHash: string, lovelace: string, scriptRef?: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: 0 },
    output: {
      address: ADDRESS,
      amount: [{ unit: 'lovelace', quantity: lovelace }],
      ...(scriptRef ? { scriptRef } : {}),
    },
  };
}

/** A script that is not any validator this build produces. */
const SUPERSEDED = applyCborEncoding('590001');

describe('currentScriptHashes', () => {
  it('covers every validator in the blueprint', () => {
    const modules = new Set(blueprint.validators.map((v) => v.title.split('.')[0]));
    expect(new Set(currentScriptHashes(blueprint.validators).values())).toEqual(modules);
  });

  // Derived, not read from the blueprint's own recorded hash: the question is
  // what THIS build compiles to, and a stale recorded hash would let a live
  // script be reclaimed.
  it('agrees with the hash the blueprint recorded', () => {
    const hashes = currentScriptHashes(blueprint.validators);
    expect(hashes.has(TIER_A.hash.toLowerCase())).toBe(true);
    expect(hashes.has(TIER_B.hash.toLowerCase())).toBe(true);
  });
});

describe('findReferenceScripts', () => {
  it('ignores UTXOs that carry no script', () => {
    expect(findReferenceScripts([utxo('aa'.repeat(32), '500000000')], blueprint.validators)).toEqual([]);
  });

  it('marks a live curve as current, and names it', () => {
    const found = findReferenceScripts(
      [utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode))],
      blueprint.validators,
    );
    expect(found[0]?.isCurrent).toBe(true);
    expect(found[0]?.module).toBe('bonding_curve_tier_b');
  });

  it('marks a script no validator compiles to as superseded', () => {
    const found = findReferenceScripts([utxo('bb'.repeat(32), '5000000', SUPERSEDED)], blueprint.validators);
    expect(found[0]?.isCurrent).toBe(false);
    expect(found[0]?.module).toBeUndefined();
  });
});

describe('what may be spent', () => {
  // The one that matters. A live script in the same wallet, holding the same
  // amount, at the same address — everything a selection could match on is
  // identical, and only the script tells them apart.
  it('never returns a live validator, however it is mixed in', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('bb'.repeat(32), '75000000', SUPERSEDED),
        utxo('cc'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode)),
      ],
      blueprint.validators,
    );
    const safe = reclaimable(found);
    expect(safe).toHaveLength(1);
    expect(safe[0]?.txHash).toBe('bb'.repeat(32));
  });

  it('returns nothing at all when every script is live', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('cc'.repeat(32), '75000000', applyCborEncoding(TIER_B.compiledCode)),
      ],
      blueprint.validators,
    );
    expect(reclaimable(found)).toEqual([]);
    expect(reclaimableLovelace(found)).toBe(0n);
  });

  it('refuses every validator the blueprint holds, not only the curves', () => {
    const all = blueprint.validators.map((v, i) =>
      utxo(i.toString(16).padStart(2, '0').repeat(32), '30000000', applyCborEncoding(v.compiledCode)),
    );
    expect(reclaimable(findReferenceScripts(all, blueprint.validators))).toEqual([]);
  });

  it('totals only what it would actually spend', () => {
    const found = findReferenceScripts(
      [
        utxo('aa'.repeat(32), '75000000', applyCborEncoding(TIER_A.compiledCode)),
        utxo('bb'.repeat(32), '55000000', SUPERSEDED),
        utxo('dd'.repeat(32), '5000000', applyCborEncoding('590002')),
      ],
      blueprint.validators,
    );
    expect(reclaimableLovelace(found)).toBe(60_000_000n);
  });
});
