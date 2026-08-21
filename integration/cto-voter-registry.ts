// ============================================================================
// Noctis Zone — CTO Governance: Voter Registry Interface
// ============================================================================
// The final piece item #12 (balance-snapshot builder) needs: a queryable
// store of (cardanoAddress -> CTO voter pubkey) bindings, populated by
// cto-voter-registration.ts's verified registrations. Real persistence
// (a database table, WordPress postmeta, whatever the actual deployment
// uses) lives outside this repo's scope — same WordPress boundary drawn
// throughout this session (checkTreasuryHealth(), item #17's badge
// data model). What's here is the real, tested INTERFACE the balance-
// snapshot builder can code against today, plus a real in-memory
// implementation usable for local testing/CLI composition without needing
// a live database.
// ============================================================================

export interface CtoVoterBinding {
  cardanoAddress: string;
  /** The launch this binding is for. A voter's identity is scoped per launch,
   *  so one wallet holds a DIFFERENT binding for every launch it registers
   *  with — which is what keeps its ballots unlinkable across them. This is
   *  half of the key: a binding is identified by (cardanoAddress, launchIdHex),
   *  never by address alone. */
  launchIdHex: string;
  /** hex — deriveUserPublicKey(sk, DOMAINS.CTO_USER, launchId).bytes, as produced by cto-voter-registration.ts */
  ctoVoterPubKeyHex: string;
  /** Unix seconds this binding was verified and recorded. */
  registeredAt: number;
}

export interface CtoVoterRegistry {
  /** Records a verified binding — overwrites any prior binding for the same
   *  (cardanoAddress, launchIdHex) pair (a wallet re-registering for the same
   *  launch, e.g. after rotating its CIP-8 signature, always reflects its
   *  current identity). A registration for a DIFFERENT launch is a separate
   *  binding and never displaces this one. */
  record(binding: CtoVoterBinding): Promise<void>;
  /** Looks up one wallet's CTO voter pubkey for ONE launch, or null if that
   *  wallet never registered for it. Registering for another launch does not
   *  satisfy this lookup — the derived key would be a different one. */
  lookup(cardanoAddress: string, launchIdHex: string): Promise<CtoVoterBinding | null>;
  /** Every binding recorded for ONE launch — what that launch's
   *  balance-snapshot builder iterates to resolve holder addresses into
   *  Merkle leaf identities. Scoped by launch because a snapshot is built
   *  for a single ballot, and another launch's identities are not valid
   *  leaves in it. */
  all(launchIdHex: string): Promise<CtoVoterBinding[]>;
}

/**
 * Real, working in-memory implementation — sufficient for local
 * composition/testing. A production deployment needs a real persistent
 * store implementing the same interface (out of this repo's scope).
 */
export function createInMemoryCtoVoterRegistry(): CtoVoterRegistry {
  const bindings = new Map<string, CtoVoterBinding>();
  const keyOf = (cardanoAddress: string, launchIdHex: string) => `${launchIdHex}:${cardanoAddress}`;

  return {
    async record(binding: CtoVoterBinding): Promise<void> {
      bindings.set(keyOf(binding.cardanoAddress, binding.launchIdHex), binding);
    },
    async lookup(cardanoAddress: string, launchIdHex: string): Promise<CtoVoterBinding | null> {
      return bindings.get(keyOf(cardanoAddress, launchIdHex)) ?? null;
    },
    async all(launchIdHex: string): Promise<CtoVoterBinding[]> {
      return Array.from(bindings.values()).filter((b) => b.launchIdHex === launchIdHex);
    },
  };
}
