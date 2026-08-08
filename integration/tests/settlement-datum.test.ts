// settlement-datum.test.ts — the tag every payout output carries.
//
// A payout matched on recipient and amount alone is matched by whatever else
// pays that recipient that amount, including another contract's payout. The
// tag is what makes an output name the obligation it discharges, so its
// encoding has to be exactly what the validators read: `Constr 0 [Bytes, Int]`,
// transaction id first. The schema-drift guard checks the shape against the
// blueprint; these check the bytes we actually emit.

import { type Constr, Data } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';

import { type OutputReferenceData, OutputReferenceSchema, settlementDatum } from '../tier-a-schemas.js';

const TX = 'ab'.repeat(32);

describe('settlementDatum', () => {
  it('encodes as constructor 0 with the transaction id first and the index second', () => {
    const decoded = Data.from(settlementDatum({ txHash: TX, outputIndex: 3 })) as Constr<unknown>;
    expect(decoded.index).toBe(0);
    expect(decoded.fields).toEqual([TX, 3n]);
  });

  it('round-trips through the schema', () => {
    const back = Data.from<OutputReferenceData>(settlementDatum({ txHash: TX, outputIndex: 7 }), OutputReferenceSchema);
    expect(back.transaction_id).toBe(TX);
    expect(back.output_index).toBe(7n);
  });

  it('gives a different tag for every output index of one transaction', () => {
    const zero = settlementDatum({ txHash: TX, outputIndex: 0 });
    const one = settlementDatum({ txHash: TX, outputIndex: 1 });
    expect(zero).not.toBe(one);
  });

  it('gives a different tag for the same index of two transactions', () => {
    const a = settlementDatum({ txHash: TX, outputIndex: 0 });
    const b = settlementDatum({ txHash: 'cd'.repeat(32), outputIndex: 0 });
    expect(a).not.toBe(b);
  });

  // Index 0 is the case a missing field silently becomes, so it has to encode
  // as a real zero rather than as nothing.
  it('encodes index 0 explicitly', () => {
    const decoded = Data.from(settlementDatum({ txHash: TX, outputIndex: 0 })) as Constr<unknown>;
    expect(decoded.fields).toEqual([TX, 0n]);
  });

  // A UTXO reference is not optional. Building a payout from a fixture that
  // never had one would otherwise produce a datum no validator accepts, and
  // the failure would surface only against a real node.
  it('refuses a reference with no output index rather than guessing one', () => {
    expect(() => settlementDatum({ txHash: TX } as never)).toThrow();
  });
});
