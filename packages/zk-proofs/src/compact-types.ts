// ============================================================================
// Compact runtime type-descriptor helpers
// ============================================================================
//
// Every `persistentHash<T>(value)` call inside a `.compact` circuit compiles
// down to `__compactRuntime.persistentHash(descriptor, value)`, where
// `descriptor` is a hand-generated CompactType implementing
// `alignment()` / `fromValue()` / `toValue()` for T — see e.g.
// `contracts/midnight/compiled/darkveil/contract/index.js`'s
// `_BuyCommitInput_0`/`_NullifierInput_0`/`_CertHashInput_0` classes.
//
// Those descriptor classes are compiler-generated per-contract and are NOT
// exported from the compiled module (only `export circuit` functions reach
// the public `Circuits<PS>` type) — so they can't be imported directly.
// This file reproduces the same construction pattern using ONLY confirmed
// public exports from `@midnight-ntwrk/compact-runtime`
// (`persistentHash`, `CompactTypeBytes`, `CompactTypeVector`,
// `CompactTypeUnsignedInteger`), so that off-chain code can compute
// byte-identical hashes to what each PSM's `pure circuit` helpers compute
// on-chain. `tests/hash-parity.test.ts` proves this by calling a real
// compiled circuit and checking it accepts a value computed here.
//
// If you add a helper for a new struct, verify it the same way: find (or
// add) an `export circuit` that internally calls the corresponding
// `pure circuit`, feed it the witness inputs, and confirm it doesn't throw.
// ============================================================================

import {
  type CompactType,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';

/** `Bytes<32>` — used for every key, launch ID, commitment, and nullifier in these PSMs. */
export const bytes32Type: CompactType<Uint8Array> = new CompactTypeBytes(32);

/**
 * `Uint<bits>` — matches the compiler's own encoding exactly:
 * `CompactTypeUnsignedInteger(2^bits - 1, bits / 8)`, confirmed against
 * compiled output (`Uint<128>` → `CompactTypeUnsignedInteger(2n**128n - 1n, 16)`,
 * `Uint<64>` → `CompactTypeUnsignedInteger(2n**64n - 1n, 8)`).
 */
export function uintType(bits: 8 | 16 | 32 | 64 | 128): CompactType<bigint> {
  const maxValue = 2n ** BigInt(bits) - 1n;
  return new CompactTypeUnsignedInteger(maxValue, bits / 8);
}

/**
 * `pad(32, s)` — Compact's stdlib domain-separator helper. Confirmed from
 * compiled output: UTF-8 bytes of `s`, right-padded with zero bytes to a
 * fixed 32-byte length. Throws if `s` doesn't fit.
 */
export function pad32(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`pad32: "${s}" is ${encoded.length} bytes, exceeds 32`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
}

/**
 * Builds a `CompactType` for a struct, given its fields **in declaration
 * order** (Compact concatenates alignment/value bytes in the order fields
 * are declared in the `struct`, not necessarily the order used in a struct
 * literal at the call site — confirmed against compiled `_BuyCommitInput_0`
 * etc.). This generalizes the hand-rolled per-struct classes the compiler
 * emits into one reusable helper.
 */
export function structType<T extends object>(
  // biome-ignore lint/suspicious/noExplicitAny: each field's CompactType is for a different T[K] — deliberate erasure, still fully typed at every call site's array literal.
  fields: ReadonlyArray<readonly [keyof T & string, CompactType<any>]>,
): CompactType<T> {
  return {
    alignment() {
      return fields.map(([, type]) => type.alignment()).reduce((acc, a) => acc.concat(a));
    },
    fromValue(value) {
      const result = {} as T;
      for (const [name, type] of fields) {
        result[name] = type.fromValue(value);
      }
      return result;
    },
    toValue(value: T) {
      return fields.map(([name, type]) => type.toValue(value[name])).reduce((acc, v) => acc.concat(v));
    },
  };
}

/** A 2-element `Vector<2, Bytes<32>>` — the shape every ROLE key hashes (`[pad32(domain), secretBytes]`). */
export const domainKeyVectorType: CompactType<Uint8Array[]> = new CompactTypeVector(2, bytes32Type);

/**
 * Hashes `[pad32(domain), secretBytes]` — the pattern every PSM's
 * `deriveGovernorKey`/`deriveCreatorKey`/`deriveCommunityKey` uses.
 *
 * Do NOT fold a launch ID into this. Those roles are the same party across
 * every launch by definition, and the Merkle-leaf hashers in this package
 * depend on this exact two-element shape.
 */
export function hashDomainKey(domain: string, secretBytes: Uint8Array): Uint8Array {
  return persistentHash(domainKeyVectorType, [pad32(domain), secretBytes]);
}

/** A 3-element `Vector<3, Bytes<32>>` — the shape a launch-scoped USER key hashes. */
export const scopedKeyVectorType: CompactType<Uint8Array[]> = new CompactTypeVector(3, bytes32Type);

/**
 * Hashes `[pad32(domain), secretBytes, launchId]` — the exact pattern every
 * PSM's `deriveUserPublicKey` uses.
 *
 * The launch ID is what keeps one person's participation in two launches
 * unlinkable: the same secret derives a different key under each, so the
 * keys the two launches publish cannot be matched to each other.
 */
export function hashDomainKeyScoped(domain: string, secretBytes: Uint8Array, launchId: Uint8Array): Uint8Array {
  return persistentHash(scopedKeyVectorType, [pad32(domain), secretBytes, launchId]);
}

export { persistentHash };
