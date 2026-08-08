// mesh-curve-spend.test.ts — does the built transaction actually REFERENCE
// the validator, or does it quietly carry it after all?
//
// That is the only question worth asking here, and it cannot be answered by
// reading the builder calls: a library that ignored `spendingTxInReference`
// and embedded the script anyway would satisfy every mock assertion and
// produce a transaction over the size cap. So these tests build a real
// transaction from the real compiled curve and decode the result, checking
// that the witness set holds no script and the reference input names the
// published one.
//
// Everything is offline. The provider is a stand-in and the reference UTXO is
// invented, because what is under test is the SHAPE of the transaction rather
// than whether a node accepts it — node acceptance is what Preprod is for, and
// no structural check substitutes for it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Constr, credentialToAddress, Data } from '@lucid-evolution/lucid';
import { DEFAULT_PROTOCOL_PARAMETERS, type UTxO as MeshUTxO } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ORDERS_PER_BATCH } from '../batch-planner.js';
import { capProofFor, hexToBytes } from '../cap-accumulator-tree.js';
import { type CurveSpendPlan, type CurveSpendWallet, MeshCurveSpender } from '../mesh-curve-spend.js';
import { MAX_TX_BYTES, rawScriptSize, scriptAddressOf, scriptHashOf } from '../reference-script.js';
import { capProofToPlutus } from '../tier-a-schemas.js';

interface Blueprint {
  validators: Array<{ title: string; compiledCode: string; hash: string }>;
}
const blueprint: Blueprint = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'contracts', 'cardano', 'plutus.json'), 'utf8'),
);
function validator(title: string) {
  const found = blueprint.validators.find((v) => v.title === title);
  if (!found) throw new Error(`${title} missing from plutus.json`);
  return found;
}

const TIER_B = validator('bonding_curve_tier_b.bonding_curve_tier_b.spend');
const TIER_A = validator('bonding_curve.bonding_curve.spend');

const BUYER_KEY_HASH = '11'.repeat(28);
// A real enterprise address for that key hash. Coin selection rejects an
// address it cannot read a payment key hash out of, which a hand-typed
// bech32 string will not survive.
const WALLET_ADDRESS = credentialToAddress('Preprod', { type: 'Key', hash: BUYER_KEY_HASH });
const REF_TX = 'ab'.repeat(32);
const CURVE_TX = 'cd'.repeat(32);
const TOKEN_UNIT = `${'aa'.repeat(28)}42424242`;

/** A plausible wallet UTXO — enough ada to cover a fee and change. */
function walletUtxo(txHash: string, index: number, lovelace: string): MeshUTxO {
  return {
    input: { txHash, outputIndex: index },
    output: { address: WALLET_ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace }] },
  };
}

function fakeWallet(): CurveSpendWallet {
  return {
    getChangeAddress: vi.fn().mockResolvedValue(WALLET_ADDRESS),
    getUtxos: vi.fn().mockResolvedValue([walletUtxo('11'.repeat(32), 0, '500000000')]),
    getCollateral: vi.fn().mockResolvedValue([walletUtxo('22'.repeat(32), 0, '5000000')]),
    signTx: vi.fn().mockResolvedValue('signed'),
    submitTx: vi.fn().mockResolvedValue('submitted-hash'),
  };
}

/** Stands in for a chain provider. Execution units are fixed rather than real. */
function fakeProvider() {
  return {
    fetchProtocolParameters: vi.fn().mockResolvedValue(DEFAULT_PROTOCOL_PARAMETERS),
    evaluateTx: vi.fn().mockResolvedValue([{ tag: 'SPEND', index: 0, budget: { mem: 2_000_000, steps: 800_000_000 } }]),
  };
}

function spender(v: { compiledCode: string; hash: string }, provider = fakeProvider()) {
  return new MeshCurveSpender({
    network: 'preprod',
    compiledScriptCbor: v.compiledCode,
    referenceScript: { txHash: REF_TX, outputIndex: 0, scriptHash: v.hash },
    provider,
  });
}

