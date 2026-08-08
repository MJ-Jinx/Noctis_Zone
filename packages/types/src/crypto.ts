/** A 32-byte value — the ubiquitous `Bytes<32>` type used throughout every Compact PSM. */
export type Bytes32 = Uint8Array;

/**
 * Witness-derived, domain-separated identity key (e.g. `UserPublicKey`,
 * `AdminPublicKey`). Never a raw wallet address — see CLAUDE.md's privacy
 * model: cumulative purchases are tracked by this derived key, not by any
 * value that maps back to a real-world address on its own.
 */
export interface DerivedPublicKey {
  bytes: Bytes32;
}

/**
 * A client-side-only secret backing a {@link DerivedPublicKey}. Must never
 * be serialized, logged, or sent to any backend — it only ever exists as a
 * witness value supplied to a circuit call.
 */
export interface DerivedSecretKey {
  bytes: Bytes32;
}

/** A 32-level Merkle inclusion proof, as used by eligibility_gate.compact's `getMerkleProof` witness. */
export type MerkleProof32 = readonly Bytes32[];
