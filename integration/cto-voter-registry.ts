// ============================================================================
// Noctis Protocol — CTO Governance: Voter Registry Interface
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
  /** hex — deriveUserPublicKey(sk, DOMAINS.CTO_USER).bytes, as produced by cto-voter-registration.ts */
  ctoVoterPubKeyHex: string;
  /** Unix seconds this binding was verified and recorded. */
  registeredAt: number;
}

export interface CtoVoterRegistry {
  /** Records a verified binding — overwrites any prior binding for the same cardanoAddress (a wallet re-registering, e.g. after rotating its CIP-8 signature for any reason, always reflects its current identity). */
  record(binding: CtoVoterBinding): Promise<void>;
  /** Looks up the CTO voter pubkey for a specific Cardano address, or null if never registered. */
  lookup(cardanoAddress: string): Promise<CtoVoterBinding | null>;
  /** All bindings currently on record — what the balance-snapshot builder iterates to resolve holder addresses into Merkle leaf identities. */
  all(): Promise<CtoVoterBinding[]>;
}

/**
 * Real, working in-memory implementation — sufficient for local
 * composition/testing. A production deployment needs a real persistent
 * store implementing the same interface (out of this repo's scope).
 */
export function createInMemoryCtoVoterRegistry(): CtoVoterRegistry {
  const bindings = new Map<string, CtoVoterBinding>();

  return {
    async record(binding: CtoVoterBinding): Promise<void> {
      bindings.set(binding.cardanoAddress, binding);
    },
    async lookup(cardanoAddress: string): Promise<CtoVoterBinding | null> {
      return bindings.get(cardanoAddress) ?? null;
    },
    async all(): Promise<CtoVoterBinding[]> {
      return Array.from(bindings.values());
    },
  };
}
