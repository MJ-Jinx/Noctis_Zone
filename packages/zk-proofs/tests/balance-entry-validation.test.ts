// A snapshot entry missing a field is refused by name, not by WASM.
//
// WHY THIS EXISTS
// The balance-snapshot tree decides voting weight in a CTO ballot, and its
// leaves are hashed through the on-chain runtime. Hand that hash a value that
// is absent rather than a bigint and it fails inside a WASM conversion with
// `TypeError: Cannot read properties of undefined (reading 'toString')` —
// naming no field, no entry, and no caller.
//
// That is not hypothetical. When `heldSinceTimestamp` was added to the leaf
// for the holding-period rule, one caller was not updated to pass it, and the
// resulting failure was recorded as an unexplained red test on the voting-
// weight path and left for eleven days. The type system did flag that
// particular caller — but types do not survive the JSON boundary these
// entries are actually assembled across, and the error they fall back to is
// undebuggable.
//
// So the builder checks the three fields before hashing any of them. These
// tests pin each field's own message, because a guard that throws the same
// sentence for every field would be no better than the one it replaced.

import { describe, expect, it } from 'vitest';
import { buildBalanceSnapshotTree } from '../src/cto-governance.js';

const VOTER_KEY = new Uint8Array(32).fill(7);

function entry(overrides: Record<string, unknown> = {}) {
  return {
    voterKey: VOTER_KEY,
    balance: 1_000n,
    heldSinceTimestamp: 1_775_000_000_000n,
    ...overrides,
  } as { voterKey: Uint8Array; balance: bigint; heldSinceTimestamp: bigint };
}

describe('buildBalanceSnapshotTree — entry validation', () => {
  it('builds normally when every field is present', () => {
    const tree = buildBalanceSnapshotTree([entry(), entry({ balance: 2_000n })]);
    expect(tree.root).toHaveLength(32);
    expect(tree.getProof(0)).toHaveLength(20);
  });

  it('names heldSinceTimestamp when it is missing — the field that actually caused this', () => {
    // Exactly the shape the un-updated caller produced: the property absent
    // from the object literal entirely.
    const broken = { voterKey: VOTER_KEY, balance: 1_000n } as unknown as ReturnType<typeof entry>;
    expect(() => buildBalanceSnapshotTree([broken])).toThrow(/heldSinceTimestamp/);
    expect(() => buildBalanceSnapshotTree([broken])).toThrow(/undefined/);
  });

  it('says why a missing timestamp cannot simply be defaulted', () => {
    const broken = { voterKey: VOTER_KEY, balance: 1_000n } as unknown as ReturnType<typeof entry>;
    // A zero would silently make the holder look like the oldest possible
    // holder, which is the opposite of what the holding-period rule is for.
    expect(() => buildBalanceSnapshotTree([broken])).toThrow(/must be excluded from the snapshot/);
  });

  it('names balance when it is missing', () => {
    const broken = { voterKey: VOTER_KEY, heldSinceTimestamp: 1n } as unknown as ReturnType<typeof entry>;
    expect(() => buildBalanceSnapshotTree([broken])).toThrow(/balance/);
  });

  it('names voterKey when it is not a Uint8Array', () => {
    const broken = entry({ voterKey: '11'.repeat(32) as unknown as Uint8Array });
    expect(() => buildBalanceSnapshotTree([broken])).toThrow(/voterKey/);
  });

  it('reports WHICH entry is broken, not just that one is', () => {
    // A snapshot can hold thousands of holders. "Something is undefined" is
    // the failure this replaced; the index is what makes it actionable.
    const broken = { voterKey: VOTER_KEY, balance: 1_000n } as unknown as ReturnType<typeof entry>;
    expect(() => buildBalanceSnapshotTree([entry(), entry(), broken])).toThrow(/entry 2/);
  });

  it('rejects a number where a bigint is required, rather than coercing it', () => {
    // 1000 and 1000n hash differently, so accepting one for the other would
    // publish a root no honest voter can produce a proof against.
    expect(() => buildBalanceSnapshotTree([entry({ balance: 1000 as unknown as bigint })])).toThrow(
      /non-bigint balance \(number\)/,
    );
  });
});
