/**
 * The state-enum unions below are hand-mirrored from each PSM's `.compact`
 * source, not generated — the compiled per-contract TypeScript output
 * (`contracts/midnight/compiled/*`) is gitignored and only exists after a
 * local `compact compile`, so it can't be imported here as a shared
 * dependency. If a PSM's enum changes, update the matching const array
 * below to keep it in sync.
 */

/** The three launch tiers. Choice is permanent once a launch goes live — see CLAUDE.md "Tier choice is permanent." */
export type LaunchTier = 'A' | 'B' | 'C';

/** Whether a tier includes a DarkVeil private phase (B and C only). */
export function tierHasDarkVeil(tier: LaunchTier): boolean {
  return tier === 'B' || tier === 'C';
}

/** DarkVeil PSM lifecycle — mirrors darkveil.compact's `DarkVeilState` enum. */
export const DARKVEIL_STATES = ['Inactive', 'Registration', 'Buying', 'Closed', 'Cancelled'] as const;
export type DarkVeilState = (typeof DARKVEIL_STATES)[number];

/** A single DarkVeil buy commitment's lifecycle — mirrors darkveil.compact's `CommitStatus` enum. */
export const COMMIT_STATUSES = ['Open', 'Revealed', 'Cancelled'] as const;
export type CommitStatus = (typeof COMMIT_STATUSES)[number];

/** Bonding Curve PSM lifecycle — mirrors bonding_curve.compact's `CurveState` enum. */
export const CURVE_STATES = ['Inactive', 'Active', 'Graduated', 'Cancelled'] as const;
export type CurveState = (typeof CURVE_STATES)[number];

/**
 * Eligibility Gate's own coarse-grained phase — mirrors
 * eligibility_gate.compact's `LaunchPhase` enum. Distinct from
 * {@link DarkVeilState}/{@link CurveState}: this is the gate's view, used to
 * route `registerForDarkVeil`/`checkAndUpdateCap` and kept in sync with the
 * other two PSMs by the integration layer, not shared ledger state.
 */
export const ELIGIBILITY_LAUNCH_PHASES = ['Pending', 'DarkVeil', 'Public', 'Graduated', 'Cancelled'] as const;
export type EligibilityLaunchPhase = (typeof ELIGIBILITY_LAUNCH_PHASES)[number];

/**
 * Creator TOKEN vesting lifecycle — mirrors vesting.compact's
 * `VestingState` enum. Distinct from {@link EscrowState}: see CLAUDE.md's
 * "Creator Fee Escrow — Important Distinction". Vesting releases a fixed
 * `tokenAllocation` set at deploy; the escrow accrues variable trade fees.
 */
export const VESTING_STATES = ['NotStarted', 'Vesting', 'FullyClaimed', 'CTOFrozen', 'Cancelled'] as const;
export type VestingState = (typeof VESTING_STATES)[number];

/** Creator Fee Escrow (bonding-curve trade fees) lifecycle — mirrors creator_escrow.compact's `EscrowState` enum. */
export const ESCROW_STATES = ['Active', 'Closed', 'FullyClaimed', 'CTORedirected', 'Cancelled'] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

/**
 * LP Escrow lifecycle — mirrors lp_escrow.compact's `LpState` enum. There
 * is deliberately no "Withdrawn" state — see CLAUDE.md's
 * "No withdraw() button for LP exists."
 */
export const LP_STATES = ['Locked', 'Migrated', 'Cancelled'] as const;
export type LpState = (typeof LP_STATES)[number];

/** CTO trigger status — mirrors cto_governance.compact's `CtoState` enum. */
export const CTO_STATES = ['PreCTO', 'CTOTriggered', 'CTODissolved'] as const;
export type CtoState = (typeof CTO_STATES)[number];

/** CTO ballot proposal kind — mirrors cto_governance.compact's `ProposalType` enum. */
export const PROPOSAL_TYPES = [
  'SilenceLockTrigger',
  'FundAllocation',
  'DexMigration',
  'WhitelistUpdate',
  'DissolveCTO',
] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

/** CTO ballot lifecycle — mirrors cto_governance.compact's `ProposalState` enum. */
export const PROPOSAL_STATES = ['Pending', 'Active', 'Passed', 'Failed', 'Executed'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
