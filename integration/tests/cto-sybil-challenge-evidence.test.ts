import { describe, expect, it } from 'vitest';
import type { BlockfrostClient } from '../blockfrost-client.js';
import {
  evidenceSupportsChallenge,
  gatherSybilChallengeEvidence,
  hashEvidence,
  type SybilChallengeEvidence,
} from '../cto-sybil-challenge-evidence.js';
import { createInMemoryCtoVoterRegistry } from '../cto-voter-registry.js';

function evidence(overrides: Partial<SybilChallengeEvidence> = {}): SybilChallengeEvidence {
  return {
    accusedCardanoAddress: 'addr_test1_accused',
    challengedVoterKeyHex: 'aa'.repeat(32),
    challengedProposalIdHex: 'bb'.repeat(32),
    stakeKeyMatch: {
      eligible: true,
      registrantStakeAddress: 'stake1_a',
      creatorStakeAddress: 'stake1_b',
    },
    adaFlowMatch: { eligible: true, violatingTxHash: null },
    gatheredAt: 1_700_000_000,
    ...overrides,
  };
}

describe('cto-sybil-challenge-evidence.ts — evidenceSupportsChallenge (pure)', () => {
  it('returns false when both checks pass (no link found)', () => {
    expect(evidenceSupportsChallenge(evidence())).toBe(false);
  });

  it('returns true when the stake key check found a link', () => {
    expect(
      evidenceSupportsChallenge(
        evidence({
          stakeKeyMatch: {
            eligible: false,
            registrantStakeAddress: 'x',
            creatorStakeAddress: 'x',
          },
        }),
      ),
    ).toBe(true);
  });

  it('returns true when the ADA flow check found a link', () => {
    expect(
      evidenceSupportsChallenge(
        evidence({
          adaFlowMatch: { eligible: false, violatingTxHash: 'txhash123' },
        }),
      ),
    ).toBe(true);
  });

  it('returns true when both checks found a link', () => {
    expect(
      evidenceSupportsChallenge(
        evidence({
          stakeKeyMatch: {
            eligible: false,
            registrantStakeAddress: 'x',
            creatorStakeAddress: 'x',
          },
          adaFlowMatch: { eligible: false, violatingTxHash: 'txhash123' },
        }),
      ),
    ).toBe(true);
  });
});

describe('cto-sybil-challenge-evidence.ts — gatherSybilChallengeEvidence (I/O wrapper)', () => {
  it('returns null when the accused wallet never registered a CTO voter identity', async () => {
    const registry = createInMemoryCtoVoterRegistry();
    const fakeClient = {} as BlockfrostClient; // never reached — registry lookup fails first
    const result = await gatherSybilChallengeEvidence(fakeClient, registry, {
      accusedCardanoAddress: 'addr_test1_never_registered',
      creatorAddress: 'addr_test1_creator',
      challengedProposalIdHex: 'cc'.repeat(32),
    });
    expect(result).toBeNull();
  });
});

describe('cto-sybil-challenge-evidence.ts — hashEvidence', () => {
  it('is deterministic for the same evidence', () => {
    const e = evidence();
    expect(hashEvidence(e)).toEqual(hashEvidence({ ...e }));
  });

  it('produces a real 32-byte digest', () => {
    expect(hashEvidence(evidence())).toHaveLength(32);
  });

  it('changes when the accused address changes', () => {
    const a = hashEvidence(evidence());
    const b = hashEvidence(evidence({ accusedCardanoAddress: 'addr_test1_different' }));
    expect(a).not.toEqual(b);
  });

  it('changes when the stake key match result changes', () => {
    const a = hashEvidence(evidence());
    const b = hashEvidence(
      evidence({
        stakeKeyMatch: {
          eligible: false,
          registrantStakeAddress: 'x',
          creatorStakeAddress: 'x',
        },
      }),
    );
    expect(a).not.toEqual(b);
  });

  it('changes when the ADA flow match result changes', () => {
    const a = hashEvidence(evidence());
    const b = hashEvidence(
      evidence({
        adaFlowMatch: { eligible: false, violatingTxHash: 'txhash123' },
      }),
    );
    expect(a).not.toEqual(b);
  });

  it('changes when the challenged proposal id changes', () => {
    const a = hashEvidence(evidence());
    const b = hashEvidence(evidence({ challengedProposalIdHex: 'dd'.repeat(32) }));
    expect(a).not.toEqual(b);
  });
});