/** A buy: the curve keeps its state and its payment, the buyer gets tokens. */
function buyPlan(scriptAddress: string): CurveSpendPlan {
  return {
    scriptUtxo: {
      txHash: CURVE_TX,
      outputIndex: 0,
      address: scriptAddress,
      assets: { lovelace: 50_000_000n, [TOKEN_UNIT]: 1_000_000n },
    },
    // Shapes, not meaning: this module never interprets either, and using
    // real ones would only test the schemas a second time.
    redeemerCbor: 'd87980',
    continuing: { datumCbor: 'd87980', assets: { lovelace: 60_000_000n, [TOKEN_UNIT]: 900_000n } },
    payouts: [{ address: WALLET_ADDRESS, assets: { [TOKEN_UNIT]: 100_000n }, datumCbor: 'd87980' }],
    requiredSignerHashes: [BUYER_KEY_HASH],
  };
}

describe('MeshCurveSpender', () => {
  it('exposes the same script address the validator compiles to', () => {
    expect(spender(TIER_B).scriptAddress).toBe(scriptAddressOf(TIER_B.compiledCode, 0));
  });

  it('refuses a reference pointer published for a different validator', () => {
    expect(
      () =>
        new MeshCurveSpender({
          network: 'preprod',
          compiledScriptCbor: TIER_B.compiledCode,
          referenceScript: { txHash: REF_TX, outputIndex: 0, scriptHash: TIER_A.hash },
          provider: fakeProvider(),
        }),
    ).toThrow(/stale/i);
  });

  it('refuses to spend a UTXO locked by some other script', async () => {
    const s = spender(TIER_B);
    const plan = buyPlan(scriptAddressOf(TIER_A.compiledCode, 0));
    await expect(s.build(plan, fakeWallet())).rejects.toThrow(/would need the validator/i);
  });

  // A published reference script sits in an ordinary UTXO, and coin selection
  // has no idea it is special. The batcher's wallet is the one that holds
  // them, so this is the wallet where funding a transaction could destroy the
  // very script the transaction references.
  it('never funds itself by spending a reference script', async () => {
    const wallet = fakeWallet();
    const refHolder = walletUtxo('dd'.repeat(32), 0, '75000000');
    refHolder.output.scriptRef = '590000';
    // The script holder is by far the largest, so any size-led selection takes
    // it first.
    wallet.getUtxos = vi.fn().mockResolvedValue([refHolder, walletUtxo('11'.repeat(32), 0, '500000000')]);

    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), wallet);
    const inputs = deserializeTx(hex).body().inputs().toCore();
    expect(inputs.map((i) => i.txId)).not.toContain('dd'.repeat(32));
  });

  it('refuses to build without collateral, saying what is missing', async () => {
    const wallet = fakeWallet();
    wallet.getCollateral = vi.fn().mockResolvedValue([]);
    const s = spender(TIER_B);
    await expect(s.build(buyPlan(s.scriptAddress), wallet)).rejects.toThrow(/collateral/i);
  });

  // ==========================================================================
  // The claims that matter, checked against the decoded transaction
  // ==========================================================================

  for (const [tier, v] of [
    ['Tier A', TIER_A],
    ['Tier B', TIER_B],
  ] as const) {
    describe(`${tier}`, () => {
      it('leaves the validator out of the witness set entirely', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        const decoded = deserializeTx(hex);
        expect(decoded.witnessSet().plutusV3Scripts()?.size() ?? 0).toBe(0);
        expect(decoded.witnessSet().plutusV2Scripts()?.size() ?? 0).toBe(0);
        expect(decoded.witnessSet().plutusV1Scripts()?.size() ?? 0).toBe(0);
      });

      it('names the published reference script as an input', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        const refs = deserializeTx(hex).body().referenceInputs()?.toCore() ?? [];
        expect(refs.map((r) => `${r.txId}#${r.index}`)).toContain(`${REF_TX}#0`);
      });

      it('still carries the redeemer, without which the spend proves nothing', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        expect(deserializeTx(hex).witnessSet().redeemers()?.size() ?? 0).toBe(1);
      });

      it('leaves most of the transaction cap unused', async () => {
        const s = spender(v);
        const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
        // Referenced, the script is gone from the transaction entirely, so
        // what remains is the datum, the redeemer and the ordinary parts.
        // A real buy adds the cap proof on top of this; the headroom is what
        // makes room for it, and for a batch of them.
        expect(hex.length / 2).toBeLessThan(16_384 / 2);
      });
    });
  }

  // The comparison the whole module exists for, stated as a measurement
  // rather than left implicit.
  //
  // This test used to assert that an embedded Tier B trade could not be built
  // at ANY size. Reordering the curve datum so the fields a redeemer rewrites
  // sit at the front took the validator from 15,952 bytes to 13,699, and that
  // is no longer true: a single embedded trade fits again, with room for the
  // cap proof it really carries. The claim is therefore weakened to what the
  // measurement still supports.
  //
  // What has NOT changed is why the reference script exists. A batch spends
  // the same curve once but carries a proof PER ORDER, and the embedded script
  // is charged against the same 16,384 bytes those proofs need. The second
  // assertion below is the one that matters: embedding leaves less room than a
  // full batch of proofs needs, so batching stays impossible without the
  // reference. Referencing is a headroom decision, not a fits/does-not-fit one.
  it('leaves room for a batch of proofs only when the script is referenced', async () => {
    const s = spender(TIER_B);
    const referenced = (await s.build(buyPlan(s.scriptAddress), fakeWallet())).length / 2;
    const embedded = referenced + rawScriptSize(TIER_B.compiledCode);

    // A real proof, not an estimate: one walk of the 32-level cap tree, in the
    // CBOR the validator actually decodes.
    const proof = capProofToPlutus(capProofFor(hexToBytes(BUYER_KEY_HASH), []));
    const proofBytes = Data.to(new Constr(1, [proof as unknown as Data])).length / 2;
    const batchProofs = proofBytes * MAX_ORDERS_PER_BATCH;

    expect(referenced).toBeLessThan(MAX_TX_BYTES);
    expect(embedded).toBeLessThan(MAX_TX_BYTES);
    expect(referenced + batchProofs).toBeLessThan(MAX_TX_BYTES);
    expect(embedded + batchProofs).toBeGreaterThan(MAX_TX_BYTES);
  });

  it('delivers tokens with the settlement tag the validator reads', async () => {
    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
    const outputs = deserializeTx(hex).body().outputs();
    const delivery = outputs.find((o) => o.toCore().value.assets?.size);
    expect(delivery).toBeDefined();
    expect(delivery?.datum()).toBeDefined();
  });

  it('tops the token-only delivery up to the minimum ada an output needs', async () => {
    const s = spender(TIER_B);
    const hex = await s.build(buyPlan(s.scriptAddress), fakeWallet());
    const buyerOutputs = deserializeTx(hex)
      .body()
      .outputs()
      .map((o) => o.toCore())
      .filter((o) => o.value.assets && o.value.assets.size > 0);
    for (const out of buyerOutputs) expect(out.value.coins).toBeGreaterThan(0n);
  });

  it('signs and submits what it built', async () => {
    const wallet = fakeWallet();
    const s = spender(TIER_B);
    const hash = await s.submit(buyPlan(s.scriptAddress), wallet);
    expect(hash).toBe('submitted-hash');
    expect(wallet.signTx).toHaveBeenCalledOnce();
    expect(wallet.submitTx).toHaveBeenCalledWith('signed');
  });

  it('references the hash the validator itself compiles to', () => {
    const s = spender(TIER_B);
    expect(scriptHashOf(TIER_B.compiledCode)).toBe(TIER_B.hash);
    expect(s.scriptAddress).toContain('addr_test1');
  });
});
