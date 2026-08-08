import { describe, expect, it } from 'vitest';
import { determineSnapshotEntries, getSnapshotProof, type HolderFact } from '../cto-balance-snapshot-builder.js';

function fact(overrides: Partial<HolderFact> = {}): HolderFact {
  return {
    cardanoAddress: 'addr_test1_default',
    balance: 1000n,
    sybilFilterPassed: true,
    ctoVoterPubKeyHex: 'aa'.repeat(32),
    heldSinceTimestamp: 500n,
    ...overrides,
  };
}

describe('cto-balance-snapshot-builder.ts — determineSnapshotEntries (pure)', () => {
  it('includes a holder that passes the sybil filter and is registered', () => {
    const result = determineSnapshotEntries([fact()]);
    expect(result.entries).toHaveLength(1);
    expect(result.excludedSybilCount).toBe(0);
    expect(result.unregisteredCount).toBe(0);
  });

  it('excludes a zero-balance holder silently (not a sybil or unregistered count)', () => {
    const result = determineSnapshotEntries([fact({ balance: 0n })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedSybilCount).toBe(0);
    expect(result.unregisteredCount).toBe(0);
  });

  it('excludes a holder that fails the sybil filter, counted separately', () => {
    const result = determineSnapshotEntries([fact({ sybilFilterPassed: false })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedSybilCount).toBe(1);
    expect(result.unregisteredCount).toBe(0);
  });

  it('excludes a holder with no CTO voter registration, counted separately', () => {
    const result = determineSnapshotEntries([fact({ ctoVoterPubKeyHex: null })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedSybilCount).toBe(0);
    expect(result.unregisteredCount).toBe(1);
  });

  it('a sybil-filtered holder is counted as sybil, not unregistered, even if also unregistered', () => {
    const result = determineSnapshotEntries([fact({ sybilFilterPassed: false, ctoVoterPubKeyHex: null })]);
    expect(result.excludedSybilCount).toBe(1);
    expect(result.unregisteredCount).toBe(0);
  });

  it('excludes a holder whose first-acquisition timestamp could not be resolved, counted separately (anti-whale-takeover holding-period fix)', () => {
    const result = determineSnapshotEntries([fact({ heldSinceTimestamp: null })]);
    expect(result.entries).toHaveLength(0);
    expect(result.excludedSybilCount).toBe(0);
    expect(result.unregisteredCount).toBe(0);
    expect(result.unresolvedHeldSinceCount).toBe(1);
  });

  it('handles a realistic mixed batch correctly', () => {
    const facts: HolderFact[] = [
      fact({ cardanoAddress: 'addr_ok_1', ctoVoterPubKeyHex: '11'.repeat(32) }),
      fact({ cardanoAddress: 'addr_ok_2', ctoVoterPubKeyHex: '22'.repeat(32) }),
      fact({ cardanoAddress: 'addr_sybil', sybilFilterPassed: false }),
      fact({ cardanoAddress: 'addr_unregistered', ctoVoterPubKeyHex: null }),
      fact({ cardanoAddress: 'addr_zero', balance: 0n }),
    ];
    const result = determineSnapshotEntries(facts);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.cardanoAddress)).toEqual(['addr_ok_1', 'addr_ok_2']);
    expect(result.excludedSybilCount).toBe(1);
    expect(result.unregisteredCount).toBe(1);
  });

  it('preserves each entry real balance, voter key, and held-since timestamp unchanged', () => {
    const result = determineSnapshotEntries([
      fact({
        cardanoAddress: 'addr_x',
        balance: 123_456n,
        ctoVoterPubKeyHex: 'bb'.repeat(32),
        heldSinceTimestamp: 999_000n,
      }),
    ]);
    expect(result.entries[0]).toEqual({
      cardanoAddress: 'addr_x',
      voterKeyHex: 'bb'.repeat(32),
      balance: 123_456n,
      heldSinceTimestamp: 999_000n,
    });
  });
});

describe('cto-balance-snapshot-builder.ts — getSnapshotProof', () => {
  it('returns null for an address not in the entry list', () => {
    const { entries } = determineSnapshotEntries([fact({ cardanoAddress: 'addr_a' })]);
    expect(getSnapshotProof(entries, 'addr_not_present')).toBeNull();
  });

  it('returns a real 20-level proof for an address that IS in the entry list', () => {
    const { entries } = determineSnapshotEntries([
      fact({ cardanoAddress: 'addr_a', ctoVoterPubKeyHex: '11'.repeat(32) }),
      fact({ cardanoAddress: 'addr_b', ctoVoterPubKeyHex: '22'.repeat(32) }),
    ]);
    const result = getSnapshotProof(entries, 'addr_b');
    expect(result).not.toBeNull();
    expect(result!.leafIndex).toBe(1);
    expect(result!.proof).toHaveLength(20);
    expect(result!.balance).toBe(1000n);
  });
});
