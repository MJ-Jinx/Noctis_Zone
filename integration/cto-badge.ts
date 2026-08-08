// ============================================================================
// Noctis Protocol — CTO Governance: "Completed Successfully" Badge
// ============================================================================
// Determines whether a launch has earned the "CTO Completed Successfully"
// badge — decided criteria (2026-07-19): at least one FundAllocation /
// DexMigration / WhitelistUpdate proposal has PASSED AND EXECUTED at some
// point in this deployment's history. Sticky: once earned, stays earned even
// if ctoState later moves back to CTODissolved (a real, historical community
// achievement, not a live status that can be un-earned).
//
// DISCOVERY PROBLEM, SOLVED (2026-07-19): determining "has ANY qualifying
// proposal ever passed+executed" looked like it needed enumerating every
// proposal ID ever created — and cto_governance.compact's `proposals: Map<
// Bytes<32>, Proposal>` has NO in-circuit enumeration (mechanically
// confirmed against the real LFDT-Minokawa/compact compiler source:
// Map's `[Symbol.iterator]` is tagged `js-only`, meaning it has no VM
// opcode at all — enumeration is impossible from WITHIN a circuit, by
// construction, not just undocumented). The off-chain answer turns out to
// be much simpler than a transaction-history replay, though: a single
// `publicDataProvider.queryContractState(contractAddress)` call returns the
// contract's CURRENT state, and the compiled contract's own generated
// `ledger(state.data)` function decodes it into a real, TS-native object
// whose `proposals` field DOES implement `[Symbol.iterator]` (confirmed
// directly against contracts/midnight/compiled/cto_governance/contract/
// index.d.ts) — real Map iteration, just only callable from outside a
// circuit, which is exactly where this code runs. No history replay, no
// relayer dependency — one query, decode, iterate.
//
// Confirmed cto_governance.compact never calls proposals.remove() anywhere
// (every write is .insert(), including status updates re-inserted at the
// same key) — so the CURRENT state's Map already contains every proposal
// ever created for this deployment; there is nothing this approach misses.
//
// Split into a pure decision function (determineCtoCompletionStatus, takes
// an already-decoded ledger — trivially testable, no network/simulator
// needed) and a thin I/O wrapper (checkCtoCompletionStatus) that does the
// real query+decode and calls the pure function — same separation this
// codebase already uses elsewhere (e.g. widget/cto-session.ts's thin
// browser-API orchestration vs. cto-private-state-store.ts's tested logic).
// ============================================================================

import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import {
  CtoState,
  ledger,
  ProposalState,
  ProposalType,
} from '../contracts/midnight/compiled/cto_governance/contract/index.js';

// ContractAddress resolves to a plain `string` at the type level (confirmed
// directly against @midnight-ntwrk/onchain-runtime-v3's real declaration:
// `export type ContractAddress = string`) — used directly here rather than
// importing the alias itself, which midnight-js-types's public API surface
// doesn't re-export under that name (only consumes it internally).
type ContractAddress = string;

export type CtoCompletionStatus =
  | 'not_deployed'
  | 'not_triggered'
  | 'triggered_no_action_yet'
  | 'completed_successfully';

export interface CtoCompletionResult {
  status: CtoCompletionStatus;
  /** Current ctoState — informational; NOT what determines the badge (see file header on stickiness). null when not_deployed. */
  ctoState: 'PreCTO' | 'CTOTriggered' | 'CTODissolved' | null;
  /** Hex-encoded IDs of every proposal that satisfied the criteria — real evidence backing the badge, not a bare boolean. Empty unless status is 'completed_successfully'. */
  qualifyingProposalIds: string[];
}

const ACTION_PROPOSAL_TYPES = new Set<ProposalType>([
  ProposalType.FundAllocation,
  ProposalType.DexMigration,
  ProposalType.WhitelistUpdate,
]);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Minimal shape this needs from a decoded Ledger — matches the real compiled type's `ctoState`/`proposals` fields exactly, kept narrow so tests can construct fakes without touching real Midnight runtime types. */
export interface DecodedCtoLedger {
  ctoState: CtoState;
  proposals: Iterable<[Uint8Array, { proposalType: ProposalType; state: ProposalState }]>;
}

/** Pure decision logic — no I/O, trivially testable. */
export function determineCtoCompletionStatus(decoded: DecodedCtoLedger): CtoCompletionResult {
  const ctoStateName = CtoState[decoded.ctoState] as 'PreCTO' | 'CTOTriggered' | 'CTODissolved';

  const qualifyingProposalIds: string[] = [];
  for (const [proposalIdBytes, proposal] of decoded.proposals) {
    if (ACTION_PROPOSAL_TYPES.has(proposal.proposalType) && proposal.state === ProposalState.Executed) {
      qualifyingProposalIds.push(bytesToHex(proposalIdBytes));
    }
  }

  if (qualifyingProposalIds.length > 0) {
    return {
      status: 'completed_successfully',
      ctoState: ctoStateName,
      qualifyingProposalIds,
    };
  }
  if (decoded.ctoState === CtoState.PreCTO) {
    return {
      status: 'not_triggered',
      ctoState: ctoStateName,
      qualifyingProposalIds: [],
    };
  }
  return {
    status: 'triggered_no_action_yet',
    ctoState: ctoStateName,
    qualifyingProposalIds: [],
  };
}

/** Real I/O wrapper — queries the indexer's current contract state and decodes it via the compiled contract's own generated ledger() function. */
export async function checkCtoCompletionStatus(
  publicDataProvider: PublicDataProvider,
  contractAddress: ContractAddress,
): Promise<CtoCompletionResult> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) {
    return {
      status: 'not_deployed',
      ctoState: null,
      qualifyingProposalIds: [],
    };
  }
  const decoded = ledger(contractState.data);
  return determineCtoCompletionStatus(decoded);
}
