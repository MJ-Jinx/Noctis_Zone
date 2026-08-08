import { describe, expect, it } from 'vitest';
import {
  CtoState,
  ProposalState,
  ProposalType,
} from '../../contracts/midnight/compiled/cto_governance/contract/index.js';
import { checkCtoCompletionStatus, type DecodedCtoLedger, determineCtoCompletionStatus } from '../cto-badge.js';

function fakeBytes(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function proposal(proposalType: ProposalType, state: ProposalState) {
  return { proposalType, state };
}

describe('cto-badge.ts — determineCtoCompletionStatus (pure decision logic)', () => {
  it('returns not_triggered when ctoState is PreCTO and no proposals exist', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.PreCTO,
      proposals: [],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('not_triggered');
    expect(result.ctoState).toBe('PreCTO');
    expect(result.qualifyingProposalIds).toEqual([]);
  });

  it('returns triggered_no_action_yet when CTOTriggered but no qualifying proposal has executed', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [[fakeBytes(1), proposal(ProposalType.SilenceLockTrigger, ProposalState.Executed)]],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('triggered_no_action_yet');
    expect(result.qualifyingProposalIds).toEqual([]);
  });

  it('SilenceLockTrigger and DissolveCTO executions do NOT count toward the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [
        [fakeBytes(1), proposal(ProposalType.SilenceLockTrigger, ProposalState.Executed)],
        [fakeBytes(2), proposal(ProposalType.DissolveCTO, ProposalState.Executed)],
      ],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('triggered_no_action_yet');
  });

  it('a PASSED (not yet Executed) FundAllocation does NOT count toward the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [[fakeBytes(1), proposal(ProposalType.FundAllocation, ProposalState.Passed)]],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('triggered_no_action_yet');
  });

  it('a FAILED FundAllocation does NOT count toward the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [[fakeBytes(1), proposal(ProposalType.FundAllocation, ProposalState.Failed)]],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('triggered_no_action_yet');
  });

  it('an EXECUTED FundAllocation proposal earns the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [
        [fakeBytes(1), proposal(ProposalType.SilenceLockTrigger, ProposalState.Executed)],
        [fakeBytes(2), proposal(ProposalType.FundAllocation, ProposalState.Executed)],
      ],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('completed_successfully');
    expect(result.qualifyingProposalIds).toHaveLength(1);
  });

  it('an EXECUTED DexMigration proposal earns the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [[fakeBytes(1), proposal(ProposalType.DexMigration, ProposalState.Executed)]],
    };
    expect(determineCtoCompletionStatus(decoded).status).toBe('completed_successfully');
  });

  it('an EXECUTED WhitelistUpdate proposal earns the badge', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [[fakeBytes(1), proposal(ProposalType.WhitelistUpdate, ProposalState.Executed)]],
    };
    expect(determineCtoCompletionStatus(decoded).status).toBe('completed_successfully');
  });

  it('collects every qualifying proposal ID, not just the first one found', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTOTriggered,
      proposals: [
        [fakeBytes(1), proposal(ProposalType.FundAllocation, ProposalState.Executed)],
        [fakeBytes(2), proposal(ProposalType.DexMigration, ProposalState.Executed)],
        [fakeBytes(3), proposal(ProposalType.SilenceLockTrigger, ProposalState.Executed)], // not counted
      ],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.qualifyingProposalIds).toHaveLength(2);
  });

  it('STICKY: the badge remains earned even after CTODissolved', () => {
    const decoded: DecodedCtoLedger = {
      ctoState: CtoState.CTODissolved,
      proposals: [
        [fakeBytes(1), proposal(ProposalType.FundAllocation, ProposalState.Executed)],
        [fakeBytes(2), proposal(ProposalType.DissolveCTO, ProposalState.Executed)],
      ],
    };
    const result = determineCtoCompletionStatus(decoded);
    expect(result.status).toBe('completed_successfully');
    expect(result.ctoState).toBe('CTODissolved');
  });
});

describe('cto-badge.ts — checkCtoCompletionStatus (I/O wrapper)', () => {
  it('returns not_deployed when queryContractState finds nothing', async () => {
    const fakeProvider = {
      queryContractState: async () => null,
    } as unknown as Parameters<typeof checkCtoCompletionStatus>[0];

    const result = await checkCtoCompletionStatus(fakeProvider, 'fake-address');
    expect(result.status).toBe('not_deployed');
    expect(result.ctoState).toBeNull();
    expect(result.qualifyingProposalIds).toEqual([]);
  });
});
